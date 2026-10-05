import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import migration from "../migrations/0016_income_source.sql?raw";
import { summarizeMonth } from "../src/budget";
import { loadMonth } from "../src/db/month";
import { resetDemo } from "../src/demo/reset";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";

const db = env.DB;
const MONTH = "2026-09";
const KEY = btoa("01234567890123456789012345678901");

const backfill = migration
	.split(";")
	.map((statement) => statement.trim())
	.find((statement) => statement.includes("UPDATE transactions"));

const spent = async () =>
	summarizeMonth({
		month: MONTH,
		...(await loadMonth(db, MONTH)),
		unpaidDueBillsCents: 0,
	}).totalSpentCents;

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
});

describe("migration 0016: preserve historic credit decisions", () => {
	it("keeps a person-categorized refund reducing Spent", async () => {
		await db
			.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, category_source, flag_income, credit_reviewed) SELECT 999, id, '2026-09-15', -500, 'HISTORIC REFUND', 1, 'user', 0, NULL FROM accounts LIMIT 1",
			)
			.run();
		const heldSpent = await spent();

		expect(backfill).toBeDefined();
		await db.prepare(backfill as string).run();

		expect(
			await db
				.prepare("SELECT credit_reviewed FROM transactions WHERE id = 999")
				.first(),
		).toEqual({ credit_reviewed: 1 });
		expect(await spent()).toBe(heldSpent - 500);
	});

	it("keeps a historic refund reviewed and counting after a changed-amount sync", async () => {
		const encrypted = await encryptToken("secret-access-token", KEY);
		const item = await db
			.prepare(
				"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Bank', 'person@example.com', 'historic-item') RETURNING id",
			)
			.bind(encrypted)
			.first<{ id: number }>();
		await db
			.prepare(
				"INSERT INTO accounts (id, plaid_item_id, plaid_account_id, name, type) VALUES (999, ?, 'historic-account', 'Checking', 'depository')",
			)
			.bind(item?.id)
			.run();
		await db
			.prepare(
				"INSERT INTO transactions (id, account_id, plaid_transaction_id, date, amount_cents, raw_name, category_id, category_source, flag_income, credit_reviewed) VALUES (999, 999, 'historic-refund', '2026-09-15', -500, 'HISTORIC REFUND', 1, 'user', 0, NULL)",
			)
			.run();

		expect(backfill).toBeDefined();
		await db.prepare(backfill as string).run();
		const beforeCorrection = await spent();
		const plaidFetch = vi.fn(async (url: RequestInfo | URL) => {
			if (String(url).endsWith("/accounts/get")) {
				return Response.json({
					accounts: [
						{
							account_id: "historic-account",
							name: "Checking",
							type: "depository",
							balances: { current: 100 },
						},
					],
				});
			}
			return Response.json({
				added: [],
				modified: [
					{
						transaction_id: "historic-refund",
						account_id: "historic-account",
						date: "2026-09-15",
						amount: -6,
						name: "HISTORIC REFUND",
						pending: false,
					},
				],
				removed: [],
				next_cursor: "cursor-1",
				has_more: false,
			});
		});

		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			item?.id as number,
			plaidFetch,
		);

		expect(
			await db
				.prepare(
					"SELECT amount_cents, credit_reviewed, credit_reviewed_by FROM transactions WHERE id = 999",
				)
				.first(),
		).toEqual({
			amount_cents: -600,
			credit_reviewed: 1,
			credit_reviewed_by: "user",
		});
		expect(await spent()).toBe(beforeCorrection - 100);
	});
});

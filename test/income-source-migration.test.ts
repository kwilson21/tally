import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0016_income_source.sql?raw";
import { summarizeMonth } from "../src/budget";
import { loadMonth } from "../src/db/month";
import { resetDemo } from "../src/demo/reset";

const db = env.DB;
const MONTH = "2026-09";

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
});

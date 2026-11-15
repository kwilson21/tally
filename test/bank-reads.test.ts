// Characterisation of the bank and account reads (#963, PR 2): the order and shape each read returns, pinned before they move
// to the query builder.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { accountChoices } from "../src/db/accounts";
import { resetDemo } from "../src/demo/reset";
import { readGateInputs } from "../src/first-tally/gate";
import { readYourBanks } from "../src/first-tally/your-banks";

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
});

describe("accountChoices order", () => {
	it("lists bank accounts by bank, then accounts with no bank, then Cash last", async () => {
		// A card with no bank, linked to no plaid item, with an id below every bank's account.
		await env.DB.prepare(
			"INSERT INTO accounts (id, name, type, subtype, mask, plaid_item_id) VALUES (60, 'Store card', 'credit', NULL, '0042', NULL)",
		).run();

		const labels = (await accountChoices(env.DB)).map((c) => c.label);

		expect(labels).toEqual([
			"Checking ••1234",
			"Savings ••5678",
			"Credit card ••9012",
			"Store card ••0042",
			"Cash",
		]);
	});
});

describe("readGateInputs banks", () => {
	it("reads each connected bank by id, with its sync marks, and leaves disconnected banks out", async () => {
		const expected = async () =>
			(
				await env.DB.prepare(
					"SELECT id, institution_name AS name, created_at AS linkedAt, last_synced_at AS lastSyncedAt, history_complete_at AS historyCompleteAt FROM plaid_items WHERE disconnected_at IS NULL ORDER BY id",
				).all()
			).results;

		const before = await readGateInputs(env.DB);
		expect(before.banks).toEqual(await expected());
		expect(before.banks.length).toBeGreaterThan(0);

		const [first] = before.banks;
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id = ?",
		)
			.bind(first?.id)
			.run();

		const after = await readGateInputs(env.DB);
		expect(after.banks.some((bank) => bank.id === first?.id)).toBe(false);
		expect(after.banks).toEqual(await expected());
	});
});

describe("readYourBanks with manual rows", () => {
	it("counts only the bank's synced rows, and lists a bank whose only rows are typed in, at 0", async () => {
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, access_token_encrypted, institution_name, linked_by) VALUES (903, X'', 'Typed Bank', 'test')",
		).run();
		await env.DB.prepare(
			"INSERT INTO accounts (id, plaid_item_id, name, type) VALUES (903, 903, 'Typed', 'depository')",
		).run();
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (903, '2026-10-01', 500, 'TYPED IN')",
		).run();

		const row = (await readYourBanks(env.DB)).find((bank) => bank.id === 903);

		expect(row).toMatchObject({ name: "Typed Bank", count: 0 });
	});
});

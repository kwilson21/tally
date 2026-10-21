import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type Stroke, STROKES, markStroke } from "../src/db/first-tally";
import { dailyJevCap } from "../src/sort-groups";

// The day's Jev cap (spec §8.6, decision 146): until the three questions are answered in production, each connected bank
// may ask Jev 2,000 a day, so a first week is not held to the usual 500. Afterwards, and for every other household, the
// usual cap (500 in production, 40 in the demo) applies.

const db = env.DB;
const PRODUCTION = { DEMO: "false" };
const DEMO = { DEMO: "true" };

/** A household with `banks` connected banks (and one disconnected) and the first_tally strokes drawn with a day. */
async function household(banks: number, strokes: readonly Stroke[]) {
	await db.batch([
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM accounts"),
		db.prepare("DELETE FROM plaid_items"),
		db.prepare("DELETE FROM household_settings WHERE key = 'first_tally'"),
	]);
	for (let i = 0; i < banks; i++) {
		await db
			.prepare(
				"INSERT INTO plaid_items (plaid_item_id, access_token_encrypted, institution_name, linked_by, last_synced_at, history_complete_at) VALUES (?, ?, 'Bank', 'person', '2026-10-13', '2026-10-13')",
			)
			.bind(`cap-${i}`, new Uint8Array(1))
			.run();
	}
	for (const stroke of strokes) await markStroke(db, stroke, "2026-10-13");
}

describe("dailyJevCap: the first week in production (decision 146)", () => {
	beforeEach(async () => {
		await household(0, []);
	});

	it("reserves 2,000 a connected bank while the questions are not all answered", async () => {
		await household(3, ["bank"]);
		expect(await dailyJevCap(db, PRODUCTION)).toBe(6000);
	});

	it("is still 2,000 a bank with only the pay question answered", async () => {
		await household(3, ["bank", "pay"]);
		expect(await dailyJevCap(db, PRODUCTION)).toBe(6000);
	});

	it("is back to the usual 500 once pay, bills and budgets are all drawn", async () => {
		await household(3, ["bank", "pay", "bills", "budgets"]);
		expect(await dailyJevCap(db, PRODUCTION)).toBe(500);
	});

	it("is 500 for a set-up household, whatever its banks", async () => {
		await household(3, STROKES);
		expect(await dailyJevCap(db, PRODUCTION)).toBe(500);
	});

	it("counts only connected banks", async () => {
		await household(2, ["bank"]);
		await db
			.prepare(
				"INSERT INTO plaid_items (plaid_item_id, access_token_encrypted, institution_name, linked_by, last_synced_at, history_complete_at, disconnected_at) VALUES ('cap-gone', ?, 'Bank', 'person', NULL, NULL, '2026-10-13')",
			)
			.bind(new Uint8Array(1))
			.run();
		expect(await dailyJevCap(db, PRODUCTION)).toBe(4000);
	});

	it("is the usual 500 with no bank linked, so an empty first week asks no more than before", async () => {
		await household(0, []);
		expect(await dailyJevCap(db, PRODUCTION)).toBe(500);
	});

	it("is the demo's 40 whatever the first week holds", async () => {
		await household(3, ["bank"]);
		expect(await dailyJevCap(db, DEMO)).toBe(40);
		expect(await dailyJevCap(db, {})).toBe(40);
	});
});

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { noneFitTransactions } from "../src/db/category-suggestions";
import {
	addNeverSuggest,
	neverSuggestRuleLine,
	neverSuggestRules,
	removeNeverSuggest,
} from "../src/db/never-suggest";
import { resetDemo } from "../src/demo/reset";

// "Never suggest" rules (spec §5, §7, §8.6, decision 101): one row per suggestion a person said Yes to
// stopping. Tally never makes that suggestion for that store again until the family removes the line.

const db = env.DB;

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.prepare("DELETE FROM never_suggest_rules").run();
	await db
		.prepare(
			"INSERT OR REPLACE INTO merchants (raw_name, display_name) VALUES ('VENMO', 'Venmo'), ('CHEWY', 'Chewy')",
		)
		.run();
});

describe("never_suggest_rules table", () => {
	it("holds only the three kinds of suggestion a Yes can write", async () => {
		for (const kind of ["name", "category", "bogus"]) {
			await expect(
				db
					.prepare(
						`INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES ('VENMO', '${kind}', '2026-10-03')`,
					)
					.run(),
			).rejects.toThrow();
		}
	});

	it("keeps one line per store and kind, so a repeat Yes adds nothing", async () => {
		const first = await addNeverSuggest(db, {
			merchantKey: "VENMO",
			kind: "income",
			decidedOn: "2026-10-03",
		});
		const again = await addNeverSuggest(db, {
			merchantKey: "VENMO",
			kind: "income",
			decidedOn: "2026-10-04",
		});
		expect(first).toBe(true);
		expect(again).toBe(false);
		const rules = await neverSuggestRules(db);
		expect(rules).toHaveLength(1);
		expect(rules[0]?.decidedOn).toBe("2026-10-03");
	});

	it("lists the newest line first, with the store's name and the day of the No", async () => {
		await addNeverSuggest(db, {
			merchantKey: "VENMO",
			kind: "income",
			decidedOn: "2026-10-03",
		});
		await addNeverSuggest(db, {
			merchantKey: "CHEWY",
			kind: "new_category",
			decidedOn: "2026-10-09",
		});
		const rules = await neverSuggestRules(db);
		expect(rules.map((rule) => rule.merchantKey)).toEqual(["CHEWY", "VENMO"]);
		const [chewy, venmo] = rules;
		expect(venmo && neverSuggestRuleLine(venmo)).toBe(
			"Never suggest income for Venmo",
		);
		expect(chewy && neverSuggestRuleLine(chewy)).toBe(
			"Never suggest a new category for Chewy",
		);
	});

	it("removes one line and returns it, and a stale Remove removes nothing", async () => {
		await addNeverSuggest(db, {
			merchantKey: "VENMO",
			kind: "transfer",
			decidedOn: "2026-10-03",
		});
		const [rule] = await neverSuggestRules(db);
		const removed = await removeNeverSuggest(db, rule?.id ?? 0);
		expect(removed?.kind).toBe("transfer");
		expect(await neverSuggestRules(db)).toEqual([]);
		expect(await removeNeverSuggest(db, rule?.id ?? 0)).toBeNull();
	});
});

describe("new-category grouping", () => {
	it("leaves a store with a new-category line out of the groups Tally would suggest", async () => {
		for (const raw of ["CHEWY.COM", "CHEWY.COM", "CHEWY.COM"]) {
			await db
				.prepare(
					`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, plaid_category,
						category_confidence, jev_none_fit, jev_category_id, pending)
					SELECT ?, id, '2026-10-03', 4500, ?, 'SHOPPING', 0.9, 1, NULL, 0 FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1`,
				)
				.bind(`plaid-${crypto.randomUUID()}`, raw)
				.run();
		}
		expect(await noneFitTransactions(db)).toHaveLength(3);
		await addNeverSuggest(db, {
			merchantKey: "CHEWY.COM",
			kind: "new_category",
			decidedOn: "2026-10-03",
		});
		expect(await noneFitTransactions(db)).toHaveLength(0);
	});
});

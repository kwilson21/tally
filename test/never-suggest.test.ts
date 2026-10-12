import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { noneFitTransactions } from "../src/db/category-suggestions";
import {
	addNeverSuggest,
	neverSuggestRuleLine,
	neverSuggestRules,
	removeNeverSuggest,
} from "../src/db/never-suggest";
import { getTransaction, listTransactions } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { parseFilters } from "../src/transactions/filters";

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
		expect(removed?.rule.kind).toBe("transfer");
		expect(removed?.removedCount).toBe(1);
		expect(await neverSuggestRules(db)).toEqual([]);
		expect(await removeNeverSuggest(db, rule?.id ?? 0)).toBeNull();
	});
});

describe("a Never suggest line hides the store's Maybe on the rows and the panel (decision 101)", () => {
	const insertTx = async (fields: {
		raw: string;
		merchant?: string;
		amount: number;
		incomeConfidence?: number;
		suggestionId?: number;
	}): Promise<number> => {
		const row = await db
			.prepare(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, merchant_name,
					income_confidence, category_suggestion_id)
				VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-03', ?, ?, ?, ?, ?) RETURNING id`,
			)
			.bind(
				`plaid-${crypto.randomUUID()}`,
				fields.amount,
				fields.raw,
				fields.merchant ?? null,
				fields.incomeConfidence ?? null,
				fields.suggestionId ?? null,
			)
			.first<{ id: number }>();
		return row?.id ?? 0;
	};
	const listed = async (id: number) =>
		(
			await listTransactions(
				db,
				parseFilters(new URLSearchParams("show=all"), "2026-10"),
				[id],
			)
		).rows[0];
	const rowHtml = async (id: number) => {
		const html = await (
			await exports.default.fetch(
				"http://tally.test/transactions?show=all&month=all&q=VENMO+123",
			)
		).text();
		const row = html.slice(html.indexOf(`data-transaction="${id}"`));
		return row.slice(0, row.indexOf("</li>"));
	};

	it("hides Maybe income on the list, the panel and the detail, and shows it again once the line is removed", async () => {
		const id = await insertTx({
			raw: "VENMO 123",
			merchant: "Venmo",
			amount: -2500,
			incomeConfidence: 0.6,
		});
		expect((await rowHtml(id)).includes("Maybe income")).toBe(true);
		await addNeverSuggest(db, {
			merchantKey: "Venmo",
			kind: "income",
			decidedOn: "2026-10-03",
		});
		expect((await listed(id))?.incomeConfidence).toBeNull();
		expect((await getTransaction(db, id))?.incomeConfidence).toBeNull();
		expect(await rowHtml(id)).not.toContain("Maybe income");
		const panel = await (
			await exports.default.fetch(`http://tally.test/transactions/${id}`)
		).text();
		expect(panel).not.toContain("Maybe income");
		const [rule] = await neverSuggestRules(db);
		await removeNeverSuggest(db, rule?.id ?? 0);
		expect((await listed(id))?.incomeConfidence).toBe(0.6);
		expect((await getTransaction(db, id))?.incomeConfidence).toBe(0.6);
		expect(await rowHtml(id)).toContain("Maybe income");
	});

	it("hides a Maybe new category chip for a store with a new-category line, and only that store's", async () => {
		const suggestion = await db
			.prepare(
				"INSERT INTO category_suggestions (name, status) VALUES ('Pet Care', 'pending') RETURNING id",
			)
			.first<{ id: number }>();
		const suggestionId = suggestion?.id ?? 0;
		const chewy = await insertTx({
			raw: "CHEWY.COM",
			merchant: "Chewy",
			amount: 4500,
			suggestionId,
		});
		const petco = await insertTx({
			raw: "PETCO 22",
			merchant: "Petco",
			amount: 2399,
			suggestionId,
		});
		await addNeverSuggest(db, {
			merchantKey: "Chewy",
			kind: "new_category",
			decidedOn: "2026-10-03",
		});
		const chewyRow = await getTransaction(db, chewy);
		expect(chewyRow?.maybeCategoryName).toBeNull();
		expect(chewyRow?.maybeCategoryNew).toBeFalsy();
		expect((await listed(chewy))?.maybeCategoryName).toBeNull();
		expect((await getTransaction(db, petco))?.maybeCategoryName).toBe(
			"new:Pet Care",
		);
		expect((await listed(petco))?.maybeCategoryName).toBe("new:Pet Care");
		const [rule] = await neverSuggestRules(db);
		await removeNeverSuggest(db, rule?.id ?? 0);
		expect((await getTransaction(db, chewy))?.maybeCategoryName).toBe(
			"new:Pet Care",
		);
	});
});

describe("Remove takes the store's linked lines away with the one clicked (decision 101)", () => {
	const lines = async () =>
		(await neverSuggestRules(db))
			.map((rule) => `${rule.merchantKey}:${rule.kind}`)
			.sort();

	beforeEach(async () => {
		await db
			.prepare(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, merchant_name)
				VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-03', -2500, 'VENMO 123', 'Venmo')`,
			)
			.bind(`plaid-${crypto.randomUUID()}`)
			.run();
		await addNeverSuggest(db, {
			merchantKey: "VENMO 123",
			kind: "income",
			decidedOn: "2026-10-03",
		});
		await addNeverSuggest(db, {
			merchantKey: "Venmo",
			kind: "income",
			decidedOn: "2026-10-03",
		});
		await addNeverSuggest(db, {
			merchantKey: "Venmo",
			kind: "transfer",
			decidedOn: "2026-10-03",
		});
		await addNeverSuggest(db, {
			merchantKey: "CHEWY",
			kind: "income",
			decidedOn: "2026-10-03",
		});
	});

	it("removing the bank-text line also removes the store-name line of the same kind, and nothing else", async () => {
		const bank = (await neverSuggestRules(db)).find(
			(rule) => rule.merchantKey === "VENMO 123",
		);
		const removed = await removeNeverSuggest(db, bank?.id ?? 0);
		expect(removed?.rule.kind).toBe("income");
		expect(removed?.removedCount).toBe(2);
		expect(await lines()).toEqual(["CHEWY:income", "Venmo:transfer"]);
	});

	it("removing the store-name line also removes the bank-text line of the same kind", async () => {
		const name = (await neverSuggestRules(db)).find(
			(rule) => rule.merchantKey === "Venmo" && rule.kind === "income",
		);
		await removeNeverSuggest(db, name?.id ?? 0);
		expect(await lines()).toEqual(["CHEWY:income", "Venmo:transfer"]);
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

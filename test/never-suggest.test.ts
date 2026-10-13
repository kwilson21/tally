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

/** The fields a Remove form posts for a line: its id, store and kind. */
const lineKey = (
	line?: { id: number; merchantKey: string; kind: string } | null,
) => ({
	id: line?.id ?? 0,
	merchantKey: line?.merchantKey ?? "",
	kind: line?.kind ?? "",
});

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
		const removed = await removeNeverSuggest(db, lineKey(rule));
		expect(removed?.rule.kind).toBe("transfer");
		expect(removed?.removedCount).toBe(1);
		expect(await neverSuggestRules(db)).toEqual([]);
		expect(await removeNeverSuggest(db, lineKey(rule))).toBeNull();
	});

	it("a stale Remove whose id now names another store's line removes nothing, and keeps the new line", async () => {
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
		const [chewy] = await neverSuggestRules(db);
		expect(chewy?.merchantKey).toBe("CHEWY");
		await removeNeverSuggest(db, lineKey(chewy));
		await addNeverSuggest(db, {
			merchantKey: "PETCO",
			kind: "transfer",
			decidedOn: "2026-10-10",
		});
		const [petco] = await neverSuggestRules(db);
		expect(petco?.merchantKey).toBe("PETCO");
		// The clicked Remove still names Chewy's old line, so it finds nothing even if SQLite reused its id.
		expect(await removeNeverSuggest(db, lineKey(chewy))).toBeNull();
		expect(
			(await neverSuggestRules(db)).map((rule) => rule.merchantKey),
		).toEqual(["PETCO", "VENMO"]);
		expect(petco?.id).not.toBe(chewy?.id);
	});

	it("a live id posted with another kind or another store deletes nothing", async () => {
		await addNeverSuggest(db, {
			merchantKey: "VENMO",
			kind: "income",
			decidedOn: "2026-10-03",
		});
		const [rule] = await neverSuggestRules(db);
		expect(
			await removeNeverSuggest(db, { ...lineKey(rule), kind: "transfer" }),
		).toBeNull();
		expect(
			await removeNeverSuggest(db, { ...lineKey(rule), merchantKey: "CHEWY" }),
		).toBeNull();
		expect(await neverSuggestRules(db)).toEqual([rule]);
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
		await removeNeverSuggest(db, lineKey(rule));
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
		await removeNeverSuggest(db, lineKey(rule));
		expect((await getTransaction(db, chewy))?.maybeCategoryName).toBe(
			"new:Pet Care",
		);
	});
});

describe("Remove takes the store's linked lines away with the one clicked (decision 101)", () => {
	// What is stored, not what Settings shows: a hidden bank-text line still counts here.
	const lines = async () =>
		(
			await db
				.prepare(
					"SELECT merchant_key AS merchantKey, kind FROM never_suggest_rules",
				)
				.all<{ merchantKey: string; kind: string }>()
		).results
			.map((row) => `${row.merchantKey}:${row.kind}`)
			.sort();

	// The lines are planted as they are stored, so these tests check Remove alone: a Yes now writes the other
	// keys of its store too (see the next describe), which would change the state these tests set up.
	const plant = (merchantKey: string, kind: string) =>
		db
			.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES (?, ?, '2026-10-03')",
			)
			.bind(merchantKey, kind)
			.run();

	beforeEach(async () => {
		await db
			.prepare(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, merchant_name)
				VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-03', -2500, 'VENMO 123', 'Venmo')`,
			)
			.bind(`plaid-${crypto.randomUUID()}`)
			.run();
		await plant("VENMO 123", "income");
		await plant("Venmo", "income");
		await plant("Venmo", "transfer");
		await plant("CHEWY", "income");
	});

	it("lists a bank-text line copied to the store's name once, as the store's name", async () => {
		expect(
			(await neverSuggestRules(db))
				.map((rule) => `${rule.merchantKey}:${rule.kind}`)
				.sort(),
		).toEqual(["CHEWY:income", "Venmo:income", "Venmo:transfer"]);
	});

	it("still lists a bank-text line with no store-name line of its kind", async () => {
		await plant("VENMO 123", "new_category");
		expect(
			(await neverSuggestRules(db)).map(
				(rule) => `${rule.merchantKey}:${rule.kind}`,
			),
		).toContain("VENMO 123:new_category");
	});

	it("removing the bank-text line also removes the store-name line of the same kind, and nothing else", async () => {
		const bank = await db
			.prepare(
				"SELECT id, merchant_key AS merchantKey, kind FROM never_suggest_rules WHERE merchant_key='VENMO 123' AND kind='income'",
			)
			.first<{ id: number; merchantKey: string; kind: string }>();
		const removed = await removeNeverSuggest(db, lineKey(bank));
		expect(removed?.rule.kind).toBe("income");
		expect(removed?.removedCount).toBe(2);
		expect(await lines()).toEqual(["CHEWY:income", "Venmo:transfer"]);
	});

	it("removing the store-name line also removes the bank-text line of the same kind", async () => {
		const name = (await neverSuggestRules(db)).find(
			(rule) => rule.merchantKey === "Venmo" && rule.kind === "income",
		);
		await removeNeverSuggest(db, lineKey(name));
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

describe("a Yes writes a line for every key the store goes by (decision 101, #459)", () => {
	const insertCharge = async (fields: {
		raw: string;
		merchant?: string;
		date?: string;
		incomeConfidence?: number;
	}): Promise<number> => {
		const row = await db
			.prepare(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, merchant_name,
					income_confidence)
				VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), ?, -2500, ?, ?, ?) RETURNING id`,
			)
			.bind(
				`plaid-${crypto.randomUUID()}`,
				fields.date ?? "2026-10-03",
				fields.raw,
				fields.merchant ?? null,
				fields.incomeConfidence ?? 0.5,
			)
			.first<{ id: number }>();
		return row?.id ?? 0;
	};
	/** What is stored under each key, not what Settings shows, as "key:kind" in order. */
	const stored = async () =>
		(
			await db
				.prepare(
					"SELECT merchant_key AS merchantKey, kind FROM never_suggest_rules",
				)
				.all<{ merchantKey: string; kind: string }>()
		).results
			.map((row) => `${row.merchantKey}:${row.kind}`)
			.sort();
	/** The Settings list's lines, as store names. */
	const listed = async () =>
		(await neverSuggestRules(db)).map((rule) => rule.merchantKey);

	it("a Yes on the store's name also writes its bank text, so the bank text's older charges are covered", async () => {
		const named = await insertCharge({ raw: "VENMO 123", merchant: "Venmo" });
		const older = await insertCharge({
			raw: "VENMO 123",
			date: "2025-12-01",
		});
		const chewy = await insertCharge({ raw: "CHEWY 9", merchant: "Chewy" });
		expect(
			await addNeverSuggest(db, {
				merchantKey: "Venmo",
				kind: "income",
				decidedOn: "2026-10-03",
			}),
		).toBe(true);
		expect(await stored()).toEqual(["VENMO 123:income", "Venmo:income"]);
		expect(await listed()).toEqual(["Venmo"]);
		expect((await getTransaction(db, named))?.incomeConfidence).toBeNull();
		expect((await getTransaction(db, older))?.incomeConfidence).toBeNull();
		expect((await getTransaction(db, chewy))?.incomeConfidence).toBe(0.5);
		const [line] = await neverSuggestRules(db);
		const removed = await removeNeverSuggest(db, lineKey(line));
		expect(removed?.removedCount).toBe(2);
		expect(await stored()).toEqual([]);
	});

	it("a Yes on the bank text also writes the store's name, and one Remove of the store's line takes both", async () => {
		await insertCharge({ raw: "VENMO 123", merchant: "Venmo" });
		await insertCharge({ raw: "VENMO 123", date: "2025-12-01" });
		expect(
			await addNeverSuggest(db, {
				merchantKey: "VENMO 123",
				kind: "income",
				decidedOn: "2026-10-03",
			}),
		).toBe(true);
		expect(await stored()).toEqual(["VENMO 123:income", "Venmo:income"]);
		expect(await listed()).toEqual(["Venmo"]);
		const [line] = await neverSuggestRules(db);
		expect(line?.merchantKey).toBe("Venmo");
		const removed = await removeNeverSuggest(db, lineKey(line));
		expect(removed?.removedCount).toBe(2);
		expect(await stored()).toEqual([]);
	});

	it("a Remove of the bank-text row, which Settings hides, takes both lines too", async () => {
		await insertCharge({ raw: "VENMO 123", merchant: "Venmo" });
		await insertCharge({ raw: "VENMO 123", date: "2025-12-01" });
		await addNeverSuggest(db, {
			merchantKey: "Venmo",
			kind: "income",
			decidedOn: "2026-10-03",
		});
		const bank = await db
			.prepare(
				"SELECT id, merchant_key AS merchantKey, kind FROM never_suggest_rules WHERE merchant_key = 'VENMO 123'",
			)
			.first<{ id: number; merchantKey: string; kind: string }>();
		const removed = await removeNeverSuggest(db, lineKey(bank));
		expect(removed?.removedCount).toBe(2);
		expect(await stored()).toEqual([]);
	});

	it("a repeat Yes through either key adds nothing and keeps the first day on every line", async () => {
		await insertCharge({ raw: "VENMO 123", merchant: "Venmo" });
		await insertCharge({ raw: "VENMO 123", date: "2025-12-01" });
		await addNeverSuggest(db, {
			merchantKey: "Venmo",
			kind: "income",
			decidedOn: "2026-10-03",
		});
		expect(
			await addNeverSuggest(db, {
				merchantKey: "VENMO 123",
				kind: "income",
				decidedOn: "2026-10-04",
			}),
		).toBe(false);
		const days = await db
			.prepare(
				"SELECT DISTINCT decided_on AS decidedOn FROM never_suggest_rules",
			)
			.all<{ decidedOn: string }>();
		expect(days.results).toEqual([{ decidedOn: "2026-10-03" }]);
		expect(await stored()).toEqual(["VENMO 123:income", "Venmo:income"]);
	});

	it("a Yes writes nothing for another store", async () => {
		await insertCharge({ raw: "VENMO 123", merchant: "Venmo" });
		await insertCharge({ raw: "CHEWY 9", merchant: "Chewy" });
		await addNeverSuggest(db, {
			merchantKey: "Venmo",
			kind: "transfer",
			decidedOn: "2026-10-03",
		});
		expect(await stored()).toEqual(["VENMO 123:transfer", "Venmo:transfer"]);
		expect(await listed()).toEqual(["Venmo"]);
	});
});

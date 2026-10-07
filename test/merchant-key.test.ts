import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { loadBillSuggestions } from "../src/bills/find";
import { matchBillPayments } from "../src/bills/match";
import { insertBill, updateBill } from "../src/bills/write";
import { merchantKeySql } from "../src/db/merchant-key";
import {
	applyMerchantRules,
	getTransaction,
	listTransactions,
	pendingForJev,
	refundPurchases,
	saveEdit,
	saveSplit,
} from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { transactionsCsv } from "../src/settings/export";
import { parseFilters } from "../src/transactions/filters";
import {
	organizeGroups,
	saveOrganizeGroup,
} from "../src/transactions/organize";
import { tidyName } from "../src/transactions/tidy-name";

// A transaction's merchant key is Plaid's merchant_name when there is one, otherwise its raw_name
// (spec §6.1 rule 1, decision 67), so "TARGET 1234" and "TARGET 5678" are one merchant.

const db = env.DB;
const BASE = "http://tally.test";
const TODAY = "2026-09-22";
const GROCERIES = 1;
const GAS = 3;
const KIDS = 4;

type Tx = {
	id: number;
	date: string;
	cents: number;
	raw: string;
	merchant?: string | null;
	account?: number;
	categoryId?: number | null;
};

/** Inserts transactions on the demo's checking account, as sync (merchant) or a person (no merchant) would. */
const insert = (...rows: Tx[]) =>
	db.batch(
		rows.map((t) =>
			db
				.prepare(
					"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.bind(
					t.id,
					t.account ?? 1,
					t.date,
					t.cents,
					t.raw,
					t.merchant ?? null,
					t.categoryId ?? null,
					t.categoryId ? "user" : null,
				),
		),
	);

const row = (id: number) =>
	db
		.prepare(
			"SELECT category_id, category_source, merchant_name, raw_name FROM transactions WHERE id = ?",
		)
		.bind(id)
		.first<Record<string, unknown>>();

const edit = (over: Partial<Parameters<typeof saveEdit>[2]> = {}) => ({
	categoryId: null,
	alwaysForMerchant: false,
	displayName: null,
	note: null,
	excluded: false,
	income: false,
	creditReviewed: true,
	...over,
});

// The demo's categories and accounts, but none of its transactions, bills or merchants, so these tests
// don't depend on what the seed holds (it has a Target of its own).
beforeEach(async () => {
	await resetDemo(db, TODAY);
	await db.batch([
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM bills"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM merchants"),
	]);
});

describe("merchantKeySql", () => {
	it.each([
		["new check sets and applies rule", false, true, 1, 4, 4, 4],
		["checked category change is transaction-only", true, true, 1, 3, 1, 1],
		["explicit uncheck clears rule", true, false, 1, null, null, 1],
		["unchecked note save keeps rule", false, false, 1, null, 1, 1],
		["paused checked rule keeps category and rule", true, true, 1, null, 1, 1],
	] as const)(
		"saveEdit: %s",
		async (_name, was, now, ruleWas, categoryId, expectedRule, expectedSibling) => {
			await insert(
				{
					id: 8801,
					date: "2026-09-01",
					cents: 100,
					raw: "RULE EDIT",
					merchant: "RULE EDIT",
					categoryId: 1,
				},
				{
					id: 8802,
					date: "2026-09-02",
					cents: 100,
					raw: "RULE EDIT",
					merchant: "RULE EDIT",
					categoryId: 1,
				},
			);
			await db.batch([
				db.prepare(
					"UPDATE transactions SET category_source = 'merchant_rule' WHERE id IN (8801, 8802)",
				),
				db.prepare(
					"INSERT INTO merchants (raw_name, default_category_id) VALUES ('RULE EDIT', 1)",
				),
			]);
			await saveEdit(
				db,
				8801,
				edit({
					categoryId,
					alwaysForMerchant: now,
					alwaysWas: was,
					merchantRuleWas: ruleWas,
					note: "saved",
				}),
				"me",
			);
			expect(
				(
					await db
						.prepare(
							"SELECT default_category_id FROM merchants WHERE raw_name='RULE EDIT'",
						)
						.first<{ default_category_id: number | null }>()
				)?.default_category_id,
			).toBe(expectedRule);
			expect(await row(8802)).toMatchObject({ category_id: expectedSibling });
			expect(
				await db
					.prepare("SELECT category_id FROM transactions WHERE id=8801")
					.first(),
			).toEqual({ category_id: categoryId ?? 1 });
		},
	);

	it("is the merchant name when there is one, otherwise the raw name", async () => {
		await insert(
			{
				id: 8001,
				date: "2026-09-01",
				cents: 100,
				raw: "TARGET 1234",
				merchant: "Target",
			},
			{ id: 8002, date: "2026-09-01", cents: 100, raw: "FARMERS STAND" },
		);
		await db
			.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, merchant_name) VALUES (8003, 1, '2026-09-01', 100, 'BLANK NAME', '')",
			)
			.run();

		const { results } = await db
			.prepare(
				`SELECT t.id, ${merchantKeySql("t")} AS merchantKey FROM transactions t WHERE t.id IN (8001, 8002, 8003) ORDER BY t.id`,
			)
			.all();

		expect(results).toEqual([
			{ id: 8001, merchantKey: "Target" },
			{ id: 8002, merchantKey: "FARMERS STAND" },
			{ id: 8003, merchantKey: "BLANK NAME" },
		]);
	});
});

describe("merchant rules", () => {
	beforeEach(async () => {
		await insert(
			{
				id: 8001,
				date: "2026-09-01",
				cents: 1000,
				raw: "TARGET 1234",
				merchant: "Target",
			},
			{
				id: 8002,
				date: "2026-09-02",
				cents: 2000,
				raw: "TARGET 5678",
				merchant: "Target",
			},
			{
				id: 8003,
				date: "2026-09-03",
				cents: 3000,
				raw: "TARGET OPTICAL 9",
				merchant: "Target Optical",
			},
			{ id: 8004, date: "2026-09-04", cents: 4000, raw: "FARMERS STAND" },
		);
	});

	it("one rule covers every raw name that shares a merchant name", async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, default_category_id) VALUES ('Target', ?)",
			)
			.bind(GROCERIES)
			.run();

		await applyMerchantRules(db);

		expect(await row(8001)).toMatchObject({
			category_id: GROCERIES,
			category_source: "merchant_rule",
		});
		expect(await row(8002)).toMatchObject({
			category_id: GROCERIES,
			category_source: "merchant_rule",
		});
		// A different merchant name is a different merchant, however alike the raw text.
		expect(await row(8003)).toMatchObject({
			category_id: null,
			category_source: null,
		});
	});

	it("a transaction with no merchant name still follows a rule on its raw name", async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, default_category_id) VALUES ('FARMERS STAND', ?)",
			)
			.bind(GAS)
			.run();

		await applyMerchantRules(db);

		expect(await row(8004)).toMatchObject({
			category_id: GAS,
			category_source: "merchant_rule",
		});
	});

	it("'Always use this category' saves the rule under the merchant name and applies it to the other raw names", async () => {
		await saveEdit(
			db,
			8001,
			edit({ categoryId: KIDS, alwaysForMerchant: true }),
			"me@example.com",
		);

		expect(
			await db
				.prepare(
					"SELECT raw_name, default_category_id FROM merchants WHERE raw_name IN ('Target', 'TARGET 1234', 'TARGET 5678')",
				)
				.all(),
		).toMatchObject({
			results: [{ raw_name: "Target", default_category_id: KIDS }],
		});
		expect(await row(8001)).toMatchObject({
			category_id: KIDS,
			category_source: "user",
		});
		expect(await row(8002)).toMatchObject({
			category_id: KIDS,
			category_source: "merchant_rule",
		});
		expect(await row(8003)).toMatchObject({ category_id: null });
	});

	it("renaming a merchant renames every raw name that shares its merchant name", async () => {
		await saveEdit(
			db,
			8001,
			edit({ displayName: "Target Stores" }),
			"me@example.com",
		);

		expect((await getTransaction(db, 8001))?.displayName).toBe("Target Stores");
		expect((await getTransaction(db, 8002))?.displayName).toBe("Target Stores");
		expect((await getTransaction(db, 8003))?.displayName).not.toBe(
			"Target Stores",
		);
	});

	it("Organize groups raw names that share a merchant name and makes one rule for them", async () => {
		const group = (await organizeGroups(db)).find((g) =>
			g.merchantKeys.includes("Target"),
		);
		expect(group).toMatchObject({
			name: "Target",
			count: 2,
			totalCents: 3000,
			merchantKeys: ["Target"],
		});

		await saveOrganizeGroup(
			db,
			group?.merchantKeys ?? [],
			GROCERIES,
			null,
			"me@example.com",
		);

		expect(await row(8001)).toMatchObject({
			category_id: GROCERIES,
			category_source: "user",
		});
		expect(await row(8002)).toMatchObject({
			category_id: GROCERIES,
			category_source: "user",
		});
		expect(await row(8003)).toMatchObject({ category_id: null });
		expect(
			await db
				.prepare(
					"SELECT raw_name, default_category_id FROM merchants WHERE raw_name IN ('Target', 'TARGET 1234', 'TARGET 5678')",
				)
				.all(),
		).toMatchObject({
			results: [{ raw_name: "Target", default_category_id: GROCERIES }],
		});
	});

	it("a split part keeps its purchase's merchant name", async () => {
		await saveSplit(
			db,
			8001,
			[
				{ amountCents: 600, categoryId: GROCERIES },
				{ amountCents: 400, categoryId: KIDS },
			],
			"me@example.com",
		);

		const { results } = await db
			.prepare(
				"SELECT raw_name, merchant_name FROM transactions WHERE parent_id = 8001",
			)
			.all();
		expect(results).toEqual([
			{ raw_name: "TARGET 1234", merchant_name: "Target" },
			{ raw_name: "TARGET 1234", merchant_name: "Target" },
		]);
	});
});

describe("bill matching", () => {
	const bill = (id: number, key: string, due: number, cents = 5000) =>
		db
			.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, category_id, merchant_raw_name) VALUES (?, ?, ?, ?, 'monthly', 5, ?)",
			)
			.bind(id, `Bill ${id}`, cents, due, key)
			.run();
	const paid = async (id: number) =>
		(
			await db
				.prepare(
					"SELECT period, transaction_id FROM bill_payments WHERE bill_id = ? AND status = 'linked' ORDER BY period",
				)
				.bind(id)
				.all()
		).results;

	it("pays one bill from raw names that share a merchant name", async () => {
		await insert(
			{
				id: 8101,
				date: "2026-08-10",
				cents: 5000,
				raw: "TARGET 1234",
				merchant: "Target",
			},
			{
				id: 8102,
				date: "2026-09-10",
				cents: 5100,
				raw: "TARGET 5678",
				merchant: "Target",
			},
		);
		await bill(8001, "Target", 10);

		await matchBillPayments(db, TODAY);

		expect(await paid(8001)).toEqual([
			{ period: "2026-08", transaction_id: 8101 },
			{ period: "2026-09", transaction_id: 8102 },
		]);
	});

	it("matches a hand-entered cash payment on its raw name", async () => {
		await insert({
			id: 8103,
			date: "2026-09-10",
			cents: 5000,
			raw: "LANDLORD CASH",
			account: 4,
		});
		await bill(8002, "LANDLORD CASH", 10);

		await matchBillPayments(db, TODAY);

		expect(await paid(8002)).toEqual([
			{ period: "2026-09", transaction_id: 8103 },
		]);
	});

	it("does not match another merchant, whatever its bank text", async () => {
		await insert({
			id: 8104,
			date: "2026-09-10",
			cents: 7700,
			raw: "TARGET 1234",
			merchant: "Target Optical",
		});
		await bill(8003, "Target", 10, 7700);

		await matchBillPayments(db, TODAY);

		expect(await paid(8003)).toEqual([]);
	});

	it("lists payments from the same merchant first when linking by hand", async () => {
		await insert(
			// Closer in amount and date, but another merchant.
			{ id: 8201, date: "2026-09-10", cents: 5000, raw: "ZZ OTHER SHOP" },
			{
				id: 8202,
				date: "2026-09-12",
				cents: 9000,
				raw: "TARGET 5678",
				merchant: "Target",
			},
			{
				id: 8203,
				date: "2026-09-10",
				cents: 5000,
				raw: "TARGET 1234",
				merchant: "Target Optical",
			},
		);
		await bill(8004, "Target", 10);

		const res = await exports.default.fetch(
			`${BASE}/bills/8004/occurrences/2026-09/link`,
		);
		const html = await res.text();
		const picker = html.slice(html.indexOf('<section id="payment-picker"'));
		const at = (id: number) =>
			picker.indexOf(`name="transaction_id" value="${id}"`);

		expect(at(8202)).toBeGreaterThan(-1);
		expect(at(8202)).toBeLessThan(at(8201));
		expect(at(8202)).toBeLessThan(at(8203));
	});

	it("lists a cash payment first when its raw name is the bill's key", async () => {
		await insert(
			{ id: 8211, date: "2026-09-10", cents: 5000, raw: "ZZ OTHER SHOP" },
			{
				id: 8212,
				date: "2026-09-12",
				cents: 9000,
				raw: "LANDLORD CASH",
				account: 4,
			},
		);
		await bill(8005, "LANDLORD CASH", 10);

		const html = await (
			await exports.default.fetch(`${BASE}/bills/8005/occurrences/2026-09/link`)
		).text();
		const picker = html.slice(html.indexOf('<section id="payment-picker"'));

		expect(picker.indexOf('value="8212"')).toBeLessThan(
			picker.indexOf('value="8211"'),
		);
	});
});

describe("refunds", () => {
	it("lists purchases from every raw name that shares the refund's merchant name", async () => {
		await insert(
			{
				id: 8301,
				date: "2026-09-15",
				cents: -1000,
				raw: "TARGET 5678",
				merchant: "Target",
			},
			{
				id: 8302,
				date: "2026-09-01",
				cents: 4000,
				raw: "TARGET 1234",
				merchant: "Target",
			},
			{
				id: 8303,
				date: "2026-09-02",
				cents: 3000,
				raw: "TARGET OPTICAL 9",
				merchant: "Target Optical",
			},
			{
				id: 8304,
				date: "2026-09-03",
				cents: 2000,
				raw: "WALMART 42",
				merchant: "Walmart",
			},
		);
		const refund = await getTransaction(db, 8301);

		const offered = await refundPurchases(
			db,
			refund as NonNullable<typeof refund>,
		);

		expect(offered.map((p) => p.id)).toEqual([8302]);
	});

	it("matches a cash refund on its raw name", async () => {
		await insert(
			{
				id: 8311,
				date: "2026-09-15",
				cents: -500,
				raw: "FARMERS STAND",
				account: 4,
			},
			{
				id: 8312,
				date: "2026-09-01",
				cents: 2000,
				raw: "FARMERS STAND",
				account: 4,
			},
			{
				id: 8313,
				date: "2026-09-02",
				cents: 2000,
				raw: "OTHER STAND",
				account: 4,
			},
		);
		const refund = await getTransaction(db, 8311);

		const offered = await refundPurchases(
			db,
			refund as NonNullable<typeof refund>,
		);

		expect(offered.map((p) => p.id)).toEqual([8312]);
	});
});

describe("finding bills", () => {
	const targetCharges = () =>
		insert(
			{
				id: 8401,
				date: "2026-08-05",
				cents: 2500,
				raw: "TARGET 1234",
				merchant: "Target",
			},
			{
				id: 8402,
				date: "2026-09-05",
				cents: 2500,
				raw: "TARGET 5678",
				merchant: "Target",
			},
		);
	const found = async (pattern: RegExp) =>
		(await loadBillSuggestions(db, TODAY)).filter((s) =>
			pattern.test(s.rawName),
		);

	it("finds one bill from repeat charges under different raw names", async () => {
		await targetCharges();

		expect(await found(/target/i)).toMatchObject([
			{ rawName: "Target", chargeCount: 2, amountCents: 2500, dueDay: 5 },
		]);
	});

	it("finds a bill from a hand-entered cash charge on its raw name", async () => {
		await insert(
			{
				id: 8411,
				date: "2026-08-05",
				cents: 3000,
				raw: "GYM CASH",
				account: 4,
			},
			{
				id: 8412,
				date: "2026-09-05",
				cents: 3000,
				raw: "GYM CASH",
				account: 4,
			},
		);

		expect(await found(/gym cash/i)).toMatchObject([
			{ rawName: "GYM CASH", chargeCount: 2 },
		]);
	});

	it("stops suggesting a merchant once a bill has its key", async () => {
		await targetCharges();
		await db
			.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, category_id, merchant_raw_name) VALUES (8010, 'Target', 2500, 5, 'monthly', 5, 'Target')",
			)
			.run();

		expect(await found(/target/i)).toEqual([]);
	});

	it("remembers Not a bill for the merchant, not for one raw name", async () => {
		await targetCharges();

		const res = await exports.default.fetch(
			`${BASE}/bills/find/${encodeURIComponent("Target")}/dismiss`,
			{
				method: "POST",
				headers: {
					Origin: BASE,
					"HX-Request": "true",
					"content-type": "application/x-www-form-urlencoded",
				},
			},
		);

		expect(res.status).toBe(200);
		expect(
			await db
				.prepare("SELECT not_a_bill FROM merchants WHERE raw_name = 'Target'")
				.first(),
		).toEqual({ not_a_bill: 1 });
		expect(await found(/target/i)).toEqual([]);
	});
});

// One key space (spec §6.1): a charge reads only the merchants row whose raw_name is its key, so every bank
// text that shares a key shares one row. An old row saved under a bank text becomes its merchant's key row
// when Plaid first names the merchant, as a copy made by sync (test/plaid-sync.test.ts).
describe("one merchants row per key, whatever the bank text", () => {
	const merchantRows = async () =>
		(
			await db
				.prepare(
					"SELECT raw_name, display_name, default_category_id AS category, not_a_bill FROM merchants ORDER BY raw_name",
				)
				.all()
		).results;

	beforeEach(async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO merchants (raw_name, display_name, default_category_id) VALUES ('Comcast', 'Comcast Cable', 5)",
			),
		]);
		await insert(
			// Two bank texts, one merchant.
			{
				id: 8601,
				date: "2026-09-10",
				cents: 8000,
				raw: "COMCAST CABLE",
				merchant: "Comcast",
			},
			{
				id: 8602,
				date: "2026-08-10",
				cents: 8000,
				raw: "COMCAST CABLE 2",
				merchant: "Comcast",
			},
		);
	});

	it("applies one rule and shows one name for every bank text that shares the key", async () => {
		expect(
			(await pendingForJev(db, 500)).find((t) => t.id === 8602)?.displayName,
		).toBe("Comcast Cable");
		await applyMerchantRules(db);

		for (const id of [8601, 8602]) {
			expect(await row(id)).toMatchObject({
				category_id: 5,
				category_source: "merchant_rule",
			});
			expect((await getTransaction(db, id))?.displayName).toBe("Comcast Cable");
		}
		const { rows } = await listTransactions(
			db,
			parseFilters(
				new URLSearchParams("month=all&q=comcast cable"),
				TODAY.slice(0, 7),
			),
		);
		expect(rows.map((r) => r.id).sort()).toEqual([8601, 8602]);
		expect(await transactionsCsv(db)).toMatch(/COMCAST CABLE 2,Comcast Cable,/);
	});

	it("reads nothing from a row saved under a bank text once Plaid has named the merchant", async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name, default_category_id) VALUES ('COMCAST CABLE', 'Old name', 3)",
			)
			.run();
		await db.prepare("DELETE FROM merchants WHERE raw_name = 'Comcast'").run();

		await applyMerchantRules(db);

		expect(await row(8601)).toMatchObject({
			category_id: null,
			category_source: null,
		});
		expect((await getTransaction(db, 8601))?.displayName).toBe(
			tidyName("COMCAST CABLE"),
		);
	});

	it("keeps the key's name, rule and Not a bill when a person saves through either bank text", async () => {
		await db
			.prepare("UPDATE merchants SET not_a_bill = 1 WHERE raw_name = 'Comcast'")
			.run();

		await saveEdit(db, 8601, edit({ displayName: "Comcast Internet" }), "me");

		expect(await merchantRows()).toEqual([
			{
				raw_name: "Comcast",
				display_name: "Comcast Internet",
				category: 5,
				not_a_bill: 1,
			},
		]);
		// Every charge with the key follows, through either bank text.
		expect((await getTransaction(db, 8602))?.displayName).toBe(
			"Comcast Internet",
		);

		await saveEdit(db, 8602, edit({ displayName: "Comcast Two" }), "me");
		expect((await getTransaction(db, 8601))?.displayName).toBe("Comcast Two");
		expect(await merchantRows()).toMatchObject([
			{ display_name: "Comcast Two", category: 5, not_a_bill: 1 },
		]);
	});

	it.each([8601, 8602])(
		"recategorizes the charges of every bank text when an always rule is saved through charge %i",
		async (through) => {
			await applyMerchantRules(db);
			const other = through === 8601 ? 8602 : 8601;
			await insert({
				id: 8603,
				date: "2026-07-10",
				cents: 100,
				raw: "COMCAST CABLE 3",
				merchant: "Comcast",
				categoryId: KIDS,
			});

			await saveEdit(
				db,
				through,
				edit({ categoryId: GAS, alwaysForMerchant: true }),
				"me",
			);

			expect(await row(through)).toMatchObject({
				category_id: GAS,
				category_source: "user",
			});
			expect(await row(other)).toMatchObject({
				category_id: GAS,
				category_source: "merchant_rule",
			});
			// A person's own choice stays.
			expect(await row(8603)).toMatchObject({
				category_id: KIDS,
				category_source: "user",
			});
			expect(await merchantRows()).toMatchObject([{ category: GAS }]);
		},
	);

	it("shows one Organize group for the key, with every bank text on its line, and saves one row", async () => {
		const groups = (await organizeGroups(db)).filter((g) =>
			g.merchantKeys.includes("Comcast"),
		);

		expect(groups).toEqual([
			{
				name: "Comcast Cable",
				count: 2,
				totalCents: 16000,
				merchantKeys: ["Comcast"],
				bankTexts: ["COMCAST CABLE", "COMCAST CABLE 2"],
			},
		]);

		await saveOrganizeGroup(db, ["Comcast"], GAS, "Comcast Two", "me");

		expect(await row(8601)).toMatchObject({ category_id: GAS });
		expect(await row(8602)).toMatchObject({ category_id: GAS });
		expect(await merchantRows()).toEqual([
			{
				raw_name: "Comcast",
				display_name: "Comcast Two",
				category: GAS,
				not_a_bill: 0,
			},
		]);
	});

	it("marks the key as Not a bill for the charges of every bank text", async () => {
		const res = await exports.default.fetch(
			`${BASE}/bills/find/${encodeURIComponent("Comcast")}/dismiss`,
			{
				method: "POST",
				headers: {
					Origin: BASE,
					"HX-Request": "true",
					"content-type": "application/x-www-form-urlencoded",
				},
			},
		);

		expect(res.status).toBe(200);
		expect(await merchantRows()).toMatchObject([
			{ raw_name: "Comcast", not_a_bill: 1 },
		]);
		expect(await loadBillSuggestions(db, TODAY)).toEqual([]);
	});
});

describe("bills saved under the bank's raw text", () => {
	/** A bill saved under `text`: a legacy one was saved under the bank's raw text, before Phase 3.5. */
	const bill = (
		id: number,
		text: string,
		due = 10,
		cents = 5000,
		legacy = false,
	) =>
		db
			.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, category_id, merchant_raw_name, merchant_raw_text) VALUES (?, ?, ?, ?, 'monthly', 5, ?, ?)",
			)
			.bind(id, `Bill ${id}`, cents, due, text, legacy ? 1 : 0)
			.run();
	const paid = async (id: number) =>
		(
			await db
				.prepare(
					"SELECT transaction_id FROM bill_payments WHERE bill_id = ? AND status = 'linked' ORDER BY period",
				)
				.bind(id)
				.all()
		).results;

	it("keeps paying from the bank text, with or without Plaid's name, and links by hand", async () => {
		await insert(
			{
				id: 8701,
				date: "2026-09-10",
				cents: 8000,
				raw: "COMCAST CABLE",
				merchant: "Comcast",
			},
			{ id: 8702, date: "2026-08-10", cents: 8000, raw: "COMCAST CABLE" },
			{ id: 8703, date: "2026-09-10", cents: 8000, raw: "ZZ OTHER SHOP" },
		);
		await bill(8701, "COMCAST CABLE", 10, 8000, true);

		await matchBillPayments(db, TODAY);
		expect(await paid(8701)).toEqual([
			{ transaction_id: 8702 },
			{ transaction_id: 8701 },
		]);

		await db.prepare("DELETE FROM bill_payments").run();
		const html = await (
			await exports.default.fetch(`${BASE}/bills/8701/occurrences/2026-09/link`)
		).text();
		const picker = html.slice(html.indexOf('<section id="payment-picker"'));
		expect(picker.indexOf('value="8701"')).toBeGreaterThan(-1);
		expect(picker.indexOf('value="8701"')).toBeLessThan(
			picker.indexOf('value="8703"'),
		);
	});

	it("is not claimed by an unrelated charge whose merchant name equals the old bank text", async () => {
		await insert(
			// Closer to the due date than the real payment, so a wrong match would win.
			{
				id: 8711,
				date: "2026-09-10",
				cents: 8000,
				raw: "XYZ PAYMENTS",
				merchant: "COMCAST CABLE",
			},
			{
				id: 8712,
				date: "2026-09-12",
				cents: 8000,
				raw: "COMCAST CABLE",
				merchant: "Comcast",
			},
		);
		await bill(8702, "COMCAST CABLE", 10, 8000, true);

		await matchBillPayments(db, TODAY);

		expect(await paid(8702)).toEqual([{ transaction_id: 8712 }]);
		const html = await (
			await exports.default.fetch(`${BASE}/bills/8702/occurrences/2026-09/link`)
		).text();
		const picker = html.slice(html.indexOf('<section id="payment-picker"'));
		expect(picker.indexOf('value="8712"')).toBeLessThan(
			picker.indexOf('value="8711"'),
		);
	});

	it("does not let a bill saved under a key claim another merchant's charge, even with the same bank text", async () => {
		await insert({
			id: 8721,
			date: "2026-09-10",
			cents: 5000,
			raw: "Target",
			merchant: "Target Optical",
		});
		// Saved after Phase 3.5, so "Target" is a key, not bank text.
		await bill(8703, "Target");

		await matchBillPayments(db, TODAY);

		expect(await paid(8703)).toEqual([]);
	});

	it("keeps a legacy bill on the bank text it was saved under, whatever Plaid now calls the charge", async () => {
		await insert({
			id: 8731,
			date: "2026-09-10",
			cents: 5000,
			raw: "Target",
			merchant: "Target Optical",
		});
		await bill(8704, "Target", 10, 5000, true);

		await matchBillPayments(db, TODAY);

		expect(await paid(8704)).toEqual([{ transaction_id: 8731 }]);
	});

	it("does not hide charges from finding bills for another merchant that shares its bank text", async () => {
		await insert(
			{
				id: 8741,
				date: "2026-08-05",
				cents: 2500,
				raw: "TARGET 1234",
				merchant: "Target",
			},
			{
				id: 8742,
				date: "2026-08-06",
				cents: 3500,
				raw: "Target",
				merchant: "Target Optical",
			},
			{
				id: 8743,
				date: "2026-09-05",
				cents: 3500,
				raw: "Target",
				merchant: "Target Optical",
			},
		);
		await bill(8705, "Target");

		const found = (await loadBillSuggestions(db, TODAY)).map((s) => s.rawName);

		expect(found).toEqual(["Target Optical"]);
	});

	it("does not suggest a bill the bank text already has, or a merchant marked Not a bill under its key", async () => {
		await insert(
			{
				id: 8751,
				date: "2026-09-10",
				cents: 8000,
				raw: "COMCAST CABLE",
				merchant: "Comcast",
			},
			{
				id: 8752,
				date: "2026-08-11",
				cents: 8000,
				raw: "COMCAST CABLE",
				merchant: "Comcast",
			},
		);
		const found = async () =>
			(await loadBillSuggestions(db, TODAY)).filter((s) =>
				/comcast/i.test(s.rawName),
			);
		expect(await found()).toMatchObject([{ rawName: "Comcast" }]);

		await db
			.prepare(
				"INSERT INTO merchants (raw_name, not_a_bill) VALUES ('Comcast', 1)",
			)
			.run();
		expect(await found()).toEqual([]);

		await db.prepare("DELETE FROM merchants").run();
		await bill(8706, "COMCAST CABLE", 10, 8000, true);
		expect(await found()).toEqual([]);
	});

	it("saves a bill's text as a key, and keeps a legacy flag only while the text is unchanged", async () => {
		const fields = {
			name: "Internet",
			amountCents: 8000,
			dueDay: 10,
			frequency: "monthly" as const,
			anchorMonth: null,
			categoryId: 5,
			merchantRawName: "COMCAST CABLE",
		};
		const flagOf = async (id: number) =>
			await db
				.prepare(
					"SELECT merchant_raw_name AS text, merchant_raw_text AS flag FROM bills WHERE id = ?",
				)
				.bind(id)
				.first();
		await insertBill(db, fields);
		const id = (
			await db.prepare("SELECT id FROM bills WHERE name = 'Internet'").first<{
				id: number;
			}>()
		)?.id as number;
		expect(await flagOf(id)).toEqual({ text: "COMCAST CABLE", flag: 0 });

		// A bill from before Phase 3.5 keeps its flag while its text stays.
		await db
			.prepare("UPDATE bills SET merchant_raw_text = 1 WHERE id = ?")
			.bind(id)
			.run();
		await updateBill(db, id, { ...fields, amountCents: 9000 }, false);
		expect(await flagOf(id)).toEqual({ text: "COMCAST CABLE", flag: 1 });

		// A new text is a new write: a key.
		await updateBill(db, id, { ...fields, merchantRawName: "Comcast" }, false);
		expect(await flagOf(id)).toEqual({ text: "Comcast", flag: 0 });
	});
});

describe("refunds across bank texts", () => {
	it("does not offer a purchase from another merchant for a refund, though the bank text is the same", async () => {
		await insert(
			{
				id: 8771,
				date: "2026-09-15",
				cents: -1000,
				raw: "TARGET 5678",
				merchant: "Target",
			},
			{
				id: 8772,
				date: "2026-09-03",
				cents: 2000,
				raw: "TARGET 5678",
				merchant: "Walmart",
			},
			// A purchase from before Plaid's merchant name was stored has only its bank text.
			{ id: 8773, date: "2026-09-02", cents: 2000, raw: "TARGET 5678" },
		);
		const refund = await getTransaction(db, 8771);

		const offered = await refundPurchases(
			db,
			refund as NonNullable<typeof refund>,
		);

		expect(offered.map((p) => p.id)).toEqual([8773]);
	});

	it("offers a refund that has no merchant name the purchases that share its bank text", async () => {
		await insert(
			{ id: 8781, date: "2026-09-15", cents: -1000, raw: "TARGET 5678" },
			{
				id: 8782,
				date: "2026-09-03",
				cents: 2000,
				raw: "TARGET 5678",
				merchant: "Walmart",
			},
		);
		const refund = await getTransaction(db, 8781);

		const offered = await refundPurchases(
			db,
			refund as NonNullable<typeof refund>,
		);

		expect(offered.map((p) => p.id)).toEqual([8782]);
	});
});

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

// Production's rules, names and bills were saved under the bank's raw text, before Plaid's merchant name
// was stored. Once sync stores it, a new transaction's key is that name, yet those rows must keep working:
// a transaction is also the same merchant as a row saved under its own raw name. A row under its key wins.
describe("rows saved under the bank's raw text", () => {
	const NEW_COMCAST = {
		id: 8601,
		date: "2026-09-10",
		cents: 8000,
		raw: "COMCAST CABLE",
		merchant: "Comcast",
	};
	const OLD_COMCAST = {
		id: 8602,
		date: "2026-08-10",
		cents: 8000,
		raw: "COMCAST CABLE",
	};
	const HOUSEHOLD = 5;

	beforeEach(async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name, default_category_id, raw_text) VALUES ('COMCAST CABLE', 'Comcast Cable', ?, 1)",
			)
			.bind(HOUSEHOLD)
			.run();
		await insert(OLD_COMCAST, NEW_COMCAST);
	});

	it("applies a rule saved under the raw name to a transaction that now has a merchant name", async () => {
		await applyMerchantRules(db);

		expect(await row(8601)).toMatchObject({
			category_id: HOUSEHOLD,
			category_source: "merchant_rule",
		});
		expect(await row(8602)).toMatchObject({
			category_id: HOUSEHOLD,
			category_source: "merchant_rule",
		});
	});

	it("shows a name saved under the raw name everywhere the merchant name is shown", async () => {
		expect((await getTransaction(db, 8601))?.displayName).toBe("Comcast Cable");
		const { rows } = await listTransactions(
			db,
			parseFilters(
				new URLSearchParams("month=all&q=comcast"),
				TODAY.slice(0, 7),
			),
		);
		expect(rows.map((r) => [r.id, r.displayName])).toEqual([
			[8601, "Comcast Cable"],
			[8602, "Comcast Cable"],
		]);
		expect(
			(await pendingForJev(db, 500)).find((t) => t.id === 8601)?.displayName,
		).toBe("Comcast Cable");
		expect(await transactionsCsv(db)).toMatch(/COMCAST CABLE,Comcast Cable,/);
		const group = (await organizeGroups(db)).find((g) =>
			g.merchantKeys.includes("Comcast"),
		);
		expect(group).toMatchObject({ name: "Comcast Cable", count: 2 });
		expect([...(group?.merchantKeys ?? [])].sort()).toEqual([
			"COMCAST CABLE",
			"Comcast",
		]);
	});

	it("searches by a name saved under the raw name", async () => {
		await db
			.prepare(
				"UPDATE merchants SET display_name = 'The Cable Guy' WHERE raw_name = 'COMCAST CABLE'",
			)
			.run();

		const { rows } = await listTransactions(
			db,
			parseFilters(
				new URLSearchParams("month=all&q=cable guy"),
				TODAY.slice(0, 7),
			),
		);

		expect(rows.map((r) => r.id).sort()).toEqual([8601, 8602]);
	});

	it("matches a bill saved under the raw name, automatically and when linking by hand", async () => {
		await db
			.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, category_id, merchant_raw_name, merchant_raw_text) VALUES (8601, 'Internet', 8000, 10, 'monthly', 5, 'COMCAST CABLE', 1)",
			)
			.run();
		await insert({
			id: 8603,
			date: "2026-09-10",
			cents: 8000,
			raw: "ZZ OTHER SHOP",
		});

		await matchBillPayments(db, TODAY);

		expect(
			(
				await db
					.prepare(
						"SELECT period, transaction_id FROM bill_payments WHERE bill_id = 8601 AND status = 'linked' ORDER BY period",
					)
					.all()
			).results,
		).toEqual([
			{ period: "2026-08", transaction_id: 8602 },
			{ period: "2026-09", transaction_id: 8601 },
		]);

		await db.prepare("DELETE FROM bill_payments").run();
		await db
			.prepare(
				"UPDATE transactions SET date = '2026-09-12', amount_cents = 9000 WHERE id = 8601",
			)
			.run();
		const html = await (
			await exports.default.fetch(`${BASE}/bills/8601/occurrences/2026-09/link`)
		).text();
		const picker = html.slice(html.indexOf('<section id="payment-picker"'));
		expect(picker.indexOf('value="8601"')).toBeGreaterThan(-1);
		expect(picker.indexOf('value="8601"')).toBeLessThan(
			picker.indexOf('value="8603"'),
		);
	});

	it("lists purchases from the same bank text for a refund that now has a merchant name", async () => {
		await insert({
			id: 8604,
			date: "2026-09-20",
			cents: -500,
			raw: "COMCAST CABLE",
			merchant: "Comcast",
		});
		const refund = await getTransaction(db, 8604);

		const offered = await refundPurchases(
			db,
			refund as NonNullable<typeof refund>,
		);

		// The old purchase has no merchant name (key "COMCAST CABLE"), but the same bank text.
		expect(offered.map((p) => p.id)).toEqual([8601, 8602]);
	});

	it("does not suggest a bill the raw name already has, or a merchant marked Not a bill under it", async () => {
		await insert({
			id: 8605,
			date: "2026-08-11",
			cents: 8000,
			raw: "COMCAST CABLE",
			merchant: "Comcast",
		});
		const found = async () =>
			(await loadBillSuggestions(db, TODAY)).filter((s) =>
				/comcast/i.test(s.rawName),
			);
		expect(await found()).toMatchObject([{ rawName: "Comcast" }]);

		await db
			.prepare(
				"UPDATE merchants SET not_a_bill = 1 WHERE raw_name = 'COMCAST CABLE'",
			)
			.run();
		expect(await found()).toEqual([]);

		await db.prepare("UPDATE merchants SET not_a_bill = 0").run();
		await db
			.prepare(
				"INSERT INTO bills (name, amount_cents, due_day, frequency, category_id, merchant_raw_name, merchant_raw_text) VALUES ('Internet', 8000, 10, 'monthly', 5, 'COMCAST CABLE', 1)",
			)
			.run();
		expect(await found()).toEqual([]);
	});

	it("lets a rule and a name saved under the merchant name win over the raw name's", async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name, default_category_id) VALUES ('Comcast', 'Comcast Internet', ?)",
			)
			.bind(GAS)
			.run();

		await applyMerchantRules(db);

		expect(await row(8601)).toMatchObject({
			category_id: GAS,
			category_source: "merchant_rule",
		});
		// The older transaction has no merchant name, so its key is the raw name and the old rule is its own.
		expect(await row(8602)).toMatchObject({
			category_id: HOUSEHOLD,
			category_source: "merchant_rule",
		});
		expect((await getTransaction(db, 8601))?.displayName).toBe(
			"Comcast Internet",
		);
		expect((await getTransaction(db, 8602))?.displayName).toBe("Comcast Cable");
	});

	it("falls back to the raw name's name when the merchant name's row has only a rule", async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, default_category_id) VALUES ('Comcast', ?)",
			)
			.bind(GAS)
			.run();

		await applyMerchantRules(db);

		expect(await row(8601)).toMatchObject({ category_id: GAS });
		expect((await getTransaction(db, 8601))?.displayName).toBe("Comcast Cable");
	});

	it("writes new rules and names under the merchant name, leaving the old row alone", async () => {
		await saveEdit(
			db,
			8601,
			edit({
				categoryId: GAS,
				alwaysForMerchant: true,
				displayName: "Comcast Internet",
			}),
			"me@example.com",
		);

		expect(
			(
				await db
					.prepare(
						"SELECT raw_name, display_name, default_category_id FROM merchants ORDER BY raw_name",
					)
					.all()
			).results,
		).toEqual([
			{
				raw_name: "COMCAST CABLE",
				display_name: "Comcast Cable",
				default_category_id: HOUSEHOLD,
			},
			{
				raw_name: "Comcast",
				display_name: "Comcast Internet",
				default_category_id: GAS,
			},
		]);
	});

	it("ignores another merchant's rule that merely shares a word", async () => {
		await insert({
			id: 8606,
			date: "2026-09-11",
			cents: 100,
			raw: "COMCAST OTHER",
			merchant: "Xfinity Mobile",
		});

		await applyMerchantRules(db);

		expect(await row(8606)).toMatchObject({
			category_id: null,
			category_source: null,
		});
	});
});

// The raw-name fallback exists only so rows saved before Plaid's merchant name was stored keep working.
// It never overrides two known, different merchants: a raw text that is some transaction's merchant name
// is that merchant's key, not a legacy raw text, and a transaction that has a merchant name is never
// "the same merchant" as another merchant's by raw text alone.
describe("the raw-name fallback never overrides two known merchants", () => {
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

	it("shows two charges with one key and different old names as one Organize group, saved once", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO merchants (raw_name, display_name, raw_text) VALUES ('COMCAST CABLE', 'Comcast Cable', 1), ('COMCAST CABLE 2', 'Comcast Two', 1)",
			),
		]);
		await insert(
			{
				id: 8701,
				date: "2026-09-01",
				cents: 1000,
				raw: "COMCAST CABLE",
				merchant: "Comcast",
			},
			{
				id: 8702,
				date: "2026-09-02",
				cents: 2000,
				raw: "COMCAST CABLE",
				merchant: "Comcast",
			},
			{
				id: 8703,
				date: "2026-09-03",
				cents: 3000,
				raw: "COMCAST CABLE 2",
				merchant: "Comcast",
			},
		);

		const groups = (await organizeGroups(db)).filter((g) =>
			g.merchantKeys.includes("Comcast"),
		);

		// One group for the key, named by the old name most of its charges show.
		expect(groups).toEqual([
			{
				name: "Comcast Cable",
				count: 3,
				totalCents: 6000,
				merchantKeys: ["Comcast"],
				// The bank texts it carries, so a person sees what else one choice changes.
				bankTexts: ["COMCAST CABLE", "COMCAST CABLE 2"],
			},
		]);

		const saved = await saveOrganizeGroup(
			db,
			groups[0]?.merchantKeys ?? [],
			GROCERIES,
			null,
			"me",
		);
		expect(saved).toBe(3);
		expect((await row(8703))?.category_id).toBe(GROCERIES);
	});

	it("names an Organize group by its key's row first, then its old names by count and then alphabet", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO merchants (raw_name, display_name, raw_text) VALUES ('B OLD', 'Beta', 1), ('A OLD', 'Alpha', 1)",
			),
		]);
		await insert(
			{
				id: 8711,
				date: "2026-09-01",
				cents: 100,
				raw: "B OLD",
				merchant: "Zed",
			},
			{
				id: 8712,
				date: "2026-09-02",
				cents: 100,
				raw: "A OLD",
				merchant: "Zed",
			},
		);
		const name = async () =>
			(await organizeGroups(db)).find((g) => g.merchantKeys.includes("Zed"))
				?.name;

		// A tie on count goes to the alphabetically first name.
		expect(await name()).toBe("Alpha");

		await insert({
			id: 8713,
			date: "2026-09-03",
			cents: 100,
			raw: "B OLD",
			merchant: "Zed",
		});
		expect(await name()).toBe("Beta");

		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('Zed', 'Zed Stores')",
			)
			.run();
		expect(await name()).toBe("Zed Stores");
	});

	it("does not let a bill for one merchant claim another merchant's charge with the same bank text", async () => {
		await insert(
			// "Target" is a merchant name here, so a bill saved as "Target" is Target's.
			{
				id: 8721,
				date: "2026-08-10",
				cents: 5000,
				raw: "TARGET 1234",
				merchant: "Target",
			},
			{
				id: 8722,
				date: "2026-09-10",
				cents: 5000,
				raw: "Target",
				merchant: "Target Optical",
			},
		);
		await bill(8701, "Target");

		await matchBillPayments(db, TODAY);

		expect(
			(
				await db
					.prepare(
						"SELECT transaction_id FROM bill_payments WHERE bill_id = 8701",
					)
					.all()
			).results,
		).toEqual([{ transaction_id: 8721 }]);
	});

	it("still matches a legacy bill saved under the bank's raw text", async () => {
		await insert(
			{
				id: 8731,
				date: "2026-09-10",
				cents: 8000,
				raw: "COMCAST CABLE",
				merchant: "Comcast",
			},
			{
				id: 8732,
				date: "2026-08-10",
				cents: 8000,
				raw: "COMCAST CABLE",
				merchant: "Comcast",
			},
		);
		await bill(8702, "COMCAST CABLE", 10, 8000, true);

		await matchBillPayments(db, TODAY);

		expect(
			(
				await db
					.prepare(
						"SELECT transaction_id FROM bill_payments WHERE bill_id = 8702 ORDER BY period",
					)
					.all()
			).results,
		).toEqual([{ transaction_id: 8732 }, { transaction_id: 8731 }]);
	});

	it("does not rank another merchant's charge as the same merchant when linking by hand", async () => {
		await insert(
			{
				id: 8741,
				date: "2026-09-12",
				cents: 9000,
				raw: "TARGET 1234",
				merchant: "Target",
			},
			// Closer in amount, and the bill's text is its bank text, but it is Target Optical's.
			{
				id: 8742,
				date: "2026-09-10",
				cents: 5000,
				raw: "Target",
				merchant: "Target Optical",
			},
		);
		await bill(8703, "Target");

		const html = await (
			await exports.default.fetch(`${BASE}/bills/8703/occurrences/2026-09/link`)
		).text();
		const picker = html.slice(html.indexOf('<section id="payment-picker"'));

		expect(picker.indexOf('value="8741"')).toBeGreaterThan(-1);
		expect(picker.indexOf('value="8741"')).toBeLessThan(
			picker.indexOf('value="8742"'),
		);
	});

	it("does not hide another merchant's charges from finding bills because of a bill with the same bank text", async () => {
		await insert(
			{
				id: 8751,
				date: "2026-08-05",
				cents: 2500,
				raw: "TARGET 1234",
				merchant: "Target",
			},
			{
				id: 8752,
				date: "2026-08-06",
				cents: 3500,
				raw: "Target",
				merchant: "Target Optical",
			},
			{
				id: 8753,
				date: "2026-09-05",
				cents: 3500,
				raw: "Target",
				merchant: "Target Optical",
			},
		);
		await bill(8704, "Target");

		const found = (await loadBillSuggestions(db, TODAY)).map((s) => s.rawName);

		expect(found).toEqual(["Target Optical"]);
	});

	it("does not apply one merchant's rule or name to another merchant that shares its bank text", async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name, default_category_id) VALUES ('Target', 'Target Stores', ?)",
			)
			.bind(GROCERIES)
			.run();
		await insert(
			{
				id: 8761,
				date: "2026-09-01",
				cents: 100,
				raw: "TARGET 1234",
				merchant: "Target",
			},
			{
				id: 8762,
				date: "2026-09-02",
				cents: 100,
				raw: "Target",
				merchant: "Target Optical",
			},
		);

		await applyMerchantRules(db);

		expect(await row(8761)).toMatchObject({ category_id: GROCERIES });
		expect(await row(8762)).toMatchObject({
			category_id: null,
			category_source: null,
		});
		expect((await getTransaction(db, 8761))?.displayName).toBe("Target Stores");
		expect((await getTransaction(db, 8762))?.displayName).not.toBe(
			"Target Stores",
		);
	});

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

	it("keeps a legacy rule, name and bill working when an unrelated charge has the old text as its merchant name", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO merchants (raw_name, display_name, default_category_id, raw_text) VALUES ('COMCAST CABLE', 'Comcast Cable', 5, 1)",
			),
		]);
		await bill(8705, "COMCAST CABLE", 10, 8000, true);
		await insert(
			{
				id: 8801,
				date: "2026-09-10",
				cents: 8000,
				raw: "COMCAST CABLE",
				merchant: "Comcast",
			},
			// An unrelated charge whose Plaid merchant name happens to be the old text.
			{
				id: 8802,
				date: "2026-03-01",
				cents: 100,
				raw: "SOMETHING ELSE",
				merchant: "COMCAST CABLE",
			},
		);

		await applyMerchantRules(db);
		await matchBillPayments(db, TODAY);

		expect(await row(8801)).toMatchObject({
			category_id: 5,
			category_source: "merchant_rule",
		});
		expect((await getTransaction(db, 8801))?.displayName).toBe("Comcast Cable");
		expect(
			(
				await db
					.prepare(
						"SELECT transaction_id FROM bill_payments WHERE bill_id = 8705 AND status = 'linked'",
					)
					.all()
			).results,
		).toEqual([{ transaction_id: 8801 }]);
	});

	describe("an unrelated charge whose merchant name equals a legacy bank text", () => {
		// A flagged row and bill saved under "COMCAST CABLE", the bank's raw text. Real Comcast charges carry
		// that raw text (some with Plaid's name "Comcast", some from before it, with none). An unrelated
		// charge from "XYZ PAYMENTS" happens to have the merchant name "COMCAST CABLE".
		beforeEach(async () => {
			await db.batch([
				db.prepare(
					"INSERT INTO merchants (raw_name, display_name, default_category_id, raw_text) VALUES ('COMCAST CABLE', 'Comcast Cable', 5, 1)",
				),
			]);
			await bill(8901, "COMCAST CABLE", 10, 8000, true);
			await insert(
				// Closer to the due date than the real payment, so a wrong match would win.
				{
					id: 8903,
					date: "2026-09-10",
					cents: 8000,
					raw: "XYZ PAYMENTS",
					merchant: "COMCAST CABLE",
				},
				{
					id: 8901,
					date: "2026-09-12",
					cents: 8000,
					raw: "COMCAST CABLE",
					merchant: "Comcast",
				},
				{ id: 8902, date: "2026-08-10", cents: 8000, raw: "COMCAST CABLE" },
			);
		});

		it("gets neither the rule nor the name, while the real charges still do", async () => {
			await applyMerchantRules(db);

			expect(await row(8901)).toMatchObject({
				category_id: 5,
				category_source: "merchant_rule",
			});
			expect(await row(8902)).toMatchObject({
				category_id: 5,
				category_source: "merchant_rule",
			});
			expect(await row(8903)).toMatchObject({
				category_id: null,
				category_source: null,
			});
			expect((await getTransaction(db, 8901))?.displayName).toBe(
				"Comcast Cable",
			);
			expect((await getTransaction(db, 8902))?.displayName).toBe(
				"Comcast Cable",
			);
			expect((await getTransaction(db, 8903))?.displayName).not.toBe(
				"Comcast Cable",
			);
		});

		it("is not claimed by the bill, which still pays from the real charges", async () => {
			await matchBillPayments(db, TODAY);

			expect(
				(
					await db
						.prepare(
							"SELECT transaction_id FROM bill_payments WHERE bill_id = 8901 AND status = 'linked' ORDER BY period",
						)
						.all()
				).results,
			).toEqual([{ transaction_id: 8902 }, { transaction_id: 8901 }]);
		});

		it("is not ranked as the bill's merchant when linking by hand", async () => {
			const html = await (
				await exports.default.fetch(
					`${BASE}/bills/8901/occurrences/2026-09/link`,
				)
			).text();
			const picker = html.slice(html.indexOf('<section id="payment-picker"'));

			expect(picker.indexOf('value="8901"')).toBeGreaterThan(-1);
			expect(picker.indexOf('value="8901"')).toBeLessThan(
				picker.indexOf('value="8903"'),
			);
		});

		it("is not hidden from finding bills by the legacy bill or Not a bill mark", async () => {
			await db.prepare("UPDATE merchants SET not_a_bill = 1").run();
			await insert(
				{
					id: 8904,
					date: "2026-08-12",
					cents: 3000,
					raw: "XYZ PAYMENTS",
					merchant: "COMCAST CABLE",
				},
				{
					id: 8905,
					date: "2026-09-11",
					cents: 3000,
					raw: "XYZ PAYMENTS",
					merchant: "COMCAST CABLE",
				},
			);

			expect(
				(await loadBillSuggestions(db, TODAY)).map((s) => s.rawName),
			).toEqual(["COMCAST CABLE"]);
		});

		it("is hidden from finding bills by a Not a bill mark saved under its own key", async () => {
			await insert(
				{
					id: 8904,
					date: "2026-08-12",
					cents: 3000,
					raw: "XYZ PAYMENTS",
					merchant: "COMCAST CABLE",
				},
				{
					id: 8905,
					date: "2026-09-11",
					cents: 3000,
					raw: "XYZ PAYMENTS",
					merchant: "COMCAST CABLE",
				},
			);
			// The old row is flagged, so a person's choice about the merchant named "COMCAST CABLE"
			// takes over that row, which is then the merchant name's, not the bank text's.
			const res = await exports.default.fetch(
				`${BASE}/bills/find/${encodeURIComponent("COMCAST CABLE")}/dismiss`,
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
			expect(await loadBillSuggestions(db, TODAY)).toEqual([]);
		});

		it("takes a person's rename for the merchant name over the flagged row, so it applies to the charge", async () => {
			await saveEdit(db, 8903, edit({ displayName: "XYZ Payments" }), "me");

			expect((await getTransaction(db, 8903))?.displayName).toBe(
				"XYZ Payments",
			);
			expect(
				(
					await db
						.prepare(
							"SELECT raw_text FROM merchants WHERE raw_name = 'COMCAST CABLE'",
						)
						.first()
				)?.raw_text,
			).toBe(0);
		});
	});

	it("lets a row saved under the key beat a legacy row for the same bank text", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO merchants (raw_name, display_name, default_category_id, raw_text) VALUES ('COMCAST CABLE', 'Comcast Cable', 5, 1)",
			),
			db.prepare(
				"INSERT INTO merchants (raw_name, display_name, default_category_id) VALUES ('Comcast', 'Comcast Internet', 3)",
			),
		]);
		await insert({
			id: 8811,
			date: "2026-09-10",
			cents: 8000,
			raw: "COMCAST CABLE",
			merchant: "Comcast",
		});

		await applyMerchantRules(db);

		expect(await row(8811)).toMatchObject({ category_id: 3 });
		expect((await getTransaction(db, 8811))?.displayName).toBe(
			"Comcast Internet",
		);
	});

	it("does not let a bill saved under the key claim another merchant's charge, even with the same bank text", async () => {
		await insert({
			id: 8821,
			date: "2026-09-10",
			cents: 5000,
			raw: "Target",
			merchant: "Target Optical",
		});
		// Saved after Phase 3.5, so "Target" is a key, not bank text.
		await bill(8706, "Target");

		await matchBillPayments(db, TODAY);

		expect(
			(await db.prepare("SELECT COUNT(*) AS n FROM bill_payments").first())?.n,
		).toBe(0);
	});

	it("keeps a legacy bill on the bank text it was saved under, as before Phase 3.5, whatever Plaid now calls the charge", async () => {
		await insert({
			id: 8831,
			date: "2026-09-10",
			cents: 5000,
			raw: "Target",
			merchant: "Target Optical",
		});
		await bill(8707, "Target", 10, 5000, true);

		await matchBillPayments(db, TODAY);

		expect(
			(
				await db
					.prepare(
						"SELECT transaction_id FROM bill_payments WHERE bill_id = 8707",
					)
					.all()
			).results,
		).toEqual([{ transaction_id: 8831 }]);
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

	it("saves a new row under the key with the flag off, and leaves a legacy row's flag alone", async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name, raw_text) VALUES ('COMCAST CABLE', 'Comcast Cable', 1)",
			)
			.run();
		await insert(
			{
				id: 8841,
				date: "2026-09-10",
				cents: 8000,
				raw: "COMCAST CABLE",
				merchant: "Comcast",
			},
			{ id: 8842, date: "2026-09-11", cents: 8000, raw: "COMCAST CABLE" },
		);

		await saveEdit(db, 8841, edit({ displayName: "Comcast Internet" }), "me");
		await saveEdit(db, 8842, edit({ displayName: "Comcast Cable Co" }), "me");

		expect(
			(
				await db
					.prepare(
						"SELECT raw_name, display_name, raw_text FROM merchants ORDER BY raw_name",
					)
					.all()
			).results,
		).toEqual([
			{
				raw_name: "COMCAST CABLE",
				display_name: "Comcast Cable Co",
				raw_text: 1,
			},
			{ raw_name: "Comcast", display_name: "Comcast Internet", raw_text: 0 },
		]);
	});
});

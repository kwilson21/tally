import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { summarizeMonth } from "../src/budget";
import { lastMonthSpentCents } from "../src/db/budgets";
import {
	COUNTED_JOINS,
	countedCategorySql,
	countedMonthSql,
	FOLLOWS_PURCHASE,
} from "../src/db/counted-month";
import { loadMonth } from "../src/db/month";
import {
	getTransaction,
	monthCounts,
	needsCategoryCount,
	pendingForJev,
	refundPurchases,
	saveEdit,
} from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import {
	organizeGroups,
	saveOrganizeGroup,
} from "../src/transactions/organize";

const db = env.DB;
const BASE = "http://tally.test";
const GROCERIES = 1;
const EATING_OUT = 2;
const GAS = 3;
const KIDS = 4;
const HOUSEHOLD = 5;

// The purchase (Aug 20), the refund (Sep 10, its own category Groceries), and the purchases around them.
const PURCHASE = 9001;
const REFUND = 9002;
const TOO_OLD = 9003;
const OTHER_MERCHANT = 9004;
const SPLIT = 9005;
const PART_KIDS = 9006;
const PART_HOUSEHOLD = 9007;
const AFTER_REFUND = 9008;
const OLDEST_IN_WINDOW = 9009;
const SECOND_REFUND = 9010;

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare(
			"INSERT INTO merchants (raw_name, display_name) VALUES ('REFUND SHOP', 'Refund Shop')",
		),
		db.prepare(`INSERT INTO transactions
			(id, account_id, date, amount_cents, raw_name, category_id, category_source, is_split, parent_id) VALUES
			(${PURCHASE}, 3, '2026-08-20', 5000, 'REFUND SHOP', ${KIDS}, 'jev', 0, NULL),
			(${REFUND}, 3, '2026-09-10', -2000, 'REFUND SHOP', ${GROCERIES}, 'user', 0, NULL),
			(${TOO_OLD}, 3, '2026-06-11', 700, 'REFUND SHOP', ${KIDS}, 'jev', 0, NULL),
			(${OTHER_MERCHANT}, 3, '2026-09-01', 1000, 'OTHER SHOP', ${KIDS}, 'jev', 0, NULL),
			(${SPLIT}, 3, '2026-09-01', 3000, 'REFUND SHOP', NULL, NULL, 1, NULL),
			(${PART_KIDS}, 3, '2026-09-01', 1000, 'REFUND SHOP', ${KIDS}, 'user', 0, ${SPLIT}),
			(${PART_HOUSEHOLD}, 3, '2026-09-01', 2000, 'REFUND SHOP', ${HOUSEHOLD}, 'user', 0, ${SPLIT}),
			(${AFTER_REFUND}, 3, '2026-09-15', 800, 'REFUND SHOP', ${KIDS}, 'jev', 0, NULL),
			(${OLDEST_IN_WINDOW}, 3, '2026-06-12', 900, 'REFUND SHOP', ${KIDS}, 'jev', 0, NULL),
			(${SECOND_REFUND}, 3, '2026-09-12', -500, 'REFUND SHOP', ${GROCERIES}, 'user', 0, NULL)`),
	]);
});

async function get(path: string) {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
}

async function post(path: string, fields: [string, string][]) {
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		headers: {
			Origin: BASE,
			"HX-Request": "true",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(fields),
	});
	const trigger = JSON.parse(res.headers.get("HX-Trigger") ?? "null") as {
		toast: { message: string };
		announce: string;
	} | null;
	return { res, html: await res.text(), trigger };
}

/** The edit panel's save, as the form posts it. */
const save = (id: number, fields: [string, string][]) =>
	post(`/transactions/${id}`, [
		["back", "/transactions"],
		["merchant", "Refund Shop"],
		...fields,
	]);

const link = (refund: number, purchase: number | "") =>
	save(refund, [["refund_of", String(purchase)]]);

const refundOf = async (id: number) =>
	(
		await db
			.prepare("SELECT refund_of_id AS r FROM transactions WHERE id = ?")
			.bind(id)
			.first<{ r: number | null }>()
	)?.r;

const ownCategory = async (id: number) =>
	(
		await db
			.prepare("SELECT category_id AS c FROM transactions WHERE id = ?")
			.bind(id)
			.first<{ c: number | null }>()
	)?.c;

/** Counted spending in a category for a month, as Home and Budget add it up. */
async function spent(month: string, categoryId: number | null) {
	const data = await loadMonth(db, month);
	return data.transactions
		.filter((t) => !t.income && t.categoryId === categoryId)
		.reduce((sum, t) => sum + t.amountCents, 0);
}

/** A transaction as the edit panel loads it. */
async function detail(id: number) {
	const tx = await getTransaction(db, id);
	if (!tx) throw new Error(`No transaction ${id}`);
	return tx;
}

/** One row of the list, from its <li> to the next. */
function rowHtml(html: string, id: number) {
	const start = html.indexOf(`data-transaction="${id}"`);
	expect(start).toBeGreaterThan(-1);
	return html.slice(start, html.indexOf("</li>", start));
}

describe("counted month and category (one shared expression)", () => {
	type Side = {
		date: string;
		category: number | null;
		amount?: number;
		income?: boolean;
		period?: string | null;
		frequency?: "monthly" | "yearly";
		anchor?: number | null;
		excluded?: boolean;
		reviewed?: boolean;
	};
	/** Evaluates the expressions over one transaction and the purchase it refunds (if any), no tables. */
	async function counted(t: Side, purchase?: Side) {
		const row = (side: Side | undefined, id: number | null) =>
			side
				? `SELECT ${id} AS id, '${side.date}' AS date, ${side.amount ?? -2000} AS amount_cents, ${side.category ?? "NULL"} AS category_id, ${side.income ? 1 : 0} AS flag_income, ${purchase && id === 1 ? 2 : "NULL"} AS refund_of_id, ${side.excluded ? 1 : 0} AS excluded, ${side.reviewed ? 1 : 0} AS credit_reviewed, ${side.reviewed ? "'user'" : "NULL"} AS credit_reviewed_by`
				: "SELECT NULL AS id, NULL AS date, NULL AS amount_cents, NULL AS category_id, 0 AS flag_income, NULL AS refund_of_id, NULL AS excluded, 0 AS credit_reviewed, NULL AS credit_reviewed_by";
		const pay = (side: Side | undefined) =>
			side?.period
				? `SELECT '${side.period}' AS period`
				: "SELECT NULL AS period";
		const bill = (side: Side | undefined) =>
			`SELECT '${side?.frequency ?? "monthly"}' AS frequency, ${side?.anchor ?? "NULL"} AS anchor_month`;
		return db
			.prepare(
				`SELECT ${countedMonthSql()} AS month, ${countedCategorySql()} AS category, ${FOLLOWS_PURCHASE} AS follows
				FROM (${row(t, 1)}) t
				CROSS JOIN (${pay(t)}) bp CROSS JOIN (${bill(t)}) b
				CROSS JOIN (${row(purchase, purchase ? 2 : null)}) rp
				CROSS JOIN (${pay(purchase)}) rbp CROSS JOIN (${bill(purchase)}) rb`,
			)
			.first<{ month: string; category: number | null; follows: number }>();
	}

	it("an unlinked transaction counts in its own month and category", async () => {
		expect(await counted({ date: "2026-09-10", category: 1 })).toMatchObject({
			month: "2026-09",
			category: 1,
		});
	});

	it("a refund of an excluded purchase counts on its own date and category", async () => {
		expect(
			await counted(
				{ date: "2026-09-10", category: 1 },
				{ date: "2026-08-20", category: 4, excluded: true },
			),
		).toMatchObject({ month: "2026-09", category: 1 });
	});

	it("a linked refund counts in its purchase's month and category", async () => {
		expect(
			await counted(
				{ date: "2026-09-10", category: 1, reviewed: true },
				{ date: "2026-08-20", category: 4, reviewed: true },
			),
		).toMatchObject({ month: "2026-08", category: 4, follows: 1 });
	});

	it("a linked credit stops following an AI-owned purchase after Plaid invalidates review", async () => {
		expect(
			await counted(
				{ date: "2026-09-10", category: 1, reviewed: false },
				{ date: "2026-08-20", category: 4 },
			),
		).toMatchObject({ month: "2026-09", category: 1, follows: 0 });
	});

	it.each([
		{ amount: -2000, income: true },
		{ amount: 2000, income: false },
	])(
		"a linked transaction does not follow its purchase after its role changes: $amount, income $income",
		async ({ amount, income }) => {
			expect(
				await counted(
					{ date: "2026-09-10", category: 1, amount, income, reviewed: true },
					{ date: "2026-08-20", category: 4, reviewed: true },
				),
			).toMatchObject({ month: "2026-09", category: 1, follows: 0 });
		},
	);

	it("a refund linked to a reviewed split part takes that part's category", async () => {
		expect(
			await counted(
				{ date: "2026-09-10", category: null, reviewed: true },
				{ date: "2026-09-01", category: 5, reviewed: true },
			),
		).toMatchObject({ month: "2026-09", category: 5, follows: 1 });
	});

	it("a refund of an uncategorized purchase has no counted category", async () => {
		expect(
			await counted(
				{ date: "2026-09-10", category: 1, reviewed: true },
				{ date: "2026-08-20", category: null, reviewed: true },
			),
		).toMatchObject({ month: "2026-08", category: null, follows: 1 });
	});

	it("follows a purchase that is a late bill payment into its bill's month", async () => {
		expect(
			await counted(
				{ date: "2026-10-12", category: 1, reviewed: true },
				{ date: "2026-10-02", category: 4, period: "2026-09", reviewed: true },
			),
		).toMatchObject({ month: "2026-09", category: 4 });
		expect(
			await counted(
				{ date: "2026-10-12", category: 1, reviewed: true },
				{
					date: "2026-10-02",
					category: 4,
					reviewed: true,
					period: "2026",
					frequency: "yearly",
					anchor: 9,
				},
			),
		).toMatchObject({ month: "2026-09", category: 4 });
	});

	it("keeps a bill payment's own rule when it isn't a linked refund", async () => {
		expect(
			await counted({ date: "2026-10-02", category: 4, period: "2026-09" }),
		).toMatchObject({ month: "2026-09", category: 4 });
	});

	it("names every alias its joins provide", () => {
		for (const alias of ["bp", "b", "rp", "rbp", "rb"])
			expect(COUNTED_JOINS).toMatch(new RegExp(`\\b${alias} ON`));
	});
});

describe("which purchases a refund can link to", () => {
	it("lists same-merchant purchases in the 90 days up to the refund, parts not parents, newest first", async () => {
		const refund = await detail(REFUND);
		const ids = (await refundPurchases(db, refund)).map((p) => p.id);
		expect(ids).toEqual([
			PART_HOUSEHOLD,
			PART_KIDS,
			PURCHASE,
			OLDEST_IN_WINDOW,
		]);
		expect(ids).not.toContain(SPLIT);
		expect(ids).not.toContain(TOO_OLD);
		expect(ids).not.toContain(OTHER_MERCHANT);
		expect(ids).not.toContain(AFTER_REFUND);
	});

	it("offers nothing for a purchase or income", async () => {
		const purchase = await detail(PURCHASE);
		expect(await refundPurchases(db, purchase)).toEqual([]);
		await db
			.prepare("UPDATE transactions SET flag_income = 1 WHERE id = ?")
			.bind(REFUND)
			.run();
		const income = await detail(REFUND);
		expect(await refundPurchases(db, income)).toEqual([]);
	});

	it("shows chips with date, amount and category in a labeled fieldset", async () => {
		const { html } = await get(`/transactions/${REFUND}`);
		expect(html).toContain("This refunds…");
		expect(html).toContain("Refund Shop purchases in the last 90 days");
		expect(html).toMatch(
			/<fieldset[^>]*>\s*<legend class="sr-only">Purchase this refunds<\/legend>/,
		);
		expect(html).toContain("Aug 20 · $50.00 · Kids");
		expect(html).toContain("Sep 1 · $20.00 · Household");
		expect(html).toMatch(/name="refund_of" value=""[^>]*checked/);
		expect(html).not.toContain("Today,");
	});

	it("always shows the linked purchase, checked, even once it no longer qualifies", async () => {
		await link(REFUND, PURCHASE);
		await db
			.prepare("UPDATE transactions SET date = '2026-05-01' WHERE id = ?")
			.bind(PURCHASE)
			.run();
		const { html } = await get(`/transactions/${REFUND}`);
		expect(html).toMatch(
			new RegExp(`name="refund_of" value="${PURCHASE}"[^>]*checked`),
		);
		const { res } = await link(REFUND, PURCHASE);
		expect(res.status).toBe(200);
		expect(await refundOf(REFUND)).toBe(PURCHASE);
	});
});

describe("linking a refund", () => {
	it("a note-only save keeps Jev ownership of an unchanged reviewed refund link", async () => {
		await db
			.prepare(
				"UPDATE transactions SET refund_of_id = ?, category_source = 'jev', category_confidence = 0.95, flag_income = 0, income_source = NULL, credit_reviewed = 1, credit_reviewed_by = NULL WHERE id = ?",
			)
			.bind(PURCHASE, REFUND)
			.run();
		const { res } = await post(`/transactions/${REFUND}`, [
			["merchant", "Refund Shop"],
			["note", "Reviewed refund note"],
			["back", "/transactions"],
			["income", "0"],
			["creditReviewedVisible", "1"],
			["creditReviewed", "1"],
			["refund_of", String(PURCHASE)],
		]);
		expect(res.status).toBe(200);
		expect(
			await db
				.prepare(
					"SELECT note, income_source, credit_reviewed, credit_reviewed_by, refund_of_id FROM transactions WHERE id = ?",
				)
				.bind(REFUND)
				.first(),
		).toEqual({
			note: "Reviewed refund note",
			income_source: null,
			credit_reviewed: 1,
			credit_reviewed_by: null,
			refund_of_id: PURCHASE,
		});
	});

	it("moves its spending into the purchase's month and category, and unlinking moves it back", async () => {
		const before = {
			augKids: await spent("2026-08", KIDS),
			sepGroceries: await spent("2026-09", GROCERIES),
			budgetKids: await lastMonthSpentCents(db, KIDS, "2026-09"),
		};
		const { res, trigger } = await link(REFUND, PURCHASE);
		expect(res.status).toBe(200);
		expect(
			await db
				.prepare(
					"SELECT credit_reviewed, credit_reviewed_by FROM transactions WHERE id = ?",
				)
				.bind(REFUND)
				.first(),
		).toEqual({ credit_reviewed: 1, credit_reviewed_by: "user" });
		expect(trigger?.toast.message).toBeTruthy();
		expect(trigger?.announce).toBeTruthy();
		expect(await spent("2026-08", KIDS)).toBe(before.augKids - 2000);
		expect(await spent("2026-09", GROCERIES)).toBe(before.sepGroceries);
		expect(await lastMonthSpentCents(db, KIDS, "2026-09")).toBe(
			before.budgetKids - 2000,
		);
		// Its own category is kept, untouched.
		expect(await ownCategory(REFUND)).toBe(GROCERIES);

		await link(REFUND, "");
		expect(await refundOf(REFUND)).toBeNull();
		expect(await spent("2026-08", KIDS)).toBe(before.augKids);
		expect(await spent("2026-09", GROCERIES)).toBe(before.sepGroceries - 2000);
		expect(await ownCategory(REFUND)).toBe(GROCERIES);
	});

	it("a manual refund link takes ownership after Jev reviewed the credit", async () => {
		await db
			.prepare(
				"UPDATE transactions SET category_source = 'jev', category_confidence = 0.95, credit_reviewed = 1, credit_reviewed_by = NULL WHERE id = ?",
			)
			.bind(REFUND)
			.run();
		const beforeSeptember = await spent("2026-09", GROCERIES);
		const beforeAugust = await spent("2026-08", KIDS);
		await link(REFUND, PURCHASE);
		expect(
			await db
				.prepare(
					"SELECT credit_reviewed, credit_reviewed_by FROM transactions WHERE id = ?",
				)
				.bind(REFUND)
				.first(),
		).toEqual({ credit_reviewed: 1, credit_reviewed_by: "user" });
		expect(await spent("2026-09", GROCERIES)).toBe(beforeSeptember + 2000);
		expect(await spent("2026-08", KIDS)).toBe(beforeAugust - 2000);
	});

	it("lists the refund under the purchase's month and category filter", async () => {
		await link(REFUND, PURCHASE);
		const august = (
			await get("/transactions?month=2026-08&category=4&q=refund")
		).html;
		expect(august).toContain(`data-transaction="${REFUND}"`);
		const september = (await get("/transactions?month=2026-09&q=refund")).html;
		expect(september).not.toContain(`data-transaction="${REFUND}"`);
	});

	it("follows the purchase when it's recategorized in its edit panel", async () => {
		await link(REFUND, PURCHASE);
		const kids = await spent("2026-08", KIDS);
		const gas = await spent("2026-08", GAS);
		await save(PURCHASE, [["category", String(GAS)]]);
		expect(await spent("2026-08", KIDS)).toBe(kids - 3000);
		expect(await spent("2026-08", GAS)).toBe(gas + 3000);
		expect(await ownCategory(REFUND)).toBe(GROCERIES);
	});

	it("follows the purchase when Organize or a merchant rule categorizes it", async () => {
		await link(REFUND, PURCHASE);
		await db
			.prepare(
				"UPDATE transactions SET category_id = NULL, category_source = NULL WHERE id = ?",
			)
			.bind(PURCHASE)
			.run();
		await saveOrganizeGroup(db, ["REFUND SHOP"], EATING_OUT, null, "test");
		expect(await ownCategory(PURCHASE)).toBe(EATING_OUT);
		const august = await loadMonth(db, "2026-08");
		expect(
			august.transactions.filter(
				(t) => t.categoryId === EATING_OUT && t.amountCents === -2000,
			),
		).toHaveLength(1);

		// A merchant rule saved from another of its purchases recategorizes this one too.
		await db
			.prepare("UPDATE transactions SET category_source = 'jev' WHERE id = ?")
			.bind(PURCHASE)
			.run();
		await saveEdit(
			db,
			OLDEST_IN_WINDOW,
			{
				categoryId: GAS,
				alwaysForMerchant: true,
				displayName: "Refund Shop",
				note: null,
				excluded: false,
				income: false,
				creditReviewed: false,
			},
			"test",
		);
		expect(await ownCategory(PURCHASE)).toBe(GAS);
		const after = await loadMonth(db, "2026-08");
		expect(
			after.transactions.filter(
				(t) => t.categoryId === GAS && t.amountCents === -2000,
			),
		).toHaveLength(1);
		expect(await ownCategory(REFUND)).toBe(GROCERIES);
	});

	it("leaves the category to its purchase when that has none", async () => {
		await link(REFUND, PURCHASE);
		const before = await needsCategoryCount(db, "2026-08");
		await db
			.prepare(
				"UPDATE transactions SET category_id = NULL, category_source = NULL WHERE id = ?",
			)
			.bind(PURCHASE)
			.run();
		// Only the purchase needs one; categorizing it covers the refund too.
		expect(await needsCategoryCount(db, "2026-08")).toBe(before + 1);
		// Home's count agrees with the list.
		const home = summarizeMonth({
			...(await loadMonth(db, "2026-08")),
			month: "2026-08",
			unpaidDueBillsCents: 0,
		});
		expect(home.uncategorized.count).toBe(before + 1);
		const { html } = await get("/transactions?month=2026-08&uncategorized=1");
		expect(rowHtml(html, PURCHASE)).toContain("Needs category");
		expect(html).not.toContain(`/transactions/${REFUND}`);
		const all = await get("/transactions?month=2026-08&q=refund");
		const row = rowHtml(all.html, REFUND);
		expect(row).toContain("Refund for Aug 20");
		expect(row).not.toContain("Needs category");
		// How Tally works still adds up.
		const counts = await monthCounts(db, "2026-08");
		expect(counts.needsCategory).toBe(before + 1);
		expect(counts.notYetAsked + counts.unsure + counts.noneFit).toBe(
			counts.needsCategory,
		);
		// The refund waits with its purchase, so the categories still add up.
		expect(counts.linkedWaiting).toBe(1);
		expect(
			counts.user +
				counts.merchantRule +
				counts.jev +
				counts.needsCategory +
				counts.linkedWaiting,
		).toBe(counts.counted - counts.income);
	});

	it("counts on its own, with its own prompt, once its purchase is excluded", async () => {
		await link(REFUND, PURCHASE);
		await db
			.prepare(
				"UPDATE transactions SET category_id = NULL, category_source = NULL WHERE id = ?",
			)
			.bind(REFUND)
			.run();
		const before = await needsCategoryCount(db, "2026-09");
		await db
			.prepare(
				"UPDATE transactions SET excluded = 1, excluded_source = 'user' WHERE id = ?",
			)
			.bind(PURCHASE)
			.run();
		// Back in its own month (September), waiting for a category of its own.
		expect(await needsCategoryCount(db, "2026-09")).toBe(before + 1);
		const home = summarizeMonth({
			...(await loadMonth(db, "2026-09")),
			month: "2026-09",
			unpaidDueBillsCents: 0,
		});
		expect(home.uncategorized.count).toBe(before + 1);
		const { html } = await get("/transactions?month=2026-09&q=refund");
		expect(rowHtml(html, REFUND)).toContain("Needs category");
		// Its category can be set again, and it counts there.
		const sheet = await get(`/transactions/${REFUND}`);
		expect(sheet.html).not.toMatch(/<fieldset[^>]*disabled/);
		const gasBefore = await spent("2026-09", GAS);
		await save(REFUND, [["category", String(GAS)]]);
		expect(await ownCategory(REFUND)).toBe(GAS);
		expect(await spent("2026-09", GAS)).toBe(
			gasBefore + (await detail(REFUND)).amountCents,
		);
		expect(await refundOf(REFUND)).toBe(PURCHASE);
	});

	it("doesn't offer an excluded purchase", async () => {
		await db
			.prepare("UPDATE transactions SET excluded = 1 WHERE id = ?")
			.bind(PURCHASE)
			.run();
		const offered = (await refundPurchases(db, await detail(REFUND))).map(
			(p) => p.id,
		);
		expect(offered).not.toContain(PURCHASE);
	});

	it("isn't sent to Jev or listed in Organize while linked", async () => {
		await link(REFUND, PURCHASE);
		await db
			.prepare(
				"UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = NULL WHERE id IN (?, ?)",
			)
			.bind(PURCHASE, REFUND)
			.run();
		const pending = (await pendingForJev(db, 500)).map((row) => row.id);
		expect(pending).toContain(PURCHASE);
		expect(pending).not.toContain(REFUND);
		const group = (await organizeGroups(db)).find((g) =>
			g.merchantKeys.includes("REFUND SHOP"),
		);
		const uncategorized = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE raw_name = 'REFUND SHOP' AND category_id IS NULL AND excluded = 0 AND is_split = 0 AND flag_income = 0",
			)
			.first<number>("n");
		// Every uncategorized REFUND SHOP row but the linked refund.
		expect(group?.count).toBe((uncategorized ?? 0) - 1);
	});

	it("counts in the bill month of a purchase that paid an earlier bill", async () => {
		// An October payment for September's bill, refunded later in October.
		await db.batch([
			db
				.prepare("UPDATE transactions SET date = '2026-10-02' WHERE id = ?")
				.bind(PURCHASE),
			db
				.prepare("UPDATE transactions SET date = '2026-10-12' WHERE id = ?")
				.bind(REFUND),
			db.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (95, 'Shop plan', 5000, 28, 'monthly', 'REFUND SHOP')",
			),
			db.prepare(
				`INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (95, '2026-09', ${PURCHASE}, 'user', 'linked')`,
			),
			db.prepare(
				`UPDATE transactions SET refund_of_id = ${PURCHASE}, credit_reviewed = 1, credit_reviewed_by = 'user' WHERE id = ${REFUND}`,
			),
		]);
		const september = await loadMonth(db, "2026-09");
		const october = await loadMonth(db, "2026-10");
		expect(
			september.transactions.filter((t) => t.amountCents === -2000),
		).toEqual([
			{ categoryId: KIDS, amountCents: -2000, income: false, linked: true },
		]);
		expect(october.transactions.some((t) => t.amountCents === -2000)).toBe(
			false,
		);
	});

	it("rejects a purchase that isn't in the list, saving nothing", async () => {
		const { res, html } = await save(REFUND, [
			["refund_of", String(TOO_OLD)],
			["note", "should not save"],
		]);
		expect(res.status).toBe(422);
		expect(html).toMatch(
			/<fieldset[^>]*aria-describedby="refund-error"[^>]*>\s*<legend class="sr-only">Purchase this refunds/,
		);
		expect(html).toMatch(
			/<p id="refund-error" role="alert"[^>]*>Pick a purchase from the list\.<\/p>/,
		);
		const row = await db
			.prepare("SELECT refund_of_id, note FROM transactions WHERE id = ?")
			.bind(REFUND)
			.first();
		expect(row).toEqual({ refund_of_id: null, note: null });
	});

	it("keeps the link when the form has no refund_of field", async () => {
		await link(REFUND, PURCHASE);
		await save(REFUND, [["note", "kept"]]);
		expect(await refundOf(REFUND)).toBe(PURCHASE);
	});

	it("shows the purchase's category, locked, and ignores a posted category while linked", async () => {
		await link(REFUND, PURCHASE);
		const { html } = await get(`/transactions/${REFUND}`);
		const at = html.search(/<fieldset[^>]*disabled/);
		expect(at).toBeGreaterThan(-1);
		const fieldset = html.slice(at, html.indexOf("</fieldset>", at));
		expect(fieldset).toContain("<legend");
		expect(fieldset).toMatch(/name="category" value="4"[^>]*checked/);
		expect(fieldset).not.toMatch(/name="category" value="1"[^>]*checked/);
		expect(html).toContain("Counts in Kids with the Aug 20 purchase.");
		expect(html).not.toContain("Always for this merchant");

		await save(REFUND, [["category", String(GAS)]]);
		expect(await ownCategory(REFUND)).toBe(GROCERIES);
		expect(await refundOf(REFUND)).toBe(PURCHASE);
	});

	it("says it counts with an uncategorized purchase, without naming a category", async () => {
		await db
			.prepare("UPDATE transactions SET category_id = NULL WHERE id = ?")
			.bind(PURCHASE)
			.run();
		await link(REFUND, PURCHASE);
		const { html } = await get(`/transactions/${REFUND}`);
		expect(html).toContain("Counts with the Aug 20 purchase.");
	});
});

describe("captions on the linked pair", () => {
	it("names the purchase on the refund, and the refunded amount on the purchase", async () => {
		await link(REFUND, PURCHASE);
		const { html } = await get("/transactions?month=2026-08&q=refund");
		const refund = rowHtml(html, REFUND);
		expect(refund).toContain("Kids · Refund for Aug 20");
		expect(refund).not.toContain("Counts in");
		expect(rowHtml(html, PURCHASE)).toContain("Kids · $20.00 refunded");
	});

	it("shows the refunded amount on a split part", async () => {
		// The $20 refund fits the $20 Household part (it would not fit the $10 Kids part).
		await link(REFUND, PART_HOUSEHOLD);
		const { html } = await get("/transactions?month=2026-09&q=refund");
		expect(rowHtml(html, PART_HOUSEHOLD)).toContain(
			"Household · Split from Refund Shop · $20.00 refunded",
		);
		expect(rowHtml(html, REFUND)).toContain("Household · Refund for Sep 1");
	});
});

describe("splits unlink their refunds", () => {
	it("removing a split unlinks a refund of a part and says so", async () => {
		await link(REFUND, PART_HOUSEHOLD);
		const { trigger } = await post(`/transactions/${SPLIT}/split/remove`, [
			["back", "/transactions"],
		]);
		expect(await refundOf(REFUND)).toBeNull();
		expect(trigger?.toast.message).toBe(
			"Removed split from Refund Shop. The refund on Sep 10 is no longer linked.",
		);
		expect(trigger?.announce).toBe(
			"Removed split from Refund Shop. The refund on Sep 10 is no longer linked.",
		);
		// It counts on its own date and category again.
		expect(
			(await loadMonth(db, "2026-09")).transactions.filter(
				(t) => t.amountCents === -2000,
			),
		).toEqual([
			{
				categoryId: GROCERIES,
				amountCents: -2000,
				income: false,
				linked: false,
			},
		]);
	});

	it("counts several refunds in the toast", async () => {
		await link(REFUND, PART_HOUSEHOLD);
		await link(SECOND_REFUND, PART_KIDS);
		const { trigger } = await post(`/transactions/${SPLIT}/split/remove`, [
			["back", "/transactions"],
		]);
		expect(trigger?.toast.message).toBe(
			"Removed split from Refund Shop. 2 refunds are no longer linked.",
		);
		expect(await refundOf(SECOND_REFUND)).toBeNull();
	});

	it("re-splitting replaces the parts and unlinks their refunds", async () => {
		await link(REFUND, PART_HOUSEHOLD);
		const { res, trigger } = await post(`/transactions/${SPLIT}/split`, [
			["part_category", String(KIDS)],
			["part_category", String(GAS)],
			["part_amount", "15"],
			["part_amount", "15"],
			["back", "/transactions"],
		]);
		expect(res.status).toBe(200);
		expect(await refundOf(REFUND)).toBeNull();
		expect(trigger?.toast.message).toBe(
			"Split Refund Shop. The refund on Sep 10 is no longer linked.",
		);
		expect(trigger?.announce).toBe(
			"Saved split for Refund Shop. The refund on Sep 10 is no longer linked.",
		);
	});

	it("splitting a linked refund transfers its purchase link to each part", async () => {
		await link(REFUND, PURCHASE);
		const before = await spent("2026-08", KIDS);
		const linkedRefund = await refundOf(REFUND);
		expect(linkedRefund).toBe(PURCHASE);
		const { trigger } = await post(`/transactions/${REFUND}/split`, [
			["part_category", String(KIDS)],
			["part_category", String(GAS)],
			["part_amount", "10"],
			["part_amount", "10"],
			["back", "/transactions"],
		]);
		expect(await refundOf(PURCHASE)).toBeNull();
		expect(
			await db
				.prepare(
					"SELECT id, amount_cents, is_split, refund_of_id FROM transactions WHERE id = ?",
				)
				.bind(REFUND)
				.first(),
		).toMatchObject({
			id: REFUND,
			amount_cents: -2000,
			is_split: 1,
			refund_of_id: PURCHASE,
		});
		const parts = await db
			.prepare(
				"SELECT id, refund_of_id, credit_reviewed, credit_reviewed_by FROM transactions WHERE parent_id = ? ORDER BY id",
			)
			.bind(REFUND)
			.all();
		expect(parts.results).toHaveLength(2);
		for (const part of parts.results as Array<Record<string, unknown>>) {
			expect(part.refund_of_id).toBe(linkedRefund);
			expect(part.credit_reviewed).toBe(1);
			expect(part.credit_reviewed_by).toBe("user");
		}
		expect(await refundOf(REFUND)).toBe(linkedRefund);
		// The budget and the purchase caption count the two $10 parts, never the split parent too.
		expect(await spent("2026-08", KIDS)).toBe(before);
		const { html } = await get("/transactions?month=2026-08&q=refund");
		expect(rowHtml(html, PURCHASE)).toContain("Kids · $20.00 refunded");
		expect(rowHtml(html, PURCHASE)).not.toContain("$40.00 refunded");
		expect(trigger?.toast.message).toBe("Split Refund Shop");
		await post(`/transactions/${REFUND}/split/remove`, [
			["back", "/transactions"],
		]);
		expect(await refundOf(REFUND)).toBe(linkedRefund);
		expect(await spent("2026-08", KIDS)).toBe(before);
	});

	it("unlinks every split part when a linked refund is marked not linked", async () => {
		await link(REFUND, PURCHASE);
		await post(`/transactions/${REFUND}/split`, [
			["part_category", String(KIDS)],
			["part_category", String(GAS)],
			["part_amount", "10"],
			["part_amount", "10"],
			["back", "/transactions"],
		]);
		const beforeKids = await spent("2026-09", KIDS);
		const beforeGas = await spent("2026-09", GAS);
		const { res } = await link(REFUND, "");
		expect(res.status).toBe(200);
		expect(await refundOf(REFUND)).toBeNull();
		const parts = await db
			.prepare(
				"SELECT refund_of_id, credit_reviewed, credit_reviewed_by FROM transactions WHERE parent_id = ? ORDER BY id",
			)
			.bind(REFUND)
			.all();
		expect(parts.results).toEqual([
			{ refund_of_id: null, credit_reviewed: 1, credit_reviewed_by: "user" },
			{ refund_of_id: null, credit_reviewed: 1, credit_reviewed_by: "user" },
		]);
		expect(await spent("2026-09", KIDS)).toBe(beforeKids - 1000);
		expect(await spent("2026-09", GAS)).toBe(beforeGas - 1000);
	});

	it("keeps a split part's own purchase link when the refund parent is unlinked", async () => {
		await link(REFUND, PURCHASE);
		await post(`/transactions/${REFUND}/split`, [
			["part_category", String(KIDS)],
			["part_category", String(GAS)],
			["part_amount", "10"],
			["part_amount", "10"],
			["back", "/transactions"],
		]);
		const parts = await db
			.prepare("SELECT id FROM transactions WHERE parent_id = ? ORDER BY id")
			.bind(REFUND)
			.all<{ id: number }>();
		const firstPart = parts.results[0];
		if (!firstPart) throw new Error("Expected first refund part");
		// A person linked this part to a different purchase of their own.
		await db
			.prepare("UPDATE transactions SET refund_of_id = ? WHERE id = ?")
			.bind(AFTER_REFUND, firstPart.id)
			.run();
		await link(REFUND, "");
		const links = await db
			.prepare(
				"SELECT refund_of_id FROM transactions WHERE parent_id = ? ORDER BY id",
			)
			.bind(REFUND)
			.all();
		expect(links.results).toEqual([
			{ refund_of_id: AFTER_REFUND },
			{ refund_of_id: null },
		]);
	});

	it("preserves each split part's review when unlinking the refund parent", async () => {
		await link(REFUND, PURCHASE);
		await post(`/transactions/${REFUND}/split`, [
			["part_category", String(KIDS)],
			["part_category", String(GAS)],
			["part_amount", "10"],
			["part_amount", "10"],
			["back", "/transactions"],
		]);
		const parts = await db
			.prepare("SELECT id FROM transactions WHERE parent_id = ? ORDER BY id")
			.bind(REFUND)
			.all<{ id: number }>();
		expect(parts.results).toHaveLength(2);
		const firstPart = parts.results[0];
		if (!firstPart) throw new Error("Expected first refund part");
		const beforeKids = await spent("2026-09", KIDS);
		const beforeGas = await spent("2026-09", GAS);
		await save(firstPart.id, [
			["income", "0"],
			["creditReviewedVisible", "1"],
			["creditReviewed", "0"],
		]);
		await link(REFUND, "");
		const review = await db
			.prepare(
				"SELECT refund_of_id, credit_reviewed, credit_reviewed_by FROM transactions WHERE parent_id = ? ORDER BY id",
			)
			.bind(REFUND)
			.all();
		expect(review.results).toEqual([
			{ refund_of_id: null, credit_reviewed: 0, credit_reviewed_by: null },
			{ refund_of_id: null, credit_reviewed: 1, credit_reviewed_by: "user" },
		]);
		expect(await spent("2026-09", KIDS)).toBe(beforeKids);
		expect(await spent("2026-09", GAS)).toBe(beforeGas - 1000);
	});

	it("splitting a formerly linked refund does not link parts to its split parent", async () => {
		await link(REFUND, PURCHASE);
		await link(REFUND, "");
		const beforeKids = await spent("2026-09", KIDS);
		const beforeGas = await spent("2026-09", GAS);
		const { trigger } = await post(`/transactions/${REFUND}/split`, [
			["part_category", String(KIDS)],
			["part_category", String(GAS)],
			["part_amount", "10"],
			["part_amount", "10"],
			["back", "/transactions"],
		]);
		const parts = await db
			.prepare(
				"SELECT refund_of_id, category_id FROM transactions WHERE parent_id = ? ORDER BY id",
			)
			.bind(REFUND)
			.all();
		expect(parts.results).toEqual([
			{ refund_of_id: null, category_id: KIDS },
			{ refund_of_id: null, category_id: GAS },
		]);
		expect(await refundOf(REFUND)).toBeNull();
		expect(await spent("2026-09", KIDS)).toBe(beforeKids - 1000);
		expect(await spent("2026-09", GAS)).toBe(beforeGas - 1000);
		expect(trigger?.toast.message).toBe("Split Refund Shop");
	});

	it("splitting a Jev-reviewed linked refund preserves its purchase link", async () => {
		await db
			.prepare(
				"UPDATE transactions SET refund_of_id = ?, category_source = 'jev', category_confidence = 0.95, credit_reviewed = 1, credit_reviewed_by = NULL WHERE id = ?",
			)
			.bind(PURCHASE, REFUND)
			.run();
		const before = await spent("2026-08", KIDS);
		await post(`/transactions/${REFUND}/split`, [
			["part_category", String(KIDS)],
			["part_category", String(GAS)],
			["part_amount", "10"],
			["part_amount", "10"],
			["back", "/transactions"],
		]);
		const parts = await db
			.prepare(
				"SELECT refund_of_id, credit_reviewed, credit_reviewed_by FROM transactions WHERE parent_id = ? ORDER BY id",
			)
			.bind(REFUND)
			.all();
		expect(parts.results).toEqual([
			{
				refund_of_id: PURCHASE,
				credit_reviewed: 1,
				credit_reviewed_by: null,
			},
			{
				refund_of_id: PURCHASE,
				credit_reviewed: 1,
				credit_reviewed_by: null,
			},
		]);
		expect(await spent("2026-08", KIDS)).toBe(before);
	});

	it("preserves a refund link when its purchase is temporarily excluded", async () => {
		await link(REFUND, PURCHASE);
		const before = await spent("2026-08", KIDS);
		await db
			.prepare(
				"UPDATE transactions SET excluded = 1, excluded_source = 'user' WHERE id = ?",
			)
			.bind(PURCHASE)
			.run();
		await post(`/transactions/${REFUND}/split`, [
			["part_category", String(KIDS)],
			["part_category", String(GAS)],
			["part_amount", "10"],
			["part_amount", "10"],
			["back", "/transactions"],
		]);
		const parts = await db
			.prepare(
				"SELECT refund_of_id FROM transactions WHERE parent_id = ? ORDER BY id",
			)
			.bind(REFUND)
			.all();
		expect(parts.results).toEqual([
			{ refund_of_id: PURCHASE },
			{ refund_of_id: PURCHASE },
		]);
		await db
			.prepare("UPDATE transactions SET excluded = 0 WHERE id = ?")
			.bind(PURCHASE)
			.run();
		expect(await spent("2026-08", KIDS)).toBe(before);
	});

	it("retains the link of an invalidated refund until its split parts are rereviewed", async () => {
		await db
			.prepare(
				"UPDATE transactions SET refund_of_id = ?, credit_reviewed = 0, credit_reviewed_by = NULL WHERE id = ?",
			)
			.bind(PURCHASE, REFUND)
			.run();
		const before = await spent("2026-08", KIDS);
		await post(`/transactions/${REFUND}/split`, [
			["part_category", String(KIDS)],
			["part_category", String(GAS)],
			["part_amount", "10"],
			["part_amount", "10"],
			["back", "/transactions"],
		]);
		const parts = await db
			.prepare(
				"SELECT id, refund_of_id, credit_reviewed FROM transactions WHERE parent_id = ? ORDER BY id",
			)
			.bind(REFUND)
			.all<{
				id: number;
				refund_of_id: number | null;
				credit_reviewed: number;
			}>();
		expect(parts.results).toEqual([
			{ id: expect.any(Number), refund_of_id: PURCHASE, credit_reviewed: 0 },
			{ id: expect.any(Number), refund_of_id: PURCHASE, credit_reviewed: 0 },
		]);
		expect(await spent("2026-08", KIDS)).toBe(before);
		for (const part of parts.results) {
			await saveEdit(
				db,
				part.id,
				{
					categoryId: null,
					alwaysForMerchant: false,
					displayName: null,
					note: null,
					excluded: false,
					income: false,
					creditReviewed: true,
				},
				"synthetic-person",
			);
		}
		expect(await spent("2026-08", KIDS)).toBe(before - 2000);
	});

	it("says nothing extra when no refund was linked", async () => {
		const { trigger } = await post(`/transactions/${SPLIT}/split/remove`, [
			["back", "/transactions"],
		]);
		expect(trigger?.toast.message).toBe("Removed split from Refund Shop");
	});
});

describe("refund guards", () => {
	// A refund too big for the $50 purchase, two $30 ones, and a $6 one; a second $50 purchase.
	const BIG_REFUND = 9011;
	const THIRTY_A = 9012;
	const THIRTY_B = 9013;
	const SIX = 9014;
	const OTHER_PURCHASE = 9015;

	const TOO_BIG_50 =
		"This refund is more than what's left of that purchase ($50.00 left).";
	const tooBig = (left: string) =>
		`This refund is more than what's left of that purchase (${left} left).`;

	beforeEach(async () => {
		await db
			.prepare(`INSERT INTO transactions
			(id, account_id, date, amount_cents, raw_name, category_id, category_source, is_split, parent_id) VALUES
			(${BIG_REFUND}, 3, '2026-09-11', -6000, 'REFUND SHOP', ${GROCERIES}, 'user', 0, NULL),
			(${THIRTY_A}, 3, '2026-09-13', -3000, 'REFUND SHOP', ${GROCERIES}, 'user', 0, NULL),
			(${THIRTY_B}, 3, '2026-09-14', -3000, 'REFUND SHOP', ${GROCERIES}, 'user', 0, NULL),
			(${SIX}, 3, '2026-09-16', -600, 'REFUND SHOP', ${GROCERIES}, 'user', 0, NULL),
			(${OTHER_PURCHASE}, 3, '2026-09-02', 5000, 'REFUND SHOP', ${KIDS}, 'jev', 0, NULL)`)
			.run();
	});

	/** The edit panel's alert under "This refunds…", or undefined when there is none. */
	const refundAlert = (html: string) =>
		html
			.match(/<p id="refund-error" role="alert"[^>]*>([^<]*)<\/p>/)?.[1]
			?.replaceAll("&#39;", "'");

	const row = (id: number) =>
		db
			.prepare(
				"SELECT refund_of_id, note, excluded, excluded_source, credit_reviewed, credit_reviewed_by FROM transactions WHERE id = ?",
			)
			.bind(id)
			.first<{
				refund_of_id: number | null;
				note: string | null;
				excluded: number;
				excluded_source: string | null;
				credit_reviewed: number | null;
				credit_reviewed_by: string | null;
			}>();

	const EDIT = {
		categoryId: null,
		alwaysForMerchant: false,
		displayName: "Refund Shop",
		note: null,
		excluded: false,
		income: false,
		creditReviewed: false,
	};

	describe("a refund can't be more than what's left of its purchase", () => {
		it("refuses a $60 refund of a $50 purchase, with an alert, status 422 and nothing saved", async () => {
			const { res, html, trigger } = await save(BIG_REFUND, [
				["refund_of", String(PURCHASE)],
				["note", "should not save"],
			]);
			expect(res.status).toBe(422);
			expect(refundAlert(html)).toBe(TOO_BIG_50);
			// The panel is back, with the field and its error tied together and the section open.
			expect(html).toMatch(
				/<fieldset[^>]*aria-describedby="refund-error"[^>]*>\s*<legend class="sr-only">Purchase this refunds/,
			);
			expect(html).toMatch(
				/<details[^>]*\bopen\b[^>]*>\s*<summary[^>]*>[\s\S]*?This refunds…/,
			);
			// What the person chose and typed is still there to correct.
			expect(html).toMatch(
				new RegExp(`name="refund_of" value="${PURCHASE}"[^>]*checked`),
			);
			expect(html).toContain("should not save");
			expect(trigger).toBeNull();
			expect(await row(BIG_REFUND)).toMatchObject({
				refund_of_id: null,
				note: null,
			});
		});

		it("lets a refund be exactly what's left", async () => {
			await db
				.prepare("UPDATE transactions SET amount_cents = -5000 WHERE id = ?")
				.bind(BIG_REFUND)
				.run();
			const { res } = await link(BIG_REFUND, PURCHASE);
			expect(res.status).toBe(200);
			expect(await refundOf(BIG_REFUND)).toBe(PURCHASE);
		});

		it("refuses the second of two $30 refunds of a $50 purchase, saying $20.00 is left", async () => {
			const first = await link(THIRTY_A, PURCHASE);
			expect(first.res.status).toBe(200);
			const { res, html } = await save(THIRTY_B, [
				["refund_of", String(PURCHASE)],
				["note", "second"],
			]);
			expect(res.status).toBe(422);
			expect(refundAlert(html)).toBe(tooBig("$20.00"));
			expect(await row(THIRTY_B)).toMatchObject({
				refund_of_id: null,
				note: null,
			});
			// The first is untouched.
			expect(await refundOf(THIRTY_A)).toBe(PURCHASE);
		});

		it("counts every refund linked to the purchase, then refuses anything once it's all refunded", async () => {
			await link(THIRTY_A, PURCHASE);
			expect((await link(REFUND, PURCHASE)).res.status).toBe(200);
			// Nothing is left, so the panel no longer offers it, and a save that names it anyway is refused.
			const { res, html } = await link(SECOND_REFUND, PURCHASE);
			expect(res.status).toBe(422);
			expect(refundAlert(html)).toBe("Pick a purchase from the list.");
			expect(await refundOf(SECOND_REFUND)).toBeNull();
			expect(
				await saveEdit(
					db,
					SECOND_REFUND,
					{ ...EDIT, creditReviewed: true, refundOfId: PURCHASE },
					"test",
				),
			).toEqual({
				saved: false,
				refundLeftCents: 0,
			});
		});

		it("counts a refund that was excluded after it was linked", async () => {
			await link(THIRTY_A, PURCHASE);
			await db
				.prepare(
					"UPDATE transactions SET excluded = 1, excluded_source = 'user' WHERE id = ?",
				)
				.bind(THIRTY_A)
				.run();
			const { res, html } = await link(THIRTY_B, PURCHASE);
			expect(res.status).toBe(422);
			expect(refundAlert(html)).toBe(tooBig("$20.00"));
		});

		it("counts the parts of a split refund once, not the parent too", async () => {
			await link(REFUND, PURCHASE);
			await post(`/transactions/${REFUND}/split`, [
				["part_category", String(KIDS)],
				["part_category", String(GAS)],
				["part_amount", "10"],
				["part_amount", "10"],
				["back", "/transactions"],
			]);
			// $20 is refunded, as two $10 parts: $30 is left, so a $30 refund fits and then nothing does.
			expect((await link(THIRTY_A, PURCHASE)).res.status).toBe(200);
			expect(
				await saveEdit(
					db,
					SIX,
					{ ...EDIT, creditReviewed: true, refundOfId: PURCHASE },
					"test",
				),
			).toEqual({ saved: false, refundLeftCents: 0 });
		});

		it("says $0.00 left, never a negative, for a purchase that was already over-refunded", async () => {
			await db
				.prepare(
					"UPDATE transactions SET refund_of_id = ?, credit_reviewed = 1 WHERE id IN (?, ?)",
				)
				.bind(PURCHASE, BIG_REFUND, THIRTY_A)
				.run();
			expect(
				await saveEdit(
					db,
					THIRTY_B,
					{ ...EDIT, creditReviewed: true, refundOfId: PURCHASE },
					"test",
				),
			).toEqual({ saved: false, refundLeftCents: 0 });
		});

		it("lets a refund be unlinked from an over-refunded purchase", async () => {
			await db
				.prepare(
					"UPDATE transactions SET refund_of_id = ?, credit_reviewed = 1 WHERE id IN (?, ?)",
				)
				.bind(PURCHASE, BIG_REFUND, THIRTY_A)
				.run();
			const { res } = await link(BIG_REFUND, "");
			expect(res.status).toBe(200);
			expect(await refundOf(BIG_REFUND)).toBeNull();
		});

		it("compares in integer cents: 334 + 334 + 333 is exactly $10.01", async () => {
			await db.batch([
				db
					.prepare("UPDATE transactions SET amount_cents = 1001 WHERE id = ?")
					.bind(PURCHASE),
				db
					.prepare("UPDATE transactions SET amount_cents = -334 WHERE id = ?")
					.bind(THIRTY_A),
				db
					.prepare("UPDATE transactions SET amount_cents = -334 WHERE id = ?")
					.bind(THIRTY_B),
				db
					.prepare("UPDATE transactions SET amount_cents = -333 WHERE id = ?")
					.bind(SIX),
			]);
			expect((await link(THIRTY_A, PURCHASE)).res.status).toBe(200);
			expect((await link(THIRTY_B, PURCHASE)).res.status).toBe(200);
			expect((await link(SIX, PURCHASE)).res.status).toBe(200);
		});

		it("refuses a refund one cent over what's left, and says so to the cent", async () => {
			await db.batch([
				db
					.prepare("UPDATE transactions SET amount_cents = 1001 WHERE id = ?")
					.bind(PURCHASE),
				db
					.prepare("UPDATE transactions SET amount_cents = -334 WHERE id = ?")
					.bind(THIRTY_A),
				db
					.prepare("UPDATE transactions SET amount_cents = -334 WHERE id = ?")
					.bind(THIRTY_B),
				db
					.prepare("UPDATE transactions SET amount_cents = -334 WHERE id = ?")
					.bind(SIX),
			]);
			await link(THIRTY_A, PURCHASE);
			await link(THIRTY_B, PURCHASE);
			const { res, html } = await link(SIX, PURCHASE);
			expect(res.status).toBe(422);
			expect(refundAlert(html)).toBe(tooBig("$3.33"));
		});
	});

	describe("a refund of a split part is checked against the part", () => {
		it("refuses a $20 refund of a $10 part, though the whole split is $30", async () => {
			const { res, html } = await link(REFUND, PART_KIDS);
			expect(res.status).toBe(422);
			expect(refundAlert(html)).toBe(tooBig("$10.00"));
			expect(await refundOf(REFUND)).toBeNull();
		});

		it("takes a refund that fits the part, then counts it against that part only", async () => {
			expect((await link(SECOND_REFUND, PART_KIDS)).res.status).toBe(200);
			// $5 of the $10 part is refunded, so a $6 refund no longer fits, and says $5.00 is left.
			const { res, html } = await link(SIX, PART_KIDS);
			expect(res.status).toBe(422);
			expect(refundAlert(html)).toBe(tooBig("$5.00"));
			// The other part still has all of its $20.
			expect((await link(REFUND, PART_HOUSEHOLD)).res.status).toBe(200);
		});
	});

	describe("re-linking and saving again", () => {
		it("re-saving the same link passes, even when the purchase is fully refunded", async () => {
			await link(THIRTY_A, PURCHASE);
			await link(REFUND, PURCHASE);
			// $50 of $50 is refunded; saving the $30's own link again isn't asking for more.
			const { res, html } = await save(THIRTY_A, [
				["refund_of", String(PURCHASE)],
				["note", "same link"],
			]);
			expect(res.status).toBe(200);
			expect(refundAlert(html)).toBeUndefined();
			expect(await row(THIRTY_A)).toMatchObject({
				refund_of_id: PURCHASE,
				note: "same link",
			});
		});

		it("saveEdit with the link it already has is saved, not counted against itself", async () => {
			await link(THIRTY_A, PURCHASE);
			await link(REFUND, PURCHASE);
			expect(
				await saveEdit(
					db,
					THIRTY_A,
					{ ...EDIT, creditReviewed: true, refundOfId: PURCHASE },
					"test",
				),
			).toEqual({ saved: true });
			expect(await refundOf(THIRTY_A)).toBe(PURCHASE);
		});

		it("moving a refund to another purchase isn't held back by its old link, and frees the old one", async () => {
			// $50 is fully refunded by $30 and $20.
			await link(THIRTY_A, PURCHASE);
			await link(REFUND, PURCHASE);
			expect((await link(THIRTY_B, PURCHASE)).res.status).toBe(422);
			expect(await refundOf(THIRTY_B)).toBeNull();
			// The $30 moves to the other $50 purchase: its old link isn't counted there.
			const moved = await link(THIRTY_A, OTHER_PURCHASE);
			expect(moved.res.status).toBe(200);
			expect(await refundOf(THIRTY_A)).toBe(OTHER_PURCHASE);
			// And the first purchase has $30 left again.
			expect((await link(THIRTY_B, PURCHASE)).res.status).toBe(200);
		});

		it("is checked against the new purchase when it moves, and stays where it was if refused", async () => {
			await link(THIRTY_A, PURCHASE);
			await link(REFUND, OTHER_PURCHASE);
			await link(SIX, OTHER_PURCHASE);
			// $24 is left of the other purchase; moving a $30 refund there is too much.
			const { res, html } = await link(THIRTY_A, OTHER_PURCHASE);
			expect(res.status).toBe(422);
			expect(refundAlert(html)).toBe(tooBig("$24.00"));
			expect(await refundOf(THIRTY_A)).toBe(PURCHASE);
		});
	});

	describe("linking a refund includes it in the budget", () => {
		const excludeAsJev = () =>
			db
				.prepare(
					"UPDATE transactions SET flag_reimbursement = 1, excluded = 1, excluded_source = 'jev' WHERE id = ?",
				)
				.bind(REFUND)
				.run();

		it("an excluded refund counts once it's linked, as the person's choice", async () => {
			await excludeAsJev();
			const before = await spent("2026-08", KIDS);
			// The panel posts the Exclude chip as it was drawn, checked.
			const { res, trigger } = await save(REFUND, [
				["refund_of", String(PURCHASE)],
				["excluded", "1"],
			]);
			expect(res.status).toBe(200);
			expect(await row(REFUND)).toMatchObject({
				refund_of_id: PURCHASE,
				excluded: 0,
				excluded_source: "user",
			});
			// It counts, in its purchase's month and category.
			expect(await spent("2026-08", KIDS)).toBe(before - 2000);
			expect(trigger?.announce).toContain("It counts in the budget again.");
		});

		it("includes it when the form says nothing about exclusion", async () => {
			await excludeAsJev();
			await link(REFUND, PURCHASE);
			expect(await row(REFUND)).toMatchObject({
				excluded: 0,
				excluded_source: "user",
			});
		});

		it("includes an excluded refund through saveEdit too, whatever it is asked to hold", async () => {
			await excludeAsJev();
			expect(
				await saveEdit(
					db,
					REFUND,
					{
						...EDIT,
						excluded: true,
						creditReviewed: true,
						refundOfId: PURCHASE,
					},
					"test",
				),
			).toEqual({ saved: true });
			expect(await row(REFUND)).toMatchObject({
				excluded: 0,
				excluded_source: "user",
			});
		});

		it("leaves an excluded refund excluded when the link is refused", async () => {
			await db
				.prepare(
					"UPDATE transactions SET flag_reimbursement = 1, excluded = 1, excluded_source = 'jev' WHERE id = ?",
				)
				.bind(BIG_REFUND)
				.run();
			const { res } = await save(BIG_REFUND, [
				["refund_of", String(PURCHASE)],
				["excluded", "1"],
			]);
			expect(res.status).toBe(422);
			expect(await row(BIG_REFUND)).toMatchObject({
				refund_of_id: null,
				excluded: 1,
				excluded_source: "jev",
			});
		});

		it("doesn't touch an included refund's exclusion source when it's linked", async () => {
			await link(REFUND, PURCHASE);
			expect(await row(REFUND)).toMatchObject({
				excluded: 0,
				excluded_source: null,
			});
		});

		it("respects excluding a linked refund afterwards, while the link is unchanged", async () => {
			await link(REFUND, PURCHASE);
			await save(REFUND, [
				["refund_of", String(PURCHASE)],
				["excluded", "1"],
			]);
			expect(await row(REFUND)).toMatchObject({
				refund_of_id: PURCHASE,
				excluded: 1,
				excluded_source: "user",
			});
		});

		it("marks the credit reviewed even when the panel's review chip is left unticked", async () => {
			await db
				.prepare(
					"UPDATE transactions SET credit_reviewed = 0, credit_reviewed_by = NULL WHERE id = ?",
				)
				.bind(REFUND)
				.run();
			const before = await spent("2026-08", KIDS);
			const { res } = await save(REFUND, [
				["refund_of", String(PURCHASE)],
				["creditReviewedVisible", "1"],
			]);
			expect(res.status).toBe(200);
			expect(await row(REFUND)).toMatchObject({
				refund_of_id: PURCHASE,
				credit_reviewed: 1,
				credit_reviewed_by: "user",
			});
			expect(await spent("2026-08", KIDS)).toBe(before - 2000);
		});
	});

	describe("the write checks the amount itself", () => {
		it("saveEdit refuses a link that doesn't fit, returning what's left and writing nothing", async () => {
			const result = await saveEdit(
				db,
				BIG_REFUND,
				{
					...EDIT,
					note: "should not save",
					creditReviewed: true,
					refundOfId: PURCHASE,
				},
				"test",
			);
			expect(result).toEqual({ saved: false, refundLeftCents: 5000 });
			expect(await row(BIG_REFUND)).toMatchObject({
				refund_of_id: null,
				note: null,
				credit_reviewed: null,
			});
		});

		it("saveEdit leaves a split refund's parts where they were when the link is refused", async () => {
			// A $60 refund, split in two $30 parts, can't be moved to the $50 purchase.
			await post(`/transactions/${BIG_REFUND}/split`, [
				["part_category", String(KIDS)],
				["part_category", String(GAS)],
				["part_amount", "30"],
				["part_amount", "30"],
				["back", "/transactions"],
			]);
			expect(
				await saveEdit(
					db,
					BIG_REFUND,
					{ ...EDIT, refundOfId: PURCHASE },
					"test",
				),
			).toEqual({ saved: false, refundLeftCents: 5000 });
			const { results } = await db
				.prepare("SELECT refund_of_id FROM transactions WHERE parent_id = ?")
				.bind(BIG_REFUND)
				.all();
			expect(results).toEqual([{ refund_of_id: null }, { refund_of_id: null }]);
		});

		it("of two saves at once, only the one that fits is saved", async () => {
			const [a, b] = await Promise.all([
				saveEdit(
					db,
					THIRTY_A,
					{ ...EDIT, creditReviewed: true, refundOfId: PURCHASE },
					"a",
				),
				saveEdit(
					db,
					THIRTY_B,
					{ ...EDIT, creditReviewed: true, refundOfId: PURCHASE },
					"b",
				),
			]);
			expect([a.saved, b.saved].sort()).toEqual([false, true]);
			const refused = a.saved ? b : a;
			expect(refused).toEqual({ saved: false, refundLeftCents: 2000 });
			const { results } = await db
				.prepare(
					"SELECT id FROM transactions WHERE refund_of_id = ? ORDER BY id",
				)
				.bind(PURCHASE)
				.all();
			expect(results).toHaveLength(1);
		});

		it("of two panel saves at once, only the one that fits is saved", async () => {
			const [a, b] = await Promise.all([
				link(THIRTY_A, PURCHASE),
				link(THIRTY_B, PURCHASE),
			]);
			expect([a.res.status, b.res.status].sort()).toEqual([200, 422]);
			const { results } = await db
				.prepare("SELECT id FROM transactions WHERE refund_of_id = ?")
				.bind(PURCHASE)
				.all();
			expect(results).toHaveLength(1);
		});
	});

	describe("the purchases a refund is offered", () => {
		const ids = async (id: number) =>
			(await refundPurchases(db, await detail(id))).map((p) => p.id);

		it("leaves out a purchase with nothing left to refund", async () => {
			await link(THIRTY_A, PURCHASE);
			await link(REFUND, PURCHASE);
			expect(await ids(SECOND_REFUND)).not.toContain(PURCHASE);
			const { html } = await get(`/transactions/${SECOND_REFUND}`);
			expect(html).not.toContain("Aug 20 · $50.00");
			expect(html).toContain("Sep 2 · $50.00");
		});

		it("still offers a purchase with some left, even less than the refund", async () => {
			await link(THIRTY_A, PURCHASE);
			expect(await ids(BIG_REFUND)).toContain(PURCHASE);
			expect(await ids(THIRTY_B)).toContain(PURCHASE);
		});

		it("always offers the purchase a refund is linked to, even when that purchase is fully refunded", async () => {
			await link(THIRTY_A, PURCHASE);
			await link(REFUND, PURCHASE);
			expect(await ids(THIRTY_A)).toContain(PURCHASE);
			expect(await ids(REFUND)).toContain(PURCHASE);
			const { html } = await get(`/transactions/${THIRTY_A}`);
			expect(html).toMatch(
				new RegExp(`name="refund_of" value="${PURCHASE}"[^>]*checked`),
			);
		});

		it("offers a purchase again once a refund is unlinked", async () => {
			await link(THIRTY_A, PURCHASE);
			await link(REFUND, PURCHASE);
			await link(THIRTY_A, "");
			expect(await ids(SECOND_REFUND)).toContain(PURCHASE);
		});
	});
});

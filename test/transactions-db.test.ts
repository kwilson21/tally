import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { summarizeMonth } from "../src/budget";
import { loadMonth } from "../src/db/month";
import {
	getTransaction,
	listTransactions,
	monthsWithTransactions,
	needsCategoryCount,
	olderNeedsCategoryCount,
	PAGE_SIZE,
} from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { parseFilters } from "../src/transactions/filters";

const TODAY = "2026-09-22";
const list = (qs: string) =>
	listTransactions(env.DB, parseFilters(new URLSearchParams(qs), "2026-09"));

beforeEach(async () => {
	await resetDemo(env.DB, TODAY);
});

describe("listTransactions", () => {
	it("partitions Needs category between this month and older counted months", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 1 WHERE category_id IS NULL",
		).run();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(89,'Earlier bill',1000,1,'monthly','EARLIER BILL')",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 890,id,'2026-09-10',1000,'EARLIER BILL' FROM accounts LIMIT 1",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(89,'2026-08',890,'user','linked')",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 891,id,'2026-08-10',1000,'PLAIN OLD' FROM accounts LIMIT 1",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 892,id,'2026-09-11',1000,'PLAIN CURRENT' FROM accounts LIMIT 1",
			),
		]);

		const needs = await list("month=all&uncategorized=1");
		expect(needs.rows.map((row) => row.id).sort()).toEqual([890, 891, 892]);
		expect(await needsCategoryCount(env.DB, "2026-09")).toBe(1);
		expect(await olderNeedsCategoryCount(env.DB, "2026-09-01")).toBe(2);
		expect(
			(await needsCategoryCount(env.DB, "2026-09")) +
				(await olderNeedsCategoryCount(env.DB, "2026-09-01")),
		).toBe(needs.total);
	});

	it("keeps an early payment in its bank month and moves a late payment to its occurrence month", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,anchor_month,merchant_raw_name) VALUES(90,'Early',1000,1,'monthly',NULL,'EARLY'),(91,'Late yearly',2000,31,'yearly',8,'LATE')",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 900,id,'2026-09-28',1000,'EARLY' FROM accounts LIMIT 1",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 901,id,'2026-09-02',2000,'LATE' FROM accounts LIMIT 1",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(90,'2026-10',900,'user','linked'),(91,'2026',901,'user','linked')",
			),
		]);
		const september = await list("month=2026-09");
		expect(september.rows.some((row) => row.id === 900)).toBe(true);
		expect(september.rows.some((row) => row.id === 901)).toBe(false);
		const august = await list("month=2026-08");
		expect(august.rows.find((row) => row.id === 901)?.countsInMonth).toBe(
			"2026-08",
		);
		expect((await getTransaction(env.DB, 901))?.countsInMonth).toBe("2026-08");
	});
	// September has 43: 39 others, the demo's three Daycare Fridays (Sept 4, 11 and 18), and Rent's $600 on the 1st.
	it("lists this month newest first, one page at a time", async () => {
		const first = await list("");
		expect(first).toMatchObject({ total: 43, page: 1, pages: 2 });
		expect(first.rows).toHaveLength(PAGE_SIZE);
		const second = await list("page=2");
		expect(second).toMatchObject({ total: 43, page: 2, pages: 2 });
		expect(second.rows).toHaveLength(43 - PAGE_SIZE);
		const dates = [...first.rows, ...second.rows].map((r) => r.date);
		expect(dates).toEqual([...dates].sort().reverse());
		expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(
			43,
		);
	});

	it("shows the last page when asked for one past the end", async () => {
		const { page, rows } = await list("page=99");
		expect(page).toBe(2);
		expect(rows).toHaveLength(43 - PAGE_SIZE);
	});

	it("has one empty page when nothing matches", async () => {
		expect(await list("q=zzz")).toMatchObject({
			rows: [],
			total: 0,
			page: 1,
			pages: 1,
		});
	});

	it("filters to what needs a category, matching Home's count", async () => {
		const { rows } = await list("uncategorized=1");
		expect(rows).toHaveLength(10);
		expect(rows.every((r) => r.categoryId === null && !r.income)).toBe(true);
		expect(await needsCategoryCount(env.DB, "2026-09")).toBe(10);
		const data = await loadMonth(env.DB, "2026-09");
		const home = summarizeMonth({
			month: "2026-09",
			...data,
			unpaidDueBillsCents: 0,
		});
		expect(home.uncategorized.count).toBe(10);
	});

	it("filters to excluded only", async () => {
		const { rows } = await list("show=excluded");
		expect(rows.map((r) => r.displayName).sort()).toEqual([
			"Reimbursement, doctor's office",
			"Transfer to Savings",
		]);
	});

	it("filters by category", async () => {
		const { rows } = await list("category=1");
		expect(rows).toHaveLength(5);
		expect(rows.every((r) => !r.isSplit)).toBe(true);
		expect(rows.every((r) => r.categoryName === "Groceries")).toBe(true);
	});

	it("searches display name and raw name, and treats % literally", async () => {
		expect((await list("q=bakery")).rows.map((r) => r.displayName)).toEqual([
			"Local Bakery",
		]);
		expect((await list("q=SQ%20*LOCAL")).rows).toHaveLength(1);
		expect((await list("q=%25")).rows).toHaveLength(0);
	});

	it("searches an unnamed merchant's raw text, even though the list shows its tidied name", async () => {
		const { rows } = await list("q=DOORDASH");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			rawName: "DD *DOORDASH TACO",
			displayName: "Doordash taco",
		});
	});

	it("finds an unnamed merchant by the full name it shows, where a * joins the words", async () => {
		const { rows } = await list("q=google%20youtube");
		expect(rows.map((r) => r.displayName)).toEqual(["Google youtube"]);
	});

	it("searches notes", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET note = 'birthday cake' WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).run();
		expect((await list("q=cake")).rows).toHaveLength(1);
	});

	it("searches every month when asked", async () => {
		const { rows } = await list("month=all&q=trader");
		expect(rows.length).toBeLessThanOrEqual(PAGE_SIZE);
		expect(new Set(rows.map((r) => r.date.slice(0, 7))).size).toBe(6);
		expect(rows.every((r) => r.displayName === "Trader Joe's")).toBe(true);
	});

	it("carries the category's look for the row icon", async () => {
		const { rows } = await list("category=2");
		expect(rows[0]).toMatchObject({
			categoryName: "Eating Out",
			categoryIcon: "eating-out",
			categoryColor: "cat-plum",
		});
	});
});

describe("monthsWithTransactions", () => {
	it("returns the six seeded months, newest first", async () => {
		expect(await monthsWithTransactions(env.DB)).toEqual([
			"2026-09",
			"2026-08",
			"2026-07",
			"2026-06",
			"2026-05",
			"2026-04",
		]);
	});

	it("uses the counted month rather than the bank month", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(92,'Moved',1000,30,'monthly','MOVED')",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 902,id,'2026-10-02',1000,'MOVED' FROM accounts LIMIT 1",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(92,'2026-09',902,'user','linked')",
			),
		]);
		const months = await monthsWithTransactions(env.DB);
		expect(months).not.toContain("2026-10");
		expect(months).toContain("2026-09");
	});
});

describe("listTransactions: search by amount and category (#211)", () => {
	/** One transaction on the first account, all dated the same day, so the newest id lists first. */
	const insert = (
		id: number,
		amountCents: number,
		rawName: string,
		categoryId: number | null = null,
	) =>
		env.DB.prepare(
			"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id) SELECT ?,id,'2026-09-15',?,?,? FROM accounts LIMIT 1",
		).bind(id, amountCents, rawName, categoryId);

	/** The ids the search finds among this test's rows, newest first. */
	const found = async (qs: string) =>
		(await list(qs)).rows.map((row) => row.id).filter((id) => id >= 99200);

	it("finds exactly the cents a number names, money out and money in alike (decision 79)", async () => {
		await env.DB.batch([
			insert(99201, 4217, "PURCHASE ONE"),
			insert(99202, -4217, "CREDIT ONE"),
			insert(99203, 4216, "ONE CENT LESS"),
			insert(99204, 42170, "TEN TIMES"),
		]);
		expect(await found("q=42.17&month=all")).toEqual([99202, 99201]);
	});

	it("finds every amount in the dollar for $42 and for 42, and nothing outside it", async () => {
		await env.DB.batch([
			insert(99211, 4200, "DOLLAR LOW"),
			insert(99212, 4299, "DOLLAR HIGH"),
			insert(99213, 4199, "JUST BELOW"),
			insert(99214, 4300, "JUST ABOVE"),
			insert(99215, -4250, "CREDIT IN THE DOLLAR"),
		]);
		expect(await found("q=%2442&month=all")).toEqual([99215, 99212, 99211]);
		expect(await found("q=42&month=all")).toEqual([99215, 99212, 99211]);
	});

	it("matches names and notes with the digits for a plain number, but not for $42 (#211)", async () => {
		await env.DB.batch([
			insert(99216, -1000, "STORE 42 CAFE"),
			insert(99217, 1000, "NOT THE DIGITS"),
		]);
		expect(await found("q=42&month=all")).toEqual([99216]);
		expect(await found("q=%2442&month=all")).toEqual([]);
	});

	it("says every row matched by amount for a plain number only when every row did (#211)", async () => {
		await env.DB.batch([
			insert(99240, 1000, "STORE 42 CAFE"),
			insert(99241, 4250, "BIG PURCHASE"),
		]);
		// STORE 42 CAFE matched by its name, so the count may not claim every row matched by amount.
		const mixed = await list("q=42&month=all");
		expect(await found("q=42&month=all")).toEqual([99241, 99240]);
		expect(mixed.matched.allByAmount).toBe(false);
		// The demo's own rows match "42" by their words too, so an amount-only check uses a number they don't.
		await env.DB.batch([insert(99242, 913750, "NINE ROW")]);
		expect((await list("q=9137&month=all")).matched.allByAmount).toBe(true);
		// $42 searches amounts alone, so every row it finds matched by amount.
		expect((await list("q=%2442&month=all")).matched.allByAmount).toBe(true);
		// A search of words alone has no amount to match.
		expect((await list("q=stor&month=all")).matched.allByAmount).toBe(false);
	});

	it("finds rows in a category by the category's name, in every month", async () => {
		await env.DB.batch([insert(99220, 1500, "GROCER ROW", 1)]);
		const { rows } = await list("q=groceries&month=all");
		expect(rows.some((row) => row.id === 99220)).toBe(true);
		expect(rows.every((row) => row.categoryName === "Groceries")).toBe(true);
	});

	it("reports a category match only when a row in that category matched, archived or not (#211)", async () => {
		await env.DB.prepare(
			"INSERT INTO categories (id, name, icon, color, sort_order) VALUES (99300, 'Zebra Care', 'gas', 'cat-slate', 99)",
		).run();
		await insert(99230, 1200, "ZEBRA SHOP", 1).run();
		expect((await list("q=zebra&month=all")).matched.category).toBe(false);
		await insert(99231, 1300, "NOT THE NAME", 99300).run();
		expect((await list("q=zebra&month=all")).matched.category).toBe(true);
		await env.DB.prepare(
			"UPDATE categories SET archived = 1 WHERE id = 99300",
		).run();
		expect((await list("q=zebra&month=all")).matched.category).toBe(true);
	});

	it("never reports a category match for an amount or a raw-view search (#211)", async () => {
		await insert(99232, 4217, "AMOUNT ROW", 1).run();
		expect((await list("q=42.17&month=all")).matched.category).toBe(false);
		const raw = await listTransactions(
			env.DB,
			parseFilters(
				new URLSearchParams("q=groceries&month=all&raw=1"),
				"2026-09",
				true,
			),
		);
		expect(raw.matched.category).toBe(false);
	});
});

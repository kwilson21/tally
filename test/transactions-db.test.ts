import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { summarizeMonth } from "../src/budget";
import { loadMonth } from "../src/db/month";
import {
	listTransactions,
	monthsWithTransactions,
	needsCategoryCount,
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
	it("lists this month newest first, one page at a time", async () => {
		const first = await list("");
		expect(first).toMatchObject({ total: 35, page: 1, pages: 2 });
		expect(first.rows).toHaveLength(PAGE_SIZE);
		const second = await list("page=2");
		expect(second).toMatchObject({ total: 35, page: 2, pages: 2 });
		expect(second.rows).toHaveLength(35 - PAGE_SIZE);
		const dates = [...first.rows, ...second.rows].map((r) => r.date);
		expect(dates).toEqual([...dates].sort().reverse());
		expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(
			35,
		);
	});

	it("shows the last page when asked for one past the end", async () => {
		const { page, rows } = await list("page=99");
		expect(page).toBe(2);
		expect(rows).toHaveLength(35 - PAGE_SIZE);
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
		expect(rows).toHaveLength(12);
		expect(rows.every((r) => r.categoryId === null && !r.income)).toBe(true);
		expect(await needsCategoryCount(env.DB, "2026-09")).toBe(12);
		const data = await loadMonth(env.DB, "2026-09");
		const home = summarizeMonth({
			month: "2026-09",
			...data,
			unpaidDueBillsCents: 0,
		});
		expect(home.uncategorized.count).toBe(12);
	});

	it("filters to excluded only", async () => {
		const { rows } = await list("excluded=1");
		expect(rows.map((r) => r.displayName).sort()).toEqual([
			"Reimbursement, doctor's office",
			"Transfer to Savings",
		]);
	});

	it("filters by category", async () => {
		const { rows } = await list("category=1");
		expect(rows).toHaveLength(4);
		expect(rows.every((r) => r.categoryName === "Groceries")).toBe(true);
	});

	it("searches display name and raw name, and treats % literally", async () => {
		expect((await list("q=bakery")).rows.map((r) => r.displayName)).toEqual([
			"Local Bakery",
		]);
		expect((await list("q=SQ%20*LOCAL")).rows).toHaveLength(1);
		expect((await list("q=%25")).rows).toHaveLength(0);
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
});

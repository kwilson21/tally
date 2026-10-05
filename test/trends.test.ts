import { describe, expect, it } from "vitest";
import type { BudgetAmount } from "../src/budget";
import {
	buildTrends,
	changeWords,
	compareSentence,
	type MonthSpend,
	miniBars,
	monthBars,
	monthsLabel,
	RUN_MONTHS,
	risingRun,
	sameDays,
	sameDaysCaption,
	shownMonths,
	TREND_MONTHS,
	type TrendCategory,
	type TrendsInput,
	trendsAmount,
	underBudgetRun,
} from "../src/trends";

describe("the rules' numbers", () => {
	it("draws six months and needs a run of three", () => {
		expect(TREND_MONTHS).toBe(6);
		expect(RUN_MONTHS).toBe(3);
	});
});

describe("trendsAmount", () => {
	it.each([
		[0, "$0"],
		[99, "$0.99"],
		[100, "$1"],
		[12345, "$123"],
		[1234500, "$12,345"],
		[-2000, "-$20"],
	])("%i cents is %s", (cents, text) => expect(trendsAmount(cents)).toBe(text));
});

describe("sameDays", () => {
	it("compares days 1 to today's day with the same days last month", () => {
		expect(sameDays("2026-10-05")).toEqual({
			month: "2026-10",
			lastMonth: "2026-09",
			day: 5,
			lastDay: 5,
			lastThrough: "2026-09-05",
		});
	});

	it("clamps to last month's length", () => {
		expect(sameDays("2026-03-31")).toMatchObject({
			lastMonth: "2026-02",
			day: 31,
			lastDay: 28,
			lastThrough: "2026-02-28",
		});
		expect(sameDays("2028-03-30")).toMatchObject({
			lastDay: 29,
			lastThrough: "2028-02-29",
		});
		expect(sameDays("2026-05-31")).toMatchObject({
			lastMonth: "2026-04",
			lastDay: 30,
		});
	});

	it("goes back over the new year", () => {
		expect(sameDays("2026-01-15")).toMatchObject({
			lastMonth: "2025-12",
			lastThrough: "2025-12-15",
		});
	});

	it("is just the 1st on the 1st", () => {
		expect(sameDays("2026-10-01")).toMatchObject({
			day: 1,
			lastDay: 1,
			lastThrough: "2026-09-01",
		});
	});
});

describe("sameDaysCaption", () => {
	it("names both ranges", () => {
		expect(sameDaysCaption("2026-10-05")).toBe("Oct 1–5 against Sep 1–5");
	});
	it("names a single day on the 1st", () => {
		expect(sameDaysCaption("2026-10-01")).toBe("Oct 1 against Sep 1");
	});
	it("shows the clamp: this month's days against all of a shorter month", () => {
		expect(sameDaysCaption("2026-03-31")).toBe("Mar 1–31 against Feb 1–28");
	});
});

describe("compareSentence", () => {
	it("says how much less", () => {
		expect(compareSentence(124000, 133000, "2026-09")).toBe(
			"$90 less than by this time in September.",
		);
	});
	it("says how much more", () => {
		expect(compareSentence(133000, 124000, "2026-09")).toBe(
			"$90 more than by this time in September.",
		);
	});
	it("says about the same when the gap is under a dollar, or none", () => {
		expect(compareSentence(1000, 1050, "2026-09")).toBe(
			"About the same as by this time in September.",
		);
		expect(compareSentence(0, 0, "2026-09")).toBe(
			"About the same as by this time in September.",
		);
	});
	it("uses whole dollars and commas for a big gap", () => {
		expect(compareSentence(1234500, 0, "2025-12")).toBe(
			"$12,345 more than by this time in December.",
		);
	});
});

describe("changeWords", () => {
	it("is an arrow's word and a dollar amount", () => {
		expect(changeWords(19600, 22400)).toEqual({
			direction: "down",
			words: "Down $28",
		});
		expect(changeWords(9200, 6100)).toEqual({
			direction: "up",
			words: "Up $31",
		});
	});
	it("shows cents under a dollar, so it never says $0", () => {
		expect(changeWords(1030, 1000)).toEqual({
			direction: "up",
			words: "Up $0.30",
		});
	});
	it("says no change, with no arrow", () => {
		expect(changeWords(5000, 5000)).toEqual({
			direction: "same",
			words: "No change",
		});
	});
});

describe("underBudgetRun", () => {
	it("counts the months running up to the latest", () => {
		expect(underBudgetRun([10, 20, 30, 40], [50, 50, 50, 50])).toBe(4);
		expect(underBudgetRun([90, 20, 30, 40], [50, 50, 50, 50])).toBe(3);
		expect(underBudgetRun([10, 20, 90, 40], [50, 50, 50, 50])).toBe(1);
		expect(underBudgetRun([10, 20, 30, 90], [50, 50, 50, 50])).toBe(0);
	});
	it("counts a month exactly at its budget, as Home does (over is more than the budget)", () => {
		expect(underBudgetRun([50, 50, 50], [50, 50, 50])).toBe(3);
		expect(underBudgetRun([50, 50, 51], [50, 50, 50])).toBe(0);
	});
	it("judges each month against the budget it had", () => {
		// Eating Out: $200 until June, $250 from July.
		expect(underBudgetRun([19500, 21500, 24000], [20000, 25000, 25000])).toBe(
			3,
		);
		expect(underBudgetRun([19500, 21500, 24000], [20000, 20000, 20000])).toBe(
			0,
		);
	});
	it("stops at a month with no budget", () => {
		expect(underBudgetRun([10, 10, 10, 10], [null, 50, 50, 50])).toBe(3);
		expect(underBudgetRun([10, 10, 10, 10], [50, 50, null, 50])).toBe(1);
		expect(underBudgetRun([10], [null])).toBe(0);
	});
	it("is 0 for no months", () => {
		expect(underBudgetRun([], [])).toBe(0);
	});
});

describe("risingRun", () => {
	it("counts the months in a row that went up on the one before", () => {
		// Eating Out, June to September: up three times.
		expect(risingRun([24500, 28000, 31800, 36500])).toBe(3);
		expect(risingRun([21000, 24500, 28000, 31800, 36500])).toBe(4);
		expect(risingRun([300, 200, 300, 400])).toBe(2);
	});
	it("stops when a month is the same or lower", () => {
		expect(risingRun([100, 200, 200])).toBe(0);
		expect(risingRun([100, 300, 200, 250])).toBe(1);
	});
	it("is 0 with fewer than two months", () => {
		expect(risingRun([])).toBe(0);
		expect(risingRun([500])).toBe(0);
	});
});

describe("shownMonths", () => {
	it("is the six months ending with this one", () => {
		expect(shownMonths("2026-10-05", "2026-01")).toEqual([
			"2026-05",
			"2026-06",
			"2026-07",
			"2026-08",
			"2026-09",
			"2026-10",
		]);
	});
	it("starts at the month Tally's history starts when that's later", () => {
		expect(shownMonths("2026-10-05", "2026-09")).toEqual([
			"2026-09",
			"2026-10",
		]);
		expect(shownMonths("2026-10-05", "2026-10")).toEqual(["2026-10"]);
	});
	it("crosses the new year", () => {
		expect(shownMonths("2027-02-03", "2026-01")).toEqual([
			"2026-09",
			"2026-10",
			"2026-11",
			"2026-12",
			"2027-01",
			"2027-02",
		]);
	});
	it("always has this month", () => {
		expect(shownMonths("2026-10-05", "2026-12")).toEqual(["2026-10"]);
	});
});

describe("monthsLabel", () => {
	it("says each month's amount in words, the one going as 'so far'", () => {
		expect(
			monthsLabel(
				[
					{ month: "2026-09", cents: 86000, partial: false },
					{ month: "2026-10", cents: 19600, partial: true },
				],
				"Spending",
			),
		).toBe("Spending by month: September $860, October so far $196.");
	});
});

describe("miniBars", () => {
	it("scales to the tallest month, six slots of 16 on a 96 by 32 drawing", () => {
		const bars = miniBars([100, 200, 100, 400, 300, 100]);
		expect(bars.map((b) => b.x)).toEqual([3, 19, 35, 51, 67, 83]);
		expect(bars.map((b) => b.width)).toEqual([10, 10, 10, 10, 10, 10]);
		expect(bars.map((b) => b.height)).toEqual([7.5, 15, 7.5, 30, 22.5, 7.5]);
		expect(bars.map((b) => b.y)).toEqual([23.5, 16, 23.5, 1, 8.5, 23.5]);
	});
	it("dashes only the last, the month still going", () => {
		expect(miniBars([1, 2, 3]).map((b) => b.dashed)).toEqual([
			false,
			false,
			true,
		]);
	});
	it("sits a short history at the right, where the latest months are", () => {
		expect(miniBars([100, 200]).map((b) => b.x)).toEqual([67, 83]);
	});
	it("keeps a month with nothing (or less than nothing) as a thin line, never NaN", () => {
		expect(miniBars([0, 0, 0]).map((b) => b.height)).toEqual([1, 1, 1]);
		expect(miniBars([-500, 200]).map((b) => b.height)).toEqual([1, 30]);
	});
	it("is empty for no months", () => {
		expect(miniBars([])).toEqual([]);
	});
});

describe("monthBars", () => {
	it("draws each month taller by its amount and labels the one going 'so far'", () => {
		const bars = monthBars([
			{ month: "2026-09", cents: 286000, partial: false },
			{ month: "2026-10", cents: 124000, partial: true },
		]);
		expect(bars).toHaveLength(2);
		expect(bars[0]).toMatchObject({
			amount: "$2,860",
			label: "Sep",
			dashed: false,
			height: 124,
		});
		expect(bars[1]).toMatchObject({
			amount: "$1,240",
			label: "Oct so far",
			dashed: true,
			height: 53.8,
		});
		// A short history sits at the right.
		expect(bars[0]?.x).toBeGreaterThan(200);
		expect((bars[1]?.x ?? 0) > (bars[0]?.x ?? 0)).toBe(true);
	});
	it("keeps a bar for no spending as a sliver", () => {
		const [bar] = monthBars([{ month: "2026-10", cents: 0, partial: true }]);
		expect(bar?.height).toBe(2);
	});
});

// ---------------------------------------------------------------------------------------------
// buildTrends: the page's numbers and sentences from rows (spec §8.3).

const GROCERIES = 1;
const EATING_OUT = 2;
const KIDS = 3;
const GAS = 4;
const HOUSEHOLD = 5;
const OLD = 6;

const category = (
	id: number,
	name: string,
	archived = false,
): TrendCategory => ({ id, name, icon: "list", color: "cat-blue", archived });

const CATEGORIES: TrendCategory[] = [
	category(GROCERIES, "Groceries"),
	category(EATING_OUT, "Eating Out"),
	category(KIDS, "Kids"),
	category(GAS, "Gas"),
	category(HOUSEHOLD, "Household"),
	category(OLD, "Old", true),
];

// May to October: this month is the 5 days so far.
const MONTHS = [
	"2026-05",
	"2026-06",
	"2026-07",
	"2026-08",
	"2026-09",
	"2026-10",
];
const SERIES: Record<number, number[]> = {
	[GROCERIES]: [82000, 79000, 84500, 81000, 86000, 19600],
	[EATING_OUT]: [21000, 24500, 28000, 31800, 36500, 9200],
	[KIDS]: [26000, 24000, 30000, 28000, 25500, 6000],
	[GAS]: [18000, 17500, 19000, 17200, 18500, 4800],
	[HOUSEHOLD]: [14000, 19000, 12000, 16000, 15000, 3000],
};
const spendRows = (series: Record<number, number[]>): MonthSpend[] =>
	Object.entries(series).flatMap(([id, cents]) =>
		cents.map((c, i) => ({
			month: MONTHS[i] as string,
			categoryId: Number(id),
			cents: c,
		})),
	);
const BUDGETS: BudgetAmount[] = [
	{ categoryId: GROCERIES, effectiveMonth: "2026-01", amountCents: 90000 },
	{ categoryId: EATING_OUT, effectiveMonth: "2026-01", amountCents: 30000 },
	{ categoryId: KIDS, effectiveMonth: "2026-01", amountCents: 30000 },
	{ categoryId: GAS, effectiveMonth: "2026-01", amountCents: 20000 },
	{ categoryId: HOUSEHOLD, effectiveMonth: "2026-01", amountCents: 15000 },
];

function input(over: Partial<TrendsInput> = {}): TrendsInput {
	return {
		today: "2026-10-05",
		firstDate: "2026-05-01",
		categories: CATEGORIES,
		amounts: BUDGETS,
		spend: [
			...spendRows(SERIES),
			// Uncategorized spending this month, so the headline matches Home's.
			{ month: "2026-10", categoryId: null, cents: 2300 },
		],
		sameDays: [
			{ categoryId: GROCERIES, cents: 22400 },
			{ categoryId: EATING_OUT, cents: 6100 },
			{ categoryId: KIDS, cents: 4500 },
			{ categoryId: GAS, cents: 5200 },
			{ categoryId: HOUSEHOLD, cents: 5800 },
		],
		...over,
	};
}

function full(over: Partial<TrendsInput> = {}) {
	const page = buildTrends(input(over));
	if (page.kind !== "full") throw new Error(`expected full, got ${page.kind}`);
	return page;
}

describe("buildTrends: the headline", () => {
	it("is all counted spending this month, uncategorized included, and a sentence", () => {
		const page = full();
		expect(page.monthName).toBe("October");
		// 19600 + 9200 + 6000 + 4800 + 3000 + 2300
		expect(page.soFarCents).toBe(44900);
		expect(page.sentence).toBe("$9 more than by this time in September.");
		expect(page.caption).toBe("Oct 1–5 against Sep 1–5");
	});

	it("is the comparison's two sides in cents, for the worked example", () => {
		const page = full();
		expect(page.sameDaysCents).toEqual({ now: 44900, last: 44000 });
		expect(page.lastMonthName).toBe("September");
	});
});

describe("buildTrends: each category's change, biggest first", () => {
	it("sorts by the size of the change, ties in category order, uncategorized last", () => {
		expect(full().changes.map((c) => [c.name, c.words, c.direction])).toEqual([
			["Eating Out", "Up $31", "up"],
			["Groceries", "Down $28", "down"],
			["Household", "Down $28", "down"],
			["Uncategorized", "Up $23", "up"],
			["Kids", "Up $15", "up"],
			["Gas", "Down $4", "down"],
		]);
	});

	it("says what it was and what it is", () => {
		const [eatingOut] = full().changes;
		expect(eatingOut).toMatchObject({
			id: EATING_OUT,
			nowCents: 9200,
			thenCents: 6100,
			detail: "$92, was $61",
		});
	});

	it("leaves out a category with nothing in either window, and Uncategorized when it has nothing", () => {
		const page = full({
			spend: spendRows(SERIES).filter((r) => r.categoryId !== GAS),
			sameDays: [{ categoryId: GROCERIES, cents: 22400 }],
		});
		const names = page.changes.map((c) => c.name);
		expect(names).not.toContain("Gas");
		expect(names).not.toContain("Uncategorized");
		expect(names).toContain("Groceries");
	});

	it("keeps a category whose last month's days had spending but this month has none", () => {
		const page = full({
			spend: spendRows(SERIES).filter(
				(r) => !(r.categoryId === GAS && r.month === "2026-10"),
			),
		});
		expect(page.changes.find((c) => c.name === "Gas")).toMatchObject({
			nowCents: 0,
			thenCents: 5200,
			words: "Down $52",
		});
	});

	it("says no change, with no arrow, when the two are equal", () => {
		const page = full({
			sameDays: [{ categoryId: GAS, cents: 4800 }],
		});
		expect(page.changes.find((c) => c.name === "Gas")).toMatchObject({
			direction: "same",
			words: "No change",
		});
	});
});

describe("buildTrends: Going well, Worth a look and the rest", () => {
	it("puts a category under budget three or more months running in Going well, with its run", () => {
		// Tally's first month (May) isn't judged, so each has June to September: 4 months.
		expect(full().goingWell.map((r) => [r.name, r.line])).toEqual([
			["Groceries", "4 months under budget"],
			["Kids", "4 months under budget"],
			["Gas", "4 months under budget"],
		]);
	});

	it("puts a category up three or more months running in Worth a look", () => {
		expect(full().worthALook.map((r) => [r.name, r.line])).toEqual([
			["Eating Out", "Up 3 months running"],
		]);
	});

	it("leaves every other category for the last list, with last month's amount", () => {
		expect(full().others.map((r) => [r.name, r.line])).toEqual([
			["Household", "$150 in September"],
		]);
	});

	it("never judges this month, however far over its budget it already is", () => {
		const series = { ...SERIES, [GROCERIES]: [...(SERIES[GROCERIES] ?? [])] };
		series[GROCERIES]?.splice(5, 1, 9999999);
		const page = full({ spend: spendRows(series) });
		expect(page.goingWell.map((r) => r.name)).toContain("Groceries");
	});

	it("never judges this month's rise either", () => {
		// Gas is flat to September and far higher this month: not Worth a look until it's over.
		const series = {
			...SERIES,
			[GAS]: [18000, 18000, 18000, 18000, 18000, 99999],
		};
		const page = full({ spend: spendRows(series) });
		expect(page.worthALook.map((r) => r.name)).not.toContain("Gas");
	});

	it("puts a category both under budget and rising in Worth a look only", () => {
		const series = {
			...SERIES,
			[GROCERIES]: [64000, 65500, 67000, 68500, 69000, 20000],
		};
		const page = full({ spend: spendRows(series) });
		// June to September: three rises in a row (May, Tally's first month, isn't judged).
		expect(page.worthALook.map((r) => [r.name, r.line])).toContainEqual([
			"Groceries",
			"Up 3 months running",
		]);
		expect(page.goingWell.map((r) => r.name)).not.toContain("Groceries");
		expect(page.others.map((r) => r.name)).not.toContain("Groceries");
	});

	it("doesn't count months before a category had a budget", () => {
		// Gas got its budget in August: only August and September are under it.
		const page = full({
			amounts: BUDGETS.map((a) =>
				a.categoryId === GAS ? { ...a, effectiveMonth: "2026-08" } : a,
			),
		});
		expect(page.goingWell.map((r) => r.name)).not.toContain("Gas");
		expect(page.others.map((r) => r.name)).toContain("Gas");
	});

	it("judges each month against the budget it had", () => {
		// Eating Out's budget was $200 until June and $250 from July on. Judged against a flat $200,
		// July, August and September would be over; against what it had, every month is under.
		const page = full({
			amounts: [
				{
					categoryId: EATING_OUT,
					effectiveMonth: "2026-04",
					amountCents: 20000,
				},
				{
					categoryId: EATING_OUT,
					effectiveMonth: "2026-07",
					amountCents: 25000,
				},
			],
			spend: spendRows({
				[EATING_OUT]: [17000, 19500, 24000, 21500, 24900, 9200],
			}),
		});
		// June's 19500 is under 20000; July, August and September are under 25000: four under, and
		// not rising (August fell).
		expect(page.goingWell).toHaveLength(1);
		expect(page.goingWell[0]).toMatchObject({
			name: "Eating Out",
			line: "4 months under budget",
		});
	});

	it("leaves an archived category out of both groups", () => {
		const page = full({
			amounts: [
				...BUDGETS,
				{ categoryId: OLD, effectiveMonth: "2026-01", amountCents: 50000 },
			],
			spend: [
				...input().spend,
				{ month: "2026-06", categoryId: OLD, cents: 1000 },
			],
		});
		const names = [...page.goingWell, ...page.worthALook].map((r) => r.name);
		expect(names).not.toContain("Old");
		// It spent in the window, so it is still a row among the others.
		expect(page.others.map((r) => r.name)).toContain("Old");
	});

	it("leaves out a category with no spending in the six months from the last list", () => {
		const page = full({
			categories: [...CATEGORIES, category(7, "Pets")],
		});
		expect(page.others.map((r) => r.name)).not.toContain("Pets");
	});

	it("leaves out an archived category with no spending in the six months altogether", () => {
		const page = full();
		const everyone = [
			...page.goingWell,
			...page.worthALook,
			...page.others,
		].map((r) => r.name);
		expect(everyone).not.toContain("Old");
	});

	it("gives each row its six months, the last one the month so far", () => {
		const [groceries] = full().goingWell;
		expect(groceries?.months).toEqual([
			{ month: "2026-05", cents: 82000, partial: false },
			{ month: "2026-06", cents: 79000, partial: false },
			{ month: "2026-07", cents: 84500, partial: false },
			{ month: "2026-08", cents: 81000, partial: false },
			{ month: "2026-09", cents: 86000, partial: false },
			{ month: "2026-10", cents: 19600, partial: true },
		]);
		expect(groceries?.label).toBe(
			"Spending by month: May $820, June $790, July $845, August $810, September $860, October so far $196.",
		);
	});

	it("names the span of months the rows draw", () => {
		expect(full().rangeLabel).toBe("May to October");
	});
});

describe("buildTrends: months before there's history", () => {
	it("is empty with no transactions at all", () => {
		expect(buildTrends(input({ firstDate: null, spend: [] }))).toEqual({
			kind: "empty",
		});
	});

	it("is the early state when Tally started last month: all spending, the months it has", () => {
		const page = buildTrends(
			input({
				firstDate: "2026-09-12",
				spend: [
					{ month: "2026-09", categoryId: GROCERIES, cents: 20000 },
					{ month: "2026-09", categoryId: EATING_OUT, cents: 5000 },
					{ month: "2026-09", categoryId: null, cents: 1000 },
					{ month: "2026-10", categoryId: GROCERIES, cents: 3000 },
				],
			}),
		);
		expect(page).toEqual({
			kind: "early",
			startMonthName: "September",
			months: [
				{ month: "2026-09", cents: 26000, partial: false },
				{ month: "2026-10", cents: 3000, partial: true },
			],
			label: "All spending by month: September $260, October so far $30.",
		});
	});

	it("is the early state in Tally's very first month", () => {
		const page = buildTrends(
			input({
				firstDate: "2026-10-02",
				spend: [{ month: "2026-10", categoryId: GROCERIES, cents: 3000 }],
			}),
		);
		expect(page).toMatchObject({
			kind: "early",
			startMonthName: "October",
			months: [{ month: "2026-10", cents: 3000, partial: true }],
		});
	});

	it("doesn't trust the month Tally started in, which may be partial: it's drawn, never judged or compared", () => {
		// History starts in August: only September is judged, and it is compared.
		const page = full({
			firstDate: "2026-08-20",
			spend: spendRows(SERIES).filter((r) => r.month >= "2026-08"),
		});
		expect(page.sentence).not.toBeNull();
		// One judged month is no run of three.
		expect(page.goingWell).toEqual([]);
		expect(page.worthALook).toEqual([]);
		// August, September and October are drawn.
		expect(page.rangeLabel).toBe("August to October");
		expect(
			page.others.find((r) => r.name === "Groceries")?.months,
		).toHaveLength(3);
	});

	it("starts at an earlier month when a payment counts there (a late bill's month)", () => {
		const page = buildTrends(
			input({
				firstDate: "2026-09-02",
				spend: [
					{ month: "2026-08", categoryId: HOUSEHOLD, cents: 9000 },
					{ month: "2026-09", categoryId: GROCERIES, cents: 20000 },
					{ month: "2026-10", categoryId: GROCERIES, cents: 3000 },
				],
			}),
		);
		// August is the first month with anything, so September can be judged.
		expect(page.kind).toBe("full");
	});

	it("draws only six months, and judges all five before this one when history is longer", () => {
		const page = full({ firstDate: "2024-01-01" });
		expect(page.rangeLabel).toBe("May to October");
		expect(page.goingWell[0]).toMatchObject({
			name: "Groceries",
			line: "5 months under budget",
		});
		expect(page.worthALook[0]).toMatchObject({
			name: "Eating Out",
			line: "Up 4 months running",
		});
	});
});

describe("buildTrends: the month's first days", () => {
	it("compares just the 1st on the 1st", () => {
		const page = full({
			today: "2026-10-01",
			sameDays: [{ categoryId: GROCERIES, cents: 1000 }],
		});
		expect(page.caption).toBe("Oct 1 against Sep 1");
	});

	it("never counts this month's rows toward last month", () => {
		const page = full();
		expect(page.lastMonthName).toBe("September");
		const groceries = page.changes.find((c) => c.name === "Groceries");
		expect(groceries?.thenCents).toBe(22400);
	});
});

import { describe, expect, it } from "vitest";
import {
	type AccountAdded,
	type AccountSource,
	accountsAdded,
	type BalanceRow,
	chartStart,
	type NetWorthPoint,
	netWorthSeries,
	netWorthView,
} from "../src/net-worth";

const row = (
	accountId: number,
	date: string,
	balanceCents: number,
	isLiability = false,
): BalanceRow => ({ accountId, date, balanceCents, isLiability });

const point = (date: string, cents: number): NetWorthPoint => ({ date, cents });

describe("chartStart", () => {
	it("is the first day of the month five months back, so the 6 months include this one (decision 64)", () => {
		expect(chartStart("2026-10-05")).toBe("2026-05-01");
		expect(chartStart("2026-05-31")).toBe("2025-12-01");
		expect(chartStart("2026-03-15")).toBe("2025-10-01");
		expect(chartStart("2026-06-01")).toBe("2026-01-01");
	});
});

// netWorthSeries and accountsAdded take the ids of every account the headline counts (connected
// bank accounts, never Cash), so the line can never be a net worth that leaves one out.
describe("netWorthSeries", () => {
	it("is empty with no balances", () => {
		expect(netWorthSeries([], "2026-05-01", [])).toEqual([]);
		expect(netWorthSeries([], "2026-05-01", [1])).toEqual([]);
	});

	it("adds what you have and subtracts what you owe, as netWorthCents does", () => {
		expect(
			netWorthSeries(
				[
					row(1, "2026-10-01", 100000),
					row(2, "2026-10-01", 50000),
					row(3, "2026-10-01", 25000, true),
				],
				"2026-05-01",
				[1, 2, 3],
			),
		).toEqual([point("2026-10-01", 125000)]);
	});

	it("leaves out a counted account with no balance yet, and still draws the line from the others", () => {
		const others = [
			row(1, "2026-10-01", 1000),
			row(1, "2026-10-02", 1010),
			row(2, "2026-10-01", 500),
			row(2, "2026-10-02", 505),
		];
		expect(netWorthSeries(others, "2026-05-01", [1, 2, 3])).toEqual([
			point("2026-10-01", 1500),
			point("2026-10-02", 1515),
		]);
		// Its first balance joins the line on that day, a card's as debt.
		expect(
			netWorthSeries(
				[...others, row(3, "2026-10-03", 70, true), row(1, "2026-10-04", 1030)],
				"2026-05-01",
				[1, 2, 3],
			),
		).toEqual([
			point("2026-10-01", 1500),
			point("2026-10-02", 1515),
			point("2026-10-03", 1445),
			point("2026-10-04", 1465),
		]);
	});

	it("ignores balances of accounts the headline doesn't count, like Cash or a disconnected bank", () => {
		expect(
			netWorthSeries(
				[
					row(1, "2026-10-01", 1000),
					row(9, "2026-10-01", 999999),
					row(1, "2026-10-02", 1100),
					row(9, "2026-10-02", 999999),
				],
				"2026-05-01",
				[1],
			),
		).toEqual([point("2026-10-01", 1000), point("2026-10-02", 1100)]);
	});

	it("gives one point per day, oldest first, whatever order the rows come in", () => {
		expect(
			netWorthSeries(
				[
					row(1, "2026-10-03", 300),
					row(1, "2026-10-01", 100),
					row(1, "2026-10-02", 200),
				],
				"2026-05-01",
				[1],
			),
		).toEqual([
			point("2026-10-01", 100),
			point("2026-10-02", 200),
			point("2026-10-03", 300),
		]);
	});

	it("keeps an account's last balance on a day it has no row", () => {
		expect(
			netWorthSeries(
				[
					row(1, "2026-10-01", 1000),
					row(2, "2026-10-01", 400, true),
					row(1, "2026-10-02", 1100),
					row(1, "2026-10-03", 1200),
					row(2, "2026-10-03", 300, true),
				],
				"2026-05-01",
				[1, 2],
			),
		).toEqual([
			point("2026-10-01", 600),
			point("2026-10-02", 700),
			point("2026-10-03", 900),
		]);
	});

	it("keeps the past months when an account gets its first balance: the line steps on that day by the new balance", () => {
		expect(
			netWorthSeries(
				[
					row(1, "2026-09-01", 1000),
					row(1, "2026-09-02", 1010),
					row(1, "2026-09-03", 1020),
					row(2, "2026-09-03", 5000),
					row(1, "2026-09-04", 1030),
					row(2, "2026-09-04", 5010),
				],
				"2026-05-01",
				[1, 2],
			),
		).toEqual([
			point("2026-09-01", 1000),
			point("2026-09-02", 1010),
			point("2026-09-03", 6020),
			point("2026-09-04", 6040),
		]);
	});

	it("starts the line on the window's first day when a bank's first balance comes later, and a card's debt steps it down", () => {
		const before = [row(1, "2026-05-01", 1000), row(1, "2026-05-02", 1010)];
		expect(
			netWorthSeries(
				[...before, row(2, "2026-06-10", 5000)],
				"2026-05-01",
				[1, 2],
			),
		).toEqual([
			point("2026-05-01", 1000),
			point("2026-05-02", 1010),
			point("2026-06-10", 6010),
		]);
		expect(
			netWorthSeries(
				[...before, row(2, "2026-06-10", 3000, true)],
				"2026-05-01",
				[1, 2],
			),
		).toEqual([
			point("2026-05-01", 1000),
			point("2026-05-02", 1010),
			point("2026-06-10", -1990),
		]);
	});

	it("leaves out days before `from`, but still counts the balances they gave", () => {
		expect(
			netWorthSeries(
				[
					row(1, "2026-04-30", 1000),
					row(2, "2026-04-20", 500),
					row(1, "2026-05-01", 1100),
					row(1, "2026-05-02", 1200),
				],
				"2026-05-01",
				[1, 2],
			),
		).toEqual([point("2026-05-01", 1600), point("2026-05-02", 1700)]);
	});

	it("subtracts a loan like a credit card, and can go below zero", () => {
		expect(
			netWorthSeries(
				[row(1, "2026-10-01", 20000), row(2, "2026-10-01", 90000, true)],
				"2026-05-01",
				[1, 2],
			),
		).toEqual([point("2026-10-01", -70000)]);
	});
});

describe("accountsAdded", () => {
	const bank = (name: string, accountIds: number[]): AccountSource => ({
		name,
		verb: "linked",
		accountIds,
	});

	it("names a source whose first balance is after the line's first day, and not one already there", () => {
		const rows = [
			row(1, "2026-04-30", 100),
			row(1, "2026-10-01", 120),
			row(2, "2026-06-10", 200),
		];
		expect(
			accountsAdded(
				rows,
				[bank("Chase", [1]), bank("Wells Fargo", [2])],
				"2026-05-01",
			),
		).toEqual([{ name: "Wells Fargo", verb: "linked", date: "2026-06-10" }]);
	});

	it("names a bank once, by the earliest first balance among its accounts", () => {
		const rows = [
			row(2, "2026-06-12", 200),
			row(1, "2026-06-10", 100),
			row(1, "2026-07-01", 110),
		];
		expect(accountsAdded(rows, [bank("Chase", [1, 2])], "2026-05-01")).toEqual([
			{ name: "Chase", verb: "linked", date: "2026-06-10" },
		]);
	});

	it("puts two sources oldest first, then by name on one day, and gives Apple Card the verb added", () => {
		const rows = [
			row(2, "2026-09-03", 200),
			row(3, "2026-10-18", 124000, true),
			row(4, "2026-09-03", 50),
		];
		expect(
			accountsAdded(
				rows,
				[
					{ name: "Apple Card", verb: "added", accountIds: [3] },
					bank("Wells Fargo", [2]),
					bank("Ally", [4]),
				],
				"2026-05-01",
			),
		).toEqual([
			{ name: "Ally", verb: "linked", date: "2026-09-03" },
			{ name: "Wells Fargo", verb: "linked", date: "2026-09-03" },
			{ name: "Apple Card", verb: "added", date: "2026-10-18" },
		]);
	});

	it("leaves out a source with no rows, and one whose first balance is on the line's first day", () => {
		const rows = [row(1, "2026-05-01", 100)];
		expect(
			accountsAdded(
				rows,
				[bank("Chase", [1]), bank("Empty", [9])],
				"2026-05-01",
			),
		).toEqual([]);
	});
});

describe("netWorthView, with fewer than two days of balances", () => {
	it("before any balance, says the chart starts with the next sync and has no sentence", () => {
		expect(netWorthView([], "2026-10-05")).toEqual({
			kind: "early",
			sentence: null,
			note: "The chart starts with the next sync.",
		});
	});

	it("never waits for every account: with two days of points it draws the line, and no note says it waits", () => {
		expect(
			netWorthView(
				[point("2026-10-01", 100), point("2026-10-05", 200)],
				"2026-10-05",
			),
		).toMatchObject({ kind: "line", sentence: "Up $1 since Oct 1." });
	});

	it("on the first day, says when it started and that tomorrow brings the chart (P31)", () => {
		expect(netWorthView([point("2026-10-05", 1576838)], "2026-10-05")).toEqual({
			kind: "early",
			sentence: "Tally started following your balances today.",
			note: "The chart starts tomorrow, with a second day of balances.",
		});
	});

	it("with one older day, names the day and waits for the next sync", () => {
		expect(netWorthView([point("2026-10-04", 1576838)], "2026-10-05")).toEqual({
			kind: "early",
			sentence: "Tally started following your balances on Oct 4.",
			note: "The chart starts with the next sync.",
		});
	});
});

describe("netWorthView, with a line to draw", () => {
	const today = "2026-10-05";
	const rising = [
		point("2026-05-01", 1200000),
		point("2026-07-15", 1400000),
		point("2026-10-05", 1560000),
	];

	it("writes the change in words, from the first month (P25 A)", () => {
		const view = netWorthView(rising, today);
		expect(view).toMatchObject({
			kind: "line",
			sentence: "Up $3,600 since May.",
			startLabel: "May",
			endLabel: "Today",
		});
	});

	it("says Down for a fall and No change for under 50 cents, in whole dollars", () => {
		expect(
			netWorthView(
				[point("2026-05-01", 1200000), point("2026-10-05", 1080000)],
				today,
			),
		).toMatchObject({ sentence: "Down $1,200 since May." });
		expect(
			netWorthView(
				[point("2026-05-01", 1200000), point("2026-10-05", 1200049)],
				today,
			),
		).toMatchObject({ sentence: "No change since May." });
		expect(
			netWorthView(
				[point("2026-05-01", 1200000), point("2026-10-05", 1200050)],
				today,
			),
		).toMatchObject({ sentence: "Up $1 since May." });
	});

	it("names the day, not the month, when the history began this month", () => {
		const view = netWorthView(
			[point("2026-10-01", 1500000), point("2026-10-05", 1512000)],
			today,
		);
		expect(view).toMatchObject({
			sentence: "Up $120 since Oct 1.",
			startLabel: "Oct 1",
		});
	});

	it("labels the right end with its day when the last balance isn't from today", () => {
		const view = netWorthView(
			[point("2026-05-01", 1200000), point("2026-10-04", 1560000)],
			today,
		);
		expect(view).toMatchObject({ endLabel: "Oct 4" });
	});

	it("draws the first day at the left edge and the last at the right, higher money higher up", () => {
		const view = netWorthView(rising, today);
		if (view.kind !== "line") throw new Error("expected a line");
		const coords = view.points
			.split(" ")
			.map((p) => p.split(",").map(Number) as [number, number]);
		expect(coords).toHaveLength(3);
		expect(coords[0]?.[0]).toBe(0);
		expect(coords.at(-1)?.[0]).toBe(100);
		// The lowest net worth sits near the bottom of the 0–100 box, the highest near the top.
		expect(coords[0]?.[1]).toBeGreaterThan(coords[1]?.[1] ?? 0);
		expect(coords[1]?.[1]).toBeGreaterThan(coords[2]?.[1] ?? 0);
		expect(view.end).toEqual({ x: 100, y: coords[2]?.[1] });
		for (const [, y] of coords) {
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(100);
		}
	});

	it("spaces points by their dates, so a gap in syncing is a long straight stretch", () => {
		const view = netWorthView(
			[
				point("2026-09-01", 100),
				point("2026-09-02", 100),
				point("2026-10-01", 100),
			],
			today,
		);
		if (view.kind !== "line") throw new Error("expected a line");
		const xs = view.points.split(" ").map((p) => Number(p.split(",")[0]));
		expect(xs).toEqual([0, 3.3, 100]);
	});

	it("draws a flat history through the middle", () => {
		const view = netWorthView(
			[point("2026-09-01", 500000), point("2026-10-01", 500000)],
			today,
		);
		if (view.kind !== "line") throw new Error("expected a line");
		expect(view.points).toBe("0,50 100,50");
	});

	it("gives screen readers the sentence and both ends in dollars", () => {
		const view = netWorthView(rising, today);
		if (view.kind !== "line") throw new Error("expected a line");
		expect(view.description).toBe(
			"Net worth over time. Up $3,600 since May. It was $12,000 on May 1 and is $15,600 today.",
		);
		const older = netWorthView(
			[point("2026-05-01", 1200000), point("2026-10-04", 1560000)],
			today,
		);
		if (older.kind !== "line") throw new Error("expected a line");
		expect(older.description).toBe(
			"Net worth over time. Up $3,600 since May. It was $12,000 on May 1 and was $15,600 on Oct 4.",
		);
	});

	it("shows a negative net worth with a minus sign", () => {
		const view = netWorthView(
			[point("2026-05-01", -500000), point("2026-10-05", -300000)],
			today,
		);
		if (view.kind !== "line") throw new Error("expected a line");
		expect(view.sentence).toBe("Up $2,000 since May.");
		expect(view.description).toContain(
			"It was -$5,000 on May 1 and is -$3,000 today.",
		);
	});
});

describe("netWorthView, names an account added since the line's start", () => {
	const today = "2026-10-05";
	const rising = [
		point("2026-05-01", 1200000),
		point("2026-07-15", 1400000),
		point("2026-10-05", 1560000),
	];
	const added = (
		name: string,
		verb: AccountAdded["verb"],
		date: string,
	): AccountAdded => ({ name, verb, date });

	it("adds the account and its day after the change: 'You added Apple Card on Oct 4.'", () => {
		expect(
			netWorthView(rising, today, [added("Apple Card", "added", "2026-10-04")]),
		).toMatchObject({
			kind: "line",
			sentence: "Up $3,600 since May. You added Apple Card on Oct 4.",
		});
	});

	it("says 'today' for an account added on its first day", () => {
		expect(
			netWorthView(rising, today, [added("Apple Card", "added", today)]),
		).toMatchObject({
			sentence: "Up $3,600 since May. You added Apple Card today.",
		});
	});

	it("names two accounts in one sentence, oldest first", () => {
		expect(
			netWorthView(rising, today, [
				added("Wells Fargo", "linked", "2026-09-03"),
				added("Apple Card", "added", "2026-10-04"),
			]),
		).toMatchObject({
			sentence:
				"Up $3,600 since May. You linked Wells Fargo on Sep 3 and added Apple Card on Oct 4.",
		});
	});

	it("counts three or more as 'You added 3 accounts since May.', with the change's own label", () => {
		expect(
			netWorthView(rising, today, [
				added("Wells Fargo", "linked", "2026-07-20"),
				added("Apple Card", "added", "2026-08-01"),
				added("Ally", "linked", "2026-09-03"),
			]),
		).toMatchObject({
			sentence: "Up $3,600 since May. You added 3 accounts since May.",
		});
	});

	it("says the change alone when no account was added, as before", () => {
		expect(netWorthView(rising, today, [])).toMatchObject({
			sentence: "Up $3,600 since May.",
		});
	});

	it("carries the clause in the words a screen reader hears", () => {
		const view = netWorthView(rising, today, [
			added("Apple Card", "added", "2026-10-04"),
		]);
		if (view.kind !== "line") throw new Error("expected a line");
		expect(view.description).toBe(
			"Net worth over time. Up $3,600 since May. You added Apple Card on Oct 4. It was $12,000 on May 1 and is $15,600 today.",
		);
	});

	it("adds nothing to the early words, which have no change to add to", () => {
		expect(
			netWorthView([], today, [added("Apple Card", "added", today)]),
		).toEqual({
			kind: "early",
			sentence: null,
			note: "The chart starts with the next sync.",
		});
	});
});

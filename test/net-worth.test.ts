import { describe, expect, it } from "vitest";
import {
	accountsWaiting,
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

// netWorthSeries and accountsWaiting take the ids of every account the headline counts (connected
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

	it("draws nothing while a counted account has no balance at all, however many days the others have", () => {
		const others = [
			row(1, "2026-10-01", 1000),
			row(1, "2026-10-02", 1010),
			row(2, "2026-10-01", 500),
			row(2, "2026-10-02", 505),
		];
		expect(netWorthSeries(others, "2026-05-01", [1, 2, 3])).toEqual([]);
		// The day it first has one, the line begins, and not before.
		expect(
			netWorthSeries(
				[...others, row(3, "2026-10-03", 70, true), row(1, "2026-10-04", 1030)],
				"2026-05-01",
				[1, 2, 3],
			),
		).toEqual([point("2026-10-03", 1445), point("2026-10-04", 1465)]);
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

	it("starts on the first day every account has a balance, so adding an account doesn't look like growth", () => {
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
		).toEqual([point("2026-09-03", 6020), point("2026-09-04", 6040)]);
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

describe("accountsWaiting", () => {
	it("counts the counted accounts with no balance, while another has one", () => {
		const rows = [row(1, "2026-10-01", 100), row(2, "2026-10-01", 200)];
		expect(accountsWaiting(rows, [1, 2, 3, 4])).toBe(2);
		expect(accountsWaiting(rows, [1, 2])).toBe(0);
	});

	it("is zero before any balance is recorded, since then nothing waits on a particular account", () => {
		expect(accountsWaiting([], [1, 2, 3])).toBe(0);
		// A balance of an account the headline doesn't count doesn't make the rest wait.
		expect(accountsWaiting([row(9, "2026-10-01", 5)], [1, 2])).toBe(0);
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

	it("while a counted account has no balance yet, says the chart waits for every account, and draws no line", () => {
		const waiting = {
			kind: "early",
			sentence: null,
			note: "The chart starts once every account has a balance.",
		};
		expect(netWorthView([], "2026-10-05", 1)).toEqual(waiting);
		// Even handed a line, it isn't drawn: it would add up fewer accounts than the headline does.
		expect(
			netWorthView(
				[point("2026-10-01", 100), point("2026-10-05", 200)],
				"2026-10-05",
				2,
			),
		).toEqual(waiting);
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

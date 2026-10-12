import { describe, expect, it } from "vitest";
import {
	amountForMonth,
	earlierAmount,
	latestPriceChange,
} from "../src/bills/amount";

// Spec §5 `bill_amounts` and §8.4 (decisions 74, 79, 101): an occurrence's amount is the row with the
// latest effective month on or before its month. A month before the first row uses the first row.

const row = (effectiveMonth: string, amountCents: number) => ({
	effectiveMonth,
	amountCents,
});

describe("amountForMonth", () => {
	it("uses the bill's own amount when it has no rows", () => {
		expect(amountForMonth([], "2026-10", 1549)).toBe(1549);
	});

	it("keeps a $15.49 bill at $15.49 before October and moves it to $17.99 from October on", () => {
		const rows = [row("2026-08", 1549), row("2026-10", 1799)];
		expect(amountForMonth(rows, "2026-09", 1799)).toBe(1549);
		expect(amountForMonth(rows, "2026-10", 1549)).toBe(1799);
		expect(amountForMonth(rows, "2026-11", 1549)).toBe(1799);
	});

	it("uses the latest row on or before the month, however many rows there are", () => {
		const rows = [
			row("2026-01", 1000),
			row("2026-05", 1200),
			row("2026-10", 900),
		];
		expect(amountForMonth(rows, "2026-08", 900)).toBe(1200);
		expect(amountForMonth(rows, "2026-05", 900)).toBe(1200);
		expect(amountForMonth(rows, "2026-04", 900)).toBe(1000);
	});

	it("uses the earliest row for a month before the bill's history starts", () => {
		expect(amountForMonth([row("2026-08", 1549)], "2026-06", 1799)).toBe(1549);
	});

	it("does not depend on the order the rows arrive in", () => {
		const rows = [row("2026-10", 1799), row("2026-08", 1549)];
		expect(amountForMonth(rows, "2026-09", 1799)).toBe(1549);
	});
});

describe("latestPriceChange", () => {
	it("is none when the bill has no rows or every row agrees", () => {
		expect(latestPriceChange([])).toBeUndefined();
		expect(latestPriceChange([row("2026-08", 1549)])).toBeUndefined();
		expect(
			latestPriceChange([row("2026-08", 1549), row("2026-10", 1549)]),
		).toBeUndefined();
	});

	it("says a price went up, in the month it changed", () => {
		expect(
			latestPriceChange([row("2026-08", 1549), row("2026-10", 1799)]),
		).toEqual({
			effectiveMonth: "2026-10",
			amountCents: 1799,
			direction: "up",
		});
	});

	it("says a price went down", () => {
		expect(
			latestPriceChange([row("2026-08", 1799), row("2026-10", 1499)]),
		).toEqual({
			effectiveMonth: "2026-10",
			amountCents: 1499,
			direction: "down",
		});
	});

	it("names the newest change, not the first", () => {
		expect(
			latestPriceChange([
				row("2026-01", 1000),
				row("2026-03", 1200),
				row("2026-06", 1200),
				row("2026-09", 900),
			]),
		).toEqual({
			effectiveMonth: "2026-09",
			amountCents: 900,
			direction: "down",
		});
	});
});

describe("earlierAmount", () => {
	it("is the amount earlier months keep: the latest row before the month", () => {
		const rows = [row("2026-01", 1549), row("2026-10", 1799)];
		expect(earlierAmount(rows, "2026-10")).toBe(1549);
		expect(earlierAmount(rows, "2026-11")).toBe(1799);
	});

	it("is none when the bill has no row before the month", () => {
		expect(earlierAmount([], "2026-10")).toBeUndefined();
		expect(earlierAmount([row("2026-10", 1799)], "2026-10")).toBeUndefined();
	});
});

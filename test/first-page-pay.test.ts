import { describe, expect, it } from "vitest";
import {
	amountWords,
	cadenceOf,
	payLedgerLine,
	paySentence,
	payShown,
	shownPayValues,
} from "../src/first-tally/pay";

// The pay step's words (P125 E, spec §8.8): what the bank shows for one merchant whose money in marked as income.
// Every number comes from the deposits, so these tests pin the words, not a layout.

/** Every other Friday from Jul 17, 2026: seven deposits. */
const EVERY_OTHER_FRIDAY = [
	"2026-07-17",
	"2026-07-31",
	"2026-08-14",
	"2026-08-28",
	"2026-09-11",
	"2026-09-25",
	"2026-10-09",
];

const deposits = (dates: string[], cents: number[] | number) =>
	dates.map((date, i) => ({
		date,
		cents: typeof cents === "number" ? cents : (cents[i] as number),
	}));

describe("cadenceOf", () => {
	it("names a weekly deposit by its weekday", () => {
		expect(
			cadenceOf(["2026-10-02", "2026-10-09", "2026-10-16", "2026-10-23"]),
		).toBe("every Friday");
	});

	it("names a fortnightly deposit every other weekday", () => {
		expect(cadenceOf(EVERY_OTHER_FRIDAY)).toBe("every other Friday");
	});

	it("says every other week for a fortnightly paycheck whose weekday moved", () => {
		// The Friday of Aug 14 came on the Thursday before it (a holiday shift): the gaps are 14, 13, 15, 14, 14, 14.
		expect(
			cadenceOf([
				"2026-07-17",
				"2026-07-31",
				"2026-08-13",
				"2026-08-28",
				"2026-09-11",
				"2026-09-25",
				"2026-10-09",
			]),
		).toBe("every other week");
	});

	it("says every week for a weekly paycheck whose weekday moved", () => {
		// Friday Oct 2, Thursday Oct 8 (a holiday shift), then Fridays: the gaps are 6, 8 and 7 days.
		expect(
			cadenceOf(["2026-10-02", "2026-10-08", "2026-10-16", "2026-10-23"]),
		).toBe("every week");
	});

	it("names a deposit twice a month", () => {
		expect(
			cadenceOf(["2026-08-01", "2026-08-15", "2026-09-01", "2026-09-15"]),
		).toBe("twice a month");
	});

	it("names a monthly deposit every month", () => {
		expect(
			cadenceOf(["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"]),
		).toBe("every month");
	});

	it("gives no cadence for a single deposit", () => {
		expect(cadenceOf(["2026-10-09"])).toBeNull();
	});

	it("gives no cadence for daily deposits, which no named cadence fits", () => {
		expect(
			cadenceOf([
				"2026-10-05",
				"2026-10-06",
				"2026-10-07",
				"2026-10-08",
				"2026-10-09",
			]),
		).toBeNull();
	});

	it("gives no cadence for deposits a few days apart", () => {
		expect(
			cadenceOf(["2026-10-01", "2026-10-04", "2026-10-08", "2026-10-11"]),
		).toBeNull();
	});

	it("keeps the fortnightly cadence when a same-day bonus sits on one of its dates", () => {
		expect(cadenceOf([...EVERY_OTHER_FRIDAY, "2026-08-14"])).toBe(
			"every other Friday",
		);
	});

	it("gives no cadence for two deposits on one date", () => {
		expect(cadenceOf(["2026-10-09", "2026-10-09"])).toBeNull();
	});

	it("gives no cadence for a weekly series with one skipped week", () => {
		expect(
			cadenceOf([
				"2026-10-02",
				"2026-10-09",
				"2026-10-16",
				"2026-10-30",
				"2026-11-06",
			]),
		).toBeNull();
	});

	it("gives no cadence when one gap of a fortnightly series is 45 days, though the median is a fortnight", () => {
		// Gaps 14, 14, 45: most gaps are a fortnight, but the cadence must hold for every gap, not the median.
		expect(
			cadenceOf(["2026-07-01", "2026-07-15", "2026-07-29", "2026-09-12"]),
		).toBeNull();
	});

	it("gives no cadence when one gap of a monthly series is 60 days, though the median is a month", () => {
		// Gaps 30, 30, 60: the median is a month, but the 60-day gap fits no cadence.
		expect(
			cadenceOf(["2026-05-01", "2026-05-31", "2026-06-30", "2026-08-29"]),
		).toBeNull();
	});
});

describe("amountWords", () => {
	it("gives one amount in whole dollars when every deposit is the same", () => {
		expect(amountWords(deposits(EVERY_OTHER_FRIDAY, 245000))).toBe("$2,450");
	});

	it("keeps the cents of an amount that has them", () => {
		expect(amountWords([{ date: "2026-10-09", cents: 1250 }])).toBe("$12.50");
	});

	it("gives a range when the deposits vary", () => {
		expect(
			amountWords(
				deposits(
					EVERY_OTHER_FRIDAY,
					[230000, 260000, 245000, 260000, 230000, 245000, 260000],
				),
			),
		).toBe("$2,300 to $2,600");
	});
});

describe("paySentence", () => {
	it("says what the bank shows, from the deposits (one amount)", () => {
		expect(
			paySentence({
				bankText: "ACME CORP PAYROLL",
				deposits: deposits(EVERY_OTHER_FRIDAY, 245000),
			}),
		).toBe(
			"Your bank shows ACME CORP PAYROLL paying $2,450 every other Friday, 7 times since Jul 17.",
		);
	});

	it("gives the range when the amounts vary, with how often they came", () => {
		expect(
			paySentence({
				bankText: "ACME CORP PAYROLL",
				deposits: deposits(
					EVERY_OTHER_FRIDAY,
					[230000, 260000, 245000, 260000, 230000, 245000, 260000],
				),
			}),
		).toBe(
			"Your bank shows ACME CORP PAYROLL paying $2,300 to $2,600, 7 times since Jul 17.",
		);
	});

	it("gives the count with no cadence word for daily payouts", () => {
		expect(
			paySentence({
				bankText: "TIP PAYOUT",
				deposits: deposits(
					[
						"2026-10-05",
						"2026-10-06",
						"2026-10-07",
						"2026-10-08",
						"2026-10-09",
					],
					4000,
				),
			}),
		).toBe("Your bank shows TIP PAYOUT paying $40, 5 times since Oct 5.");
	});

	it("says once, with its date, for a single deposit", () => {
		expect(
			paySentence({
				bankText: "ACME CORP PAYROLL",
				deposits: deposits(["2026-07-17"], 245000),
			}),
		).toBe("Your bank shows ACME CORP PAYROLL paying $2,450, once, on Jul 17.");
	});
});

describe("payLedgerLine", () => {
	it("names the pay with its amount and cadence, in ink", () => {
		expect(
			payLedgerLine({
				name: "Acme Corp",
				deposits: deposits(EVERY_OTHER_FRIDAY, 245000),
			}),
		).toBe("Pay · Acme Corp, $2,450 every other Friday");
	});

	it("drops the cadence when there is none to name", () => {
		expect(
			payLedgerLine({
				name: "Acme Corp",
				deposits: deposits(["2026-07-17"], 245000),
			}),
		).toBe("Pay · Acme Corp, $2,450");
	});

	it("drops the cadence when one gap breaks it, even if most gaps are a fortnight", () => {
		expect(
			payLedgerLine({
				name: "Acme Corp",
				deposits: deposits(
					["2026-07-01", "2026-07-15", "2026-07-29", "2026-09-12"],
					245000,
				),
			}),
		).toBe("Pay · Acme Corp, $2,450");
	});
});

describe("shownPayValues and payShown", () => {
	// A merchant as payMerchants reads it: the deposits and their transaction ids, in the same order.
	const merchant = {
		ids: [11, 12, 13],
		deposits: deposits(
			["2026-07-17", "2026-07-31", "2026-08-14"],
			[245000, 245000, 260000],
		),
	};
	const shown = shownPayValues(merchant);

	it("gives one value per deposit, pairing each id with its deposit", () => {
		expect(shown).toEqual([
			JSON.stringify({ id: 11, date: "2026-07-17", cents: 245000 }),
			JSON.stringify({ id: 12, date: "2026-07-31", cents: 245000 }),
			JSON.stringify({ id: 13, date: "2026-08-14", cents: 260000 }),
		]);
	});

	it("is true for the same set of values in any order", () => {
		expect(payShown(merchant, [...shown].reverse())).toBe(true);
	});

	it("is false when a deposit arrived since the page drew", () => {
		const later = {
			ids: [...merchant.ids, 14],
			deposits: [...merchant.deposits, { date: "2026-08-28", cents: 245000 }],
		};
		expect(payShown(later, shown)).toBe(false);
	});

	it("is false when a deposit's cents changed since the page drew", () => {
		const changed = {
			...merchant,
			deposits: merchant.deposits.map((d, i) =>
				i === 0 ? { ...d, cents: 250000 } : d,
			),
		};
		expect(payShown(changed, shown)).toBe(false);
	});

	it("is false when a deposit's date changed since the page drew", () => {
		const changed = {
			...merchant,
			deposits: merchant.deposits.map((d, i) =>
				i === 1 ? { ...d, date: "2026-08-01" } : d,
			),
		};
		expect(payShown(changed, shown)).toBe(false);
	});

	it("is false when a shown deposit is no longer current", () => {
		const fewer = {
			ids: merchant.ids.slice(1),
			deposits: merchant.deposits.slice(1),
		};
		expect(payShown(fewer, shown)).toBe(false);
	});

	it("is false for an empty submission", () => {
		expect(payShown(merchant, [])).toBe(false);
	});

	it("is false for a garbled value", () => {
		expect(payShown(merchant, [...shown.slice(0, 2), "not json"])).toBe(false);
	});
});

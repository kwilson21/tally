import { describe, expect, it } from "vitest";
import {
	amountWords,
	cadenceOf,
	payLedgerLine,
	paySentence,
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
});

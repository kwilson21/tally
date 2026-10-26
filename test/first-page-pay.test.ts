import { describe, expect, it } from "vitest";
import {
	amountWords,
	cadenceOf,
	depositDay,
	latestDeposits,
	payCadenceLine,
	payLead,
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

	it("names a monthly deposit every month when a weekend moved one payday", () => {
		// Feb 15 (a Sunday), then Mar 13 and Apr 16 (both moved for a weekend): the gaps are 26 and 34 days.
		expect(cadenceOf(["2026-02-15", "2026-03-13", "2026-04-16"])).toBe(
			"every month",
		);
	});

	it("names a 1st-and-15th deposit twice a month when a weekend moved the 15th earlier", () => {
		// Aug 14 (the 15th, moved back from a Saturday), then Sep 1, Sep 15 and Oct 1: the gaps are 18, 14 and 16 days.
		expect(
			cadenceOf(["2026-08-14", "2026-09-01", "2026-09-15", "2026-10-01"]),
		).toBe("twice a month");
	});

	it("gives no cadence for a monthly deposit with one 36-day gap", () => {
		// Gaps 30 and 36: the 36-day gap is past the monthly window, so no month words.
		expect(cadenceOf(["2026-06-01", "2026-07-01", "2026-08-06"])).toBeNull();
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
	// A merchant as payMerchants reads it: its key, and the deposits and their transaction ids, in the same order.
	const merchant = {
		key: "ACME CORP PAYROLL",
		ids: [11, 12, 13],
		deposits: deposits(
			["2026-07-17", "2026-07-31", "2026-08-14"],
			[245000, 245000, 260000],
		),
	};
	const shown = shownPayValues(merchant);

	it("gives one value per deposit, pairing each id with its deposit", () => {
		expect(shown).toEqual([
			JSON.stringify({
				id: 11,
				key: "ACME CORP PAYROLL",
				date: "2026-07-17",
				cents: 245000,
			}),
			JSON.stringify({
				id: 12,
				key: "ACME CORP PAYROLL",
				date: "2026-07-31",
				cents: 245000,
			}),
			JSON.stringify({
				id: 13,
				key: "ACME CORP PAYROLL",
				date: "2026-08-14",
				cents: 260000,
			}),
		]);
	});

	it("is true for the same set of values in any order", () => {
		expect(payShown(merchant, [...shown].reverse())).toBe(true);
	});

	it("is false when a deposit arrived since the page drew", () => {
		const later = {
			...merchant,
			ids: [...merchant.ids, 14],
			deposits: [...merchant.deposits, { date: "2026-08-28", cents: 245000 }],
		};
		expect(payShown(later, shown)).toBe(false);
	});

	it("is false when a deposit's merchant key changed since the page drew", () => {
		expect(payShown({ ...merchant, key: "ACME" }, shown)).toBe(false);
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
			...merchant,
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

// The setup screen's pay question (P142 A, #773): the lead, the card's cadence line, the last three deposits and the day
// each is drawn with. Every number comes from the deposits, as paySentence's does.

describe("payLead", () => {
	it("says money comes in regularly from one place when its deposits have a cadence", () => {
		expect(payLead(EVERY_OTHER_FRIDAY)).toBe(
			"Tally found money that comes in regularly from one place.",
		);
	});

	it("says money comes in from one place when its deposits are irregular, or there is one", () => {
		expect(payLead(["2026-07-17", "2026-08-02", "2026-09-30"])).toBe(
			"Tally found money that comes in from one place.",
		);
		expect(payLead(["2026-10-09"])).toBe(
			"Tally found money that comes in from one place.",
		);
	});
});

describe("payCadenceLine", () => {
	it("names the cadence and the count since the first deposit, with the cadence capitalized", () => {
		expect(payCadenceLine(deposits(EVERY_OTHER_FRIDAY, 245000))).toBe(
			"Every other Friday · 7 times since Jul 17",
		);
		expect(
			payCadenceLine(
				deposits(
					["2026-08-01", "2026-09-01", "2026-10-01"],
					[245000, 245000, 245000],
				),
			),
		).toBe("Every month · 3 times since Aug 1");
	});

	it("shows the cadence even when the amounts vary, since the card shows the range above it", () => {
		const cents = [230000, 240000, 250000, 260000, 245000, 235000, 255000];
		expect(payCadenceLine(deposits(EVERY_OTHER_FRIDAY, cents))).toBe(
			"Every other Friday · 7 times since Jul 17",
		);
	});

	it("gives the count and the first day without a cadence", () => {
		expect(
			payCadenceLine(
				deposits(["2026-07-17", "2026-08-02", "2026-09-30"], 245000),
			),
		).toBe("3 times since Jul 17");
	});

	it("names the year of a first deposit from another year", () => {
		expect(payCadenceLine(deposits(["2025-12-26", "2026-10-09"], 245000))).toBe(
			"2 times since Dec 26, 2025",
		);
	});

	it("says a single deposit once, with its day", () => {
		expect(payCadenceLine(deposits(["2026-10-09"], 245000))).toBe(
			"Once, on Oct 9",
		);
	});
});

describe("latestDeposits", () => {
	it("shows the three latest by date, newest first, and counts the rest", () => {
		const shuffled = deposits(
			["2026-09-11", "2026-10-09", "2026-07-17", "2026-09-25", "2026-08-14"],
			245000,
		);
		const { shown, earlier } = latestDeposits(shuffled);
		expect(shown.map((deposit) => deposit.date)).toEqual([
			"2026-10-09",
			"2026-09-25",
			"2026-09-11",
		]);
		expect(earlier).toBe(2);
	});

	it("shows every deposit and no earlier count when there are three or fewer", () => {
		expect(
			latestDeposits(deposits(["2026-09-25", "2026-10-09"], 245000)),
		).toEqual({
			shown: [
				{ date: "2026-10-09", cents: 245000 },
				{ date: "2026-09-25", cents: 245000 },
			],
			earlier: 0,
		});
		expect(latestDeposits(deposits(EVERY_OTHER_FRIDAY, 245000)).earlier).toBe(
			4,
		);
	});
});

describe("depositDay", () => {
	it("gives the weekday's first three letters and the day, as shortDay does", () => {
		expect(depositDay("2026-10-09", "2026-10-09")).toBe("Fri, Oct 9");
	});

	it("names the year of a deposit from another year than the latest", () => {
		expect(depositDay("2025-12-26", "2026-10-09")).toBe("Fri, Dec 26, 2025");
	});
});

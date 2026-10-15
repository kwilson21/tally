import { describe, expect, it } from "vitest";
import type { BillSuggestion } from "../src/bills/find";
import { BIG_BILL_CENTS } from "../src/bills/guards";
import {
	billsLedgerLine,
	billsMutedLine,
	keepHeading,
	splitKeepable,
	waitingWords,
} from "../src/first-tally/bills";

// The bills step's words and its one-tap exclusions (P125 E, spec §8.8, #579): a found charge with no category, over
// $100,000, or whose name collides with another found charge or an active bill waits in Possible bills.

const found = (
	over: Partial<BillSuggestion> & Pick<BillSuggestion, "rawName">,
): BillSuggestion => ({
	bankText: over.rawName,
	displayName: over.rawName,
	amountCents: 1500,
	dueDay: 5,
	categoryId: 3,
	chargeCount: 2,
	...over,
});

describe("splitKeepable", () => {
	it("keeps a clean found charge in the one-tap keep", () => {
		const netflix = found({ rawName: "NETFLIX", displayName: "Netflix" });
		expect(splitKeepable([netflix], [])).toEqual({
			keep: [netflix],
			waiting: [],
		});
	});

	it("leaves out a charge with no category", () => {
		const uncategorized = found({ rawName: "GYM", categoryId: null });
		expect(splitKeepable([uncategorized], []).waiting).toEqual([uncategorized]);
	});

	it("leaves out a charge over $100,000, and keeps one at exactly $100,000", () => {
		const over = found({
			rawName: "BIG",
			amountCents: BIG_BILL_CENTS + 1,
		});
		const exact = found({ rawName: "EXACT", amountCents: BIG_BILL_CENTS });
		const split = splitKeepable([over, exact], []);
		expect(split.waiting).toEqual([over]);
		expect(split.keep).toEqual([exact]);
	});

	it("leaves out both charges whose names collide with each other", () => {
		const a = found({ rawName: "STORE A", displayName: "Gym" });
		const b = found({ rawName: "STORE B", displayName: "gym " });
		const split = splitKeepable([a, b], []);
		expect(split.keep).toEqual([]);
		expect(split.waiting).toEqual([a, b]);
	});

	it("leaves out a charge whose name comes out empty, since a bill with no name can't be kept", () => {
		// Alone, so the collision rule can't be what leaves it out: an empty name, and one of only spaces.
		const nameless = found({ rawName: "XX", displayName: "" });
		const blank = found({ rawName: "YY", displayName: "   " });
		expect(splitKeepable([nameless], []).waiting).toEqual([nameless]);
		expect(splitKeepable([blank], []).waiting).toEqual([blank]);
	});

	it("leaves out a charge whose name is already an active bill's, ignoring case and spaces", () => {
		const netflix = found({ rawName: "NETFLIX", displayName: "Netflix" });
		expect(splitKeepable([netflix], ["  NETFLIX "]).waiting).toEqual([netflix]);
	});
});

describe("waitingWords", () => {
	it("says nothing when none waits", () => {
		expect(waitingWords(0)).toBeNull();
	});

	it("says one more waits in, before the Possible bills link", () => {
		expect(waitingWords(1)).toBe("1 more waits in");
	});

	it("says more wait in, before the Possible bills link", () => {
		expect(waitingWords(2)).toBe("2 more wait in");
	});
});

describe("keepHeading", () => {
	it("asks about the count it can keep in one tap", () => {
		expect(keepHeading(8)).toBe("Keep these 8 as bills?");
	});

	it("asks about one bill in the singular", () => {
		expect(keepHeading(1)).toBe("Keep this one as a bill?");
	});
});

describe("billsMutedLine", () => {
	it("names the charges found, their total and the first three with amounts", () => {
		const charges = [
			found({ rawName: "A", displayName: "Netflix", amountCents: 1549 }),
			found({ rawName: "B", displayName: "Spotify", amountCents: 1199 }),
			found({ rawName: "C", displayName: "Rent", amountCents: 190000 }),
			found({ rawName: "D", displayName: "Gym", amountCents: 4500 }),
		];
		expect(billsMutedLine(charges)).toBe(
			"Your bank shows 4 charges that come back every month, about $1,972 in all: Netflix $15.49, Spotify $11.99, Rent $1,900 and 1 more.",
		);
	});
});

describe("billsLedgerLine", () => {
	it("says how many bills were kept and their monthly amount in whole dollars", () => {
		expect(billsLedgerLine(8, 206200)).toBe(
			"Bills · 8 kept, about $2,062 a month",
		);
	});
});

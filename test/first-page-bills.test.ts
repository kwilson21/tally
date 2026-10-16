import { describe, expect, it } from "vitest";
import type { BillSuggestion } from "../src/bills/find";
import { BIG_BILL_CENTS } from "../src/bills/guards";
import {
	billsLedgerLine,
	billsMutedLine,
	keepHeading,
	keepReply,
	keepShown,
	shownBillValue,
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

describe("keepShown", () => {
	const netflix = found({ rawName: "NETFLIX", displayName: "Netflix" });
	const spotify = found({
		rawName: "SPOTIFY",
		displayName: "Spotify",
		amountCents: 1199,
		dueDay: 9,
	});

	it("keeps a charge whose merchant, amount and due day the form showed", () => {
		expect(keepShown([netflix], [shownBillValue(netflix)])).toEqual([netflix]);
	});

	it("does not keep a charge whose amount changed since the form showed it", () => {
		const shown = shownBillValue({ ...netflix, amountCents: 1549 });
		expect(keepShown([{ ...netflix, amountCents: 1599 }], [shown])).toEqual([]);
	});

	it("does not keep a charge whose due day changed since the form showed it", () => {
		const shown = shownBillValue({ ...netflix, dueDay: 5 });
		expect(keepShown([{ ...netflix, dueDay: 6 }], [shown])).toEqual([]);
	});

	it("does not keep a charge whose name changed since the form showed it", () => {
		const shown = shownBillValue({ ...netflix, displayName: "Netflix" });
		expect(
			keepShown([{ ...netflix, displayName: "Netflix Plus" }], [shown]),
		).toEqual([]);
	});

	it("does not keep a charge the form never showed", () => {
		expect(keepShown([netflix, spotify], [shownBillValue(netflix)])).toEqual([
			netflix,
		]);
	});

	it("ignores a value that doesn't parse or has the wrong types", () => {
		const garbage = [
			"not json",
			'{"rawName":5,"amountCents":1549,"dueDay":5}',
			'{"rawName":"NETFLIX","amountCents":"1549","dueDay":5}',
			'{"rawName":"NETFLIX","amountCents":1549.5,"dueDay":5}',
		];
		expect(keepShown([netflix], garbage)).toEqual([]);
	});

	it("keeps nothing when no value was submitted", () => {
		expect(keepShown([netflix, spotify], [])).toEqual([]);
	});
});

describe("keepReply", () => {
	it("says nothing was kept when nothing waits, with the existing words", () => {
		expect(keepReply(0, 0)).toBe("Nothing to keep.");
		expect(keepReply(1, 0)).toBe("Kept 1 bill.");
		expect(keepReply(8, 0)).toBe("Kept 8 bills.");
	});

	it("says nothing was kept, and one charge changed since the page drew and is asked again", () => {
		expect(keepReply(0, 1)).toBe(
			"Nothing kept. 1 charge changed since the page drew, so it's asked again below.",
		);
	});

	it("says what was kept, and one charge changed since the page drew and is asked again", () => {
		expect(keepReply(1, 1)).toBe(
			"Kept 1 bill. 1 charge changed since the page drew, so it's asked again below.",
		);
	});

	it("says what was kept, and several charges changed since the page drew and are asked again", () => {
		expect(keepReply(2, 3)).toBe(
			"Kept 2 bills. 3 charges changed since the page drew, so they're asked again below.",
		);
	});

	it("says nothing was kept, and several charges changed since the page drew and are asked again", () => {
		expect(keepReply(0, 2)).toBe(
			"Nothing kept. 2 charges changed since the page drew, so they're asked again below.",
		);
	});
});

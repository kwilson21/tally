import { describe, expect, it } from "vitest";
import {
	ALL_LATER_LINE,
	allLabel,
	allNotes,
	allUpdateCount,
	oneOffGuessesAgain,
	otherTransactionsLine,
} from "../src/transactions/rename";

describe("a one-off name makes Tally guess the category again", () => {
	const named = {
		nameChanged: true,
		nameScope: "one" as const,
		displayName: "Dog bed",
		jevCategories: true,
	};
	it("when the category is Tally's or empty, and the name is one-off", () => {
		expect(
			oneOffGuessesAgain({
				edit: named,
				current: { categoryId: 4, categorySource: "jev" },
				postedCategory: null,
			}),
		).toBe(true);
		expect(
			oneOffGuessesAgain({
				edit: named,
				current: { categoryId: null, categorySource: null },
				postedCategory: null,
			}),
		).toBe(true);
	});

	it("not while Jev doesn't answer categories (no key, or the categories switch off), so the category stays", () => {
		for (const current of [
			{ categoryId: 4, categorySource: "jev" },
			{ categoryId: null, categorySource: null },
		])
			expect(
				oneOffGuessesAgain({
					edit: { ...named, jevCategories: false },
					current,
					postedCategory: null,
				}),
			).toBe(false);
	});

	it("not when a person chose the category, a merchant rule gave it, or the form picks one now", () => {
		for (const current of [
			{ categoryId: 4, categorySource: "user" },
			{ categoryId: 4, categorySource: "merchant_rule" },
		])
			expect(
				oneOffGuessesAgain({ edit: named, current, postedCategory: null }),
			).toBe(false);
		expect(
			oneOffGuessesAgain({
				edit: named,
				current: { categoryId: null, categorySource: null },
				postedCategory: 2,
			}),
		).toBe(false);
	});

	it("not for a rename of the merchant or a name that was not changed", () => {
		const current = { categoryId: 4, categorySource: "jev" };
		expect(
			oneOffGuessesAgain({
				edit: { ...named, nameScope: "all" },
				current,
				postedCategory: null,
			}),
		).toBe(false);
		expect(
			oneOffGuessesAgain({
				edit: { ...named, nameChanged: false },
				current,
				postedCategory: null,
			}),
		).toBe(false);
	});

	it("also for the store's own name under This one only, which is a one-off name too", () => {
		expect(
			oneOffGuessesAgain({
				// The store's own name has no displayName; under This one only it is still a one-off name.
				edit: { nameChanged: true, nameScope: "one", jevCategories: true },
				current: { categoryId: 4, categorySource: "jev" },
				postedCategory: null,
			}),
		).toBe(true);
	});
});

// The Rename list's words (decision 101, Name row round 2 A). Every count is what the change really does.

describe("the Rename list's counts", () => {
	it("says how many other transactions stay as they are, and drops the line when there are none", () => {
		expect(otherTransactionsLine(23)).toBe("The other 22 stay as they are.");
		expect(otherTransactionsLine(2)).toBe("The other 1 stays as it is.");
		expect(otherTransactionsLine(1)).toBeNull();
	});

	it("counts All as the merchant's transactions without an own name, this one included", () => {
		// 23 Amazon transactions, none with its own name: All changes all 23.
		expect(allUpdateCount({ total: 23, owned: [] })).toBe(23);
		// Dog bed (Oct 2) keeps its own name, so All changes 22 of them, this one among them.
		expect(
			allUpdateCount({
				total: 23,
				owned: [{ name: "Dog bed", date: "2026-10-02" }],
			}),
		).toBe(22);
	});

	it("does not count a split part with its own name, which All keeps, as one of the transactions", () => {
		// A part is part of a purchase the total already counts once, so its own name changes the notes only.
		expect(
			allUpdateCount({
				total: 23,
				owned: [{ name: "Dog bed", date: "2026-10-02", part: true }],
			}),
		).toBe(23);
	});
});

describe("the All label", () => {
	it("reads All with the count, but never All 1: one says This one and later ones, two says Both", () => {
		expect(allLabel({ count: 23, merchant: "Amazon", thisOwn: false })).toBe(
			"All 23 from Amazon",
		);
		expect(allLabel({ count: 1, merchant: "Amazon", thisOwn: false })).toBe(
			"This one and later ones",
		);
		expect(allLabel({ count: 2, merchant: "Amazon", thisOwn: false })).toBe(
			"Both from Amazon",
		);
	});

	it("says this one too when this transaction has its own name", () => {
		expect(allLabel({ count: 23, merchant: "Amazon", thisOwn: true })).toBe(
			"All 23 from Amazon, this one too",
		);
		expect(allLabel({ count: 2, merchant: "Amazon", thisOwn: true })).toBe(
			"Both from Amazon, this one too",
		);
	});

	it("has the later-ones line, and no notes when no own name is affected", () => {
		expect(ALL_LATER_LINE).toBe("And any that come later.");
		expect(allNotes({ thisOwn: null, owned: [], today: "2026-10-11" })).toEqual(
			[],
		);
	});
});

describe("the All notes", () => {
	it("says the own name is replaced when this transaction has one", () => {
		expect(
			allNotes({ thisOwn: "Dog bed", owned: [], today: "2026-10-11" }),
		).toEqual(["Dog bed is replaced."]);
	});

	it("says each other own-named transaction keeps its name, with its date", () => {
		expect(
			allNotes({
				thisOwn: null,
				owned: [{ name: "Dog bed", date: "2026-10-02" }],
				today: "2026-10-11",
			}),
		).toEqual(["Dog bed (Oct 2) keeps its own name."]);
	});

	it("says a split part with its own name keeps it too, and the count stays the same", () => {
		const owned = [{ name: "Dog bed", date: "2026-10-02", part: true }];
		expect(allNotes({ thisOwn: null, owned, today: "2026-10-11" })).toEqual([
			"Dog bed (Oct 2) keeps its own name.",
		]);
		expect(allUpdateCount({ total: 23, owned })).toBe(23);
	});

	it("adds the year to a date from an earlier year", () => {
		expect(
			allNotes({
				thisOwn: null,
				owned: [{ name: "Gift", date: "2025-12-31" }],
				today: "2026-10-11",
			}),
		).toEqual(["Gift (Dec 31, 2025) keeps its own name."]);
	});
});

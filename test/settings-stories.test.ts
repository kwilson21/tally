import { describe, expect, it } from "vitest";
import {
	addPerson,
	type ChangeLineFacts,
	changeLine,
	forgetLine,
	removeAlwaysRule,
	removeNeverSuggestLine,
	removePerson,
	removeSignInAddress,
	renamePerson,
	type Switches,
	saveAiSwitches,
	saveBankSignInEmails,
	saveTimeZone,
	type UndoForgetFacts,
	undoForget,
} from "../src/rules/settings";
import { answerOf, nothingToDo, refuse, write } from "./helpers/rule-answers";

// The settings area's rules as stories (decisions 187, 206): each row is what was asked, what was stored, and what
// the rule answers. The time and the person are inputs (decision 195).

const VERSION = "v1";
const NOW = 1_800_000_000_000;

const ALL_ON: Switches = {
	names: true,
	details: true,
	categories: true,
	income: true,
	sortOnArrival: true,
};

describe("Save the AI suggestions switches", () => {
	const ask = (
		posted: Partial<Switches>,
		drawnOn: (keyof Switches)[],
		switches: Switches = ALL_ON,
		flipped?: keyof Switches,
	) =>
		answerOf(
			saveAiSwitches.decide(
				{ posted, drawnOn, flipped },
				{ switches, version: VERSION },
			),
		);

	const everyOne: (keyof Switches)[] = [
		"names",
		"details",
		"categories",
		"income",
		"sortOnArrival",
	];

	it("saves only the switch that differs from what the page drew", () => {
		expect(ask({ ...ALL_ON, names: false }, everyOne)).toEqual(
			write({
				changed: { names: false },
				rowsWaitFor: null,
				expectedVersion: VERSION,
			}),
		);
	});

	it("has nothing to do when nothing differs", () => {
		expect(ask(ALL_ON, everyOne)).toEqual(nothingToDo());
	});

	it("always writes the switch that was just flipped, even when it matches the page", () => {
		expect(ask(ALL_ON, everyOne, ALL_ON, "income")).toEqual(
			write({
				changed: { income: true },
				rowsWaitFor: null,
				expectedVersion: VERSION,
			}),
		);
	});

	it("leaves out a switch the page greyed, which the form does not post", () => {
		expect(
			ask(
				{ names: false, details: true, categories: true, income: true },
				everyOne,
			),
		).toMatchObject({ save: { changed: { names: false } } });
	});

	it("marks the rows Sort on arrival left as waiting when it comes back on, under the switches as they will be", () => {
		const off = { ...ALL_ON, sortOnArrival: false };

		expect(
			ask(
				{ ...ALL_ON, income: false },
				["names", "details", "categories", "income"],
				off,
			),
		).toEqual(
			write({
				changed: { income: false, sortOnArrival: true },
				rowsWaitFor: { categories: true, income: false },
				expectedVersion: VERSION,
			}),
		);
	});
});

describe("the two settings that are one stored value", () => {
	it("saves the time zone", () => {
		expect(
			answerOf(saveTimeZone.decide({ zone: "America/Chicago" }, null)),
		).toEqual(write({ zone: "America/Chicago" }));
	});

	it("saves the bank sign-in emails switch", () => {
		expect(answerOf(saveBankSignInEmails.decide({ on: false }, null))).toEqual(
			write({ on: false }),
		);
	});
});

describe("Remove a sign-in address from bank sign-in emails", () => {
	const ask = (known: boolean) =>
		answerOf(
			removeSignInAddress.decide(
				{ email: "riley@example.com", now: NOW },
				{ known, version: VERSION },
			),
		);

	it("removes a known address", () => {
		expect(ask(true)).toEqual(
			write({ email: "riley@example.com", now: NOW, expectedVersion: VERSION }),
		);
	});

	it("refuses an address the household does not have", () => {
		expect(ask(false)).toEqual(refuse("AddressNotFound", "Address not found."));
	});
});

describe("the people of the household", () => {
	const GONE = refuse(
		"PersonGone",
		"That person is no longer in your household.",
	);

	it("adds a person", () => {
		expect(answerOf(addPerson.decide({ name: "Riley" }, null))).toEqual(
			write({ name: "Riley" }),
		);
	});

	it.each([
		[
			"renames a person",
			"Riley",
			write({ id: 3, name: "Ry", expectedVersion: VERSION }),
		],
		["refuses to rename a person who is gone", null, GONE],
	])("%s", (_story, stored, answer) => {
		expect(
			answerOf(
				renamePerson.decide(
					{ id: 3, name: "Ry" },
					{ name: stored, version: VERSION },
				),
			),
		).toEqual(answer);
	});

	it.each([
		[
			"removes a person, by the name stored",
			"Riley",
			write({ id: 3, name: "Riley", who: "me", expectedVersion: VERSION }),
		],
		["refuses to remove a person who is gone", null, GONE],
	])("%s", (_story, stored, answer) => {
		expect(
			answerOf(
				removePerson.decide(
					{ id: 3, who: "me" },
					{ name: stored, version: VERSION },
				),
			),
		).toEqual(answer);
	});
});

describe("Tally's rules", () => {
	it.each([
		[
			"removes a merchant's Always rule",
			"Trader Joe's",
			write({
				merchantKey: "TRADER JOES",
				merchant: "Trader Joe's",
				expectedVersion: VERSION,
			}),
		],
		["has nothing to do for a merchant with no rule", null, nothingToDo()],
	])("%s", (_story, merchant, answer) => {
		expect(
			answerOf(
				removeAlwaysRule.decide(
					{ merchantKey: "TRADER JOES" },
					{ merchant, version: VERSION },
				),
			),
		).toEqual(answer);
	});

	const removeLine = removeNeverSuggestLine<{ id: number; merchant: string }>();
	const LINE = { id: 8, merchant: "Venmo" };

	it.each([
		[
			"removes a Never suggest line",
			LINE,
			write({ line: LINE, expectedVersion: VERSION }),
		],
		["has nothing to do for a line that is gone", null, nothingToDo()],
	])("%s", (_story, line, answer) => {
		expect(
			answerOf(removeLine.decide({ id: 8 }, { line, version: VERSION })),
		).toEqual(answer);
	});
});

describe("the learned lines", () => {
	it.each([
		[
			"forgets a learned line from now",
			true,
			write({ text: "netflix.com", now: NOW, expectedVersion: VERSION }),
		],
		["has nothing to do for a text with no line now", false, nothingToDo()],
	])("%s", (_story, learned, answer) => {
		expect(
			answerOf(
				forgetLine.decide(
					{ text: "netflix.com", now: NOW },
					{ learned, version: VERSION },
				),
			),
		).toEqual(answer);
	});

	const forgotten = (ago: number, hadEarlier = false): UndoForgetFacts => ({
		forgotten: { atMs: NOW - ago, hadEarlier },
		version: VERSION,
	});

	it.each([
		[
			"undoes a first Forget by removing its row",
			forgotten(4000),
			write({ id: 5, backToEarlier: false, expectedVersion: VERSION }),
		],
		[
			"undoes a second Forget by putting the earlier time back",
			forgotten(9999, true),
			write({ id: 5, backToEarlier: true, expectedVersion: VERSION }),
		],
		[
			"refuses at ten seconds",
			forgotten(10_000),
			refuse("ForgetUndoExpired", "Undo expired. The line stays forgotten."),
		],
		[
			"refuses a Forget that is gone",
			{ forgotten: null, version: VERSION },
			refuse("NothingToUndo", "Nothing to undo."),
		],
	])("%s", (_story, facts, answer) => {
		expect(answerOf(undoForget.decide({ id: 5, now: NOW }, facts))).toEqual(
			answer,
		);
	});

	const LEARNED: ChangeLineFacts = {
		line: { name: "Netflix", vague: false },
		category: { id: 3, name: "Fun", archived: false },
		version: VERSION,
	};

	it.each([
		[
			"saves a rule for the line",
			LEARNED,
			write({
				text: "netflix.com",
				categoryId: 3,
				lineName: "Netflix",
				categoryName: "Fun",
				expectedVersion: VERSION,
			}),
		],
		[
			"refuses a text with no line",
			{ ...LEARNED, line: null },
			refuse("NoLineToChange", "Choose a line to change."),
		],
		[
			"refuses a line that covers more than one kind of purchase",
			{ ...LEARNED, line: { name: "Amazon", vague: true } },
			refuse(
				"LineTooVague",
				"The line covers more than one kind of purchase, so a rule can't be made for it.",
			),
		],
		[
			"refuses a category that is archived",
			{ ...LEARNED, category: { id: 3, name: "Fun", archived: true } },
			refuse("NoCategoryChosen", "Choose a category."),
		],
		[
			"refuses a category the family does not have",
			{ ...LEARNED, category: null },
			refuse("NoCategoryChosen", "Choose a category."),
		],
	])("%s", (_story, facts, answer) => {
		expect(
			answerOf(
				changeLine.decide({ text: "netflix.com", categoryId: 3 }, facts),
			),
		).toEqual(answer);
	});
});

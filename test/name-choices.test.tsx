/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import {
	NAME_PICK_CLASS,
	NameChoices,
	OWN_PICK_CLASS,
	OWN_VALUE,
	pickValue,
	type RenameFacts,
	SAME_NAME_CLASS,
} from "../src/views/name-choices";

// Decision 101 (Name row round 2 A): the Rename list opens while a Name row choice is ticked, and the
// "Type your own" choice is one of them, so the list shows for it too. The list's CSS reads the class.

const rename: RenameFacts = {
	merchant: "Blue bottle cof",
	total: 2,
	owned: [],
	thisOwn: null,
	tallyCategory: true,
	excludeCounts: true,
	reviewCounts: true,
	today: "2026-10-11",
	scope: "one",
};

/** The one radio whose value is `value`, as its opening tag. */
function radio(html: string, value: string): string {
	const tag = html
		.split("<input")
		.find((part) => part.includes(`value="${value}"`));
	if (!tag) throw new Error(`no radio with value ${value}`);
	return tag;
}

/** The class of the re-guess note under This one only, or "" when the markup draws no note. */
function guessAgainClass(markup: string): string {
	return (
		markup.match(
			/<span class="([^"]*)">Tally guesses its category again\.<\/span>/,
		)?.[1] ?? ""
	);
}

describe("the Name row's choices carry the class that opens the Rename list", () => {
	const html = String(
		NameChoices({
			id: "name",
			names: ["Blue Bottle Coffee"],
			source: "guess",
			tidied: "Blue bottle cof",
			rawName: "SQ *BLUE BOTTLE COF 0412",
			rename,
		}),
	);

	it("gives Type your own the name-pick class and its own hook, as the other choices", () => {
		const own = radio(html, OWN_VALUE);
		expect(own).toContain(NAME_PICK_CLASS);
		expect(own).toContain(OWN_PICK_CLASS);
		expect(radio(html, pickValue("Blue Bottle Coffee"))).toContain(
			NAME_PICK_CLASS,
		);
		expect(radio(html, "store")).toContain(NAME_PICK_CLASS);
	});

	it("draws the Rename list, which the Name group's CSS shows while a choice is ticked", () => {
		expect(html).toContain("Rename");
		expect(html).toContain("This one only");
		expect(html).toContain("group-has-[.name-pick:checked]:flex");
	});

	it("leaves the Rename list out when no Rename facts are given (Settings' Merchant names)", () => {
		const settings = String(
			NameChoices({
				id: "merchant",
				radioName: "name_pick_settings",
				names: ["Blue Bottle Coffee"],
				source: "guess",
				tidied: "Blue bottle cof",
			}),
		);
		expect(settings).not.toContain("This one only");
		expect(settings).not.toContain("group-has-[.name-pick:checked]:flex");
	});
});

// The re-guess note under This one only folds away once the edit form's controls move off the state it was
// drawn from (CSS only, decision 101). Its hooks are literal classes, and the form is the named group/edit.
describe("the re-guess note follows the edit form's controls", () => {
	const markup = (facts: RenameFacts) =>
		String(
			NameChoices({
				id: "name",
				names: ["Blue Bottle Coffee"],
				source: "guess",
				tidied: "Blue bottle cof",
				rawName: "SQ *BLUE BOTTLE COF 0412",
				rename: facts,
			}),
		);

	it("says Tally guesses its category again in a note with the muted look and its own class", () => {
		const html = markup(rename);
		expect(html).toContain("Tally guesses its category again.");
		expect(guessAgainClass(html)).toContain("text-sm text-muted");
	});

	// One row per posted field the re-guess reads (name-choices.tsx lists them, and says which are hidden or
	// need no hook). A checkbox folds both ways, a radio when it is ticked; a field with no hook has none.
	const both = (field: string) => [
		`group-has-[input[name=${field}]:checked:not([checked])]/edit:hidden`,
		`group-has-[input[name=${field}][checked]:not(:checked)]/edit:hidden`,
	];
	it.each([
		{
			field: "category",
			hooks: [
				"group-has-[input[name=category]:checked:not([checked])]/edit:hidden",
			],
		},
		{ field: "excluded", hooks: both("excluded") },
		{ field: "income", hooks: both("income") },
		{
			field: "refund_of",
			hooks: [
				"group-has-[input[name=refund\\_of]:checked:not([checked])]/edit:hidden",
			],
		},
		{ field: "creditReviewed", hooks: both("creditReviewed") },
		{ field: "always", hooks: both("always") },
		{
			field: "name_pick",
			hooks: ["group-has-[.name-same:checked]/edit:hidden"],
		},
		{ field: "merchant", hooks: [] },
		{ field: "name_scope", hooks: [] },
	])("the note's hooks for $field", ({ field, hooks }) => {
		const note = guessAgainClass(markup(rename));
		for (const hook of hooks) expect(note).toContain(hook);
		if (hooks.length === 0) expect(note).not.toContain(`input[name=${field}]`);
	});

	it("folds the note away when Exclude changes, unless the row pays a bill", () => {
		const counted = guessAgainClass(markup(rename));
		expect(counted).toContain(
			"group-has-[input[name=excluded]:checked:not([checked])]/edit:hidden",
		);
		expect(counted).toContain(
			"group-has-[input[name=excluded][checked]:not(:checked)]/edit:hidden",
		);
		const paysBill = guessAgainClass(
			markup({ ...rename, excludeCounts: false }),
		);
		expect(paysBill).toContain("input[name=category]");
		expect(paysBill).not.toContain("input[name=excluded]");
	});

	it("draws no note when Tally did not pick the category", () => {
		expect(markup({ ...rename, tallyCategory: false })).not.toContain(
			"Tally guesses its category again.",
		);
	});

	it("folds the note on the review chip only while a linked purchase is there to count", () => {
		const linked = guessAgainClass(markup(rename));
		expect(linked).toContain(
			"group-has-[input[name=creditReviewed]:checked:not([checked])]/edit:hidden",
		);
		expect(linked).toContain(
			"group-has-[input[name=creditReviewed][checked]:not(:checked)]/edit:hidden",
		);
		expect(
			guessAgainClass(markup({ ...rename, reviewCounts: false })),
		).not.toContain("input[name=creditReviewed]");
	});
});

/** The values of the radios whose class list carries `cls`. */
function radiosWith(html: string, cls: string): string[] {
	return html
		.split("<input")
		.filter((part) => part.includes('type="radio"'))
		.filter((part) =>
			(part.match(/class="([^"]*)"/)?.[1] ?? "").split(" ").includes(cls),
		)
		.map((part) => part.match(/value="([^"]*)"/)?.[1] ?? "");
}

// A Name row choice whose name the save would treat as no rename carries SAME_NAME_CLASS, and the note folds on it
// (the route's guard: the store's tidied name, or a suggested name, equal to the row's own name).
describe("the Name row marks the row's own name, so picking it folds the note", () => {
	const draw = (ownName: string | null | undefined) =>
		String(
			NameChoices({
				id: "name",
				names: ["Blue Bottle Coffee", "Blue Bottle"],
				source: "guess",
				tidied: "Blue bottle cof",
				rawName: "SQ *BLUE BOTTLE COF 0412",
				ownName,
				rename,
			}),
		);

	it("marks the suggested choice that is the row's own name", () => {
		expect(radiosWith(draw("Blue Bottle"), SAME_NAME_CLASS)).toEqual([
			pickValue("Blue Bottle"),
		]);
	});

	it("marks the store's choice when the tidied name is the row's own name", () => {
		expect(radiosWith(draw("Blue bottle cof"), SAME_NAME_CLASS)).toEqual([
			"store",
		]);
	});

	it("marks no choice when the row has no own name", () => {
		expect(radiosWith(draw(null), SAME_NAME_CLASS)).toEqual([]);
		expect(radiosWith(draw(undefined), SAME_NAME_CLASS)).toEqual([]);
	});

	it("gives the note the fold that follows the marked choice", () => {
		expect(guessAgainClass(draw("Blue Bottle"))).toContain(
			"group-has-[.name-same:checked]/edit:hidden",
		);
	});
});

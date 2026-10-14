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
	linkHolds: false,
	reviewLifts: false,
	today: "2026-10-11",
	scope: "one",
};

/** The class list of a note's hooks, one token per hook, so a hook is matched whole, never as part of another. */
const folds = (note: string): string[] => note.split(" ");
/** Reviewed ticked hides the note only with a linked purchase ticked too: the review alone doesn't make a refund follow. */
const REVIEW_HOLD =
	"group-has-[input[name=creditReviewed]:checked]/edit:group-has-[.linked-purchase:checked]/edit:hidden";
/** A linked purchase ticked hides the note while the drawn link holds (Jev's review, linkHolds). */
const LINK_HOLDS = "group-has-[.linked-purchase:checked]/edit:hidden";
/** Exclude hides the note only while Reviewed is unticked, where the review lifts Plaid's exclusion (reviewLifts). */
const EXCLUDE_UNLESS_REVIEWED =
	"group-has-[input[name=excluded]:checked]/edit:group-has-[input[name=creditReviewed]:not(:checked)]/edit:hidden";
const EXCLUDE_PLAIN = "group-has-[input[name=excluded]:checked]/edit:hidden";

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

// The re-guess note under This one only is drawn whenever a guess could happen in the edit (the route decides
// that), and CSS hides it while a control that blocks the guess is ticked (decision 101). Its hooks are literal
// classes, and the form is the named group/edit. A ticked checkbox hides it whether or not it was drawn ticked,
// so unticking it shows the note again. A radio is read against how it was drawn, since its blocking value is
// any other choice.
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
	// need no hook). A ticked checkbox hides the note; a category hides it while any other choice is ticked.
	it.each([
		{
			field: "category",
			hooks: [
				"group-has-[input[name=category]:checked:enabled:not(.tally-category)]/edit:hidden",
			],
		},
		{
			field: "excluded",
			hooks: ["group-has-[input[name=excluded]:checked]/edit:hidden"],
		},
		{
			field: "income",
			hooks: ["group-has-[input[name=income]:checked]/edit:hidden"],
		},
		{
			field: "refund_of",
			hooks: [
				"group-has-[.linked-purchase:checked:not([checked])]/edit:hidden",
			],
		},
		{
			field: "creditReviewed",
			hooks: [REVIEW_HOLD],
		},
		{
			field: "always",
			hooks: ["group-has-[input[name=always]:checked]/edit:hidden"],
		},
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

	it("never hides a checkbox's note by the state it was drawn in, so unticking one shows it again", () => {
		const note = guessAgainClass(markup(rename));
		expect(note).not.toContain("[checked]:not(:checked)");
	});

	it("hides the note while Exclude is ticked, unless the row pays a bill", () => {
		expect(guessAgainClass(markup(rename))).toContain(
			"group-has-[input[name=excluded]:checked]/edit:hidden",
		);
		const paysBill = guessAgainClass(
			markup({ ...rename, excludeCounts: false }),
		);
		expect(paysBill).toContain("input[name=category]");
		expect(paysBill).not.toContain("input[name=excluded]");
	});

	it("where ticking Reviewed lifts Plaid's exclusion, Exclude hides the note only while Reviewed is unticked", () => {
		const note = folds(
			guessAgainClass(markup({ ...rename, reviewLifts: true })),
		);
		expect(note).toContain(EXCLUDE_UNLESS_REVIEWED);
		expect(note).not.toContain(EXCLUDE_PLAIN);
	});

	it("where Reviewed doesn't lift the exclusion, Exclude hides the note while it is ticked, whatever Reviewed is", () => {
		const note = folds(guessAgainClass(markup(rename)));
		expect(note).toContain(EXCLUDE_PLAIN);
		expect(note).not.toContain(EXCLUDE_UNLESS_REVIEWED);
	});

	it("a bill payment has no Exclude hook at all, even where Reviewed would lift an exclusion", () => {
		const note = guessAgainClass(
			markup({ ...rename, reviewLifts: true, excludeCounts: false }),
		);
		expect(note).not.toContain("input[name=excluded]");
	});

	it("draws no note when Tally did not pick the category", () => {
		expect(markup({ ...rename, tallyCategory: false })).not.toContain(
			"Tally guesses its category again.",
		);
	});

	it("hides the note on the review chip only while a linked purchase is ticked too, since Reviewed alone can't make a refund follow", () => {
		const note = guessAgainClass(markup(rename));
		expect(folds(note)).toContain(REVIEW_HOLD);
		expect(folds(note)).not.toContain(
			"group-has-[input[name=creditReviewed]:checked]/edit:hidden",
		);
	});

	it("hides the note while the drawn link holds, and only while a purchase stays ticked, so Not linked brings it back", () => {
		expect(
			folds(guessAgainClass(markup({ ...rename, linkHolds: true }))),
		).toContain(LINK_HOLDS);
		expect(folds(guessAgainClass(markup(rename)))).not.toContain(LINK_HOLDS);
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

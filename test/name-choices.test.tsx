/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import {
	NAME_PICK_CLASS,
	NameChoices,
	OWN_PICK_CLASS,
	OWN_VALUE,
	pickValue,
	type RenameFacts,
} from "../src/views/name-choices";

// Decision 101 (Name row round 2 A): the Rename list opens while a Name row choice is ticked, and the
// "Type your own" choice is one of them, so the list shows for it too. The list's CSS reads the class.

const rename: RenameFacts = {
	merchant: "Blue bottle cof",
	total: 2,
	owned: [],
	thisOwn: null,
	tallyCategory: true,
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

import { describe, expect, it } from "vitest";
import {
	EDIT_FORM_GROUP,
	LINKED_PURCHASE_CLASS,
	NAME_PICK_CLASS,
	OWN_PICK_CLASS,
	SAME_NAME_CLASS,
	TALLY_CATEGORY_CLASS,
} from "../src/views/name-choices";
import { present } from "./helpers/present";

// The Name row's CSS-only hooks (src/views/name-choices.tsx) read class names and a named group that are also exported
// constants. Tailwind compiles a hook only from literal text, so the hooks repeat each name as text; a constant renamed
// or swapped on its own would leave the hooks matching nothing, and the note or the field would stop folding with no
// error (audit finding: only a comment said the two must stay in step). This builds each hook from the constants and
// looks for exactly that text in the source, then checks the rest of the hooks' names are whole and known.

const SOURCE = present(
	Object.values(
		import.meta.glob("../src/views/name-choices.tsx", {
			query: "?raw",
			import: "default",
			eager: true,
		}),
	)[0],
);

const EDIT = present(EDIT_FORM_GROUP.split("/")[1]);

const HOOK_CLASSES = [
	NAME_PICK_CLASS,
	OWN_PICK_CLASS,
	SAME_NAME_CLASS,
	LINKED_PURCHASE_CLASS,
	TALLY_CATEGORY_CLASS,
];

/** Every hook the source is expected to write, each built from the constants that name its class and its group. */
const EXPECTED_HOOKS = [
	// The Name list shows while a name is ticked, and "Type your own"'s field while that radio is (no named group).
	`group-has-[.${NAME_PICK_CLASS}:checked]:flex`,
	`group-has-[.${OWN_PICK_CLASS}:checked]:block`,
	// The re-guess note's folds, read from the edit form's group.
	`group-has-[input[name=category]:checked:enabled:not(.${TALLY_CATEGORY_CLASS})]/${EDIT}:hidden`,
	`group-has-[.${LINKED_PURCHASE_CLASS}:checked:not([checked])]/${EDIT}:hidden`,
	`group-has-[input[name=creditReviewed]:checked]/${EDIT}:group-has-[.${LINKED_PURCHASE_CLASS}:checked]/${EDIT}:hidden`,
	`group-has-[.${SAME_NAME_CLASS}:checked]/${EDIT}:hidden`,
	`"group-has-[.${LINKED_PURCHASE_CLASS}:checked]/${EDIT}:hidden"`,
];

/** The two hooks that read the Name row's own unnamed group; every other hook reads the edit form's. */
const UNNAMED = [`.${NAME_PICK_CLASS}:checked`, `.${OWN_PICK_CLASS}:checked`];

type Hook = {
	condition: string;
	/** The `/name` after the brackets, or undefined for an unnamed group. */
	group: string | undefined;
	/** True when what follows the brackets is neither `:` nor `/name:`. */
	malformed: boolean;
};

/** Every `group-has-[...]` hook in a text. The brackets nest (`input[name=x]`), and names are read whole. */
function hooksOf(source: string): Hook[] {
	const found: Hook[] = [];
	const opener = "group-has-[";
	let from = source.indexOf(opener);

	while (from !== -1) {
		let depth = 1;
		let at = from + opener.length;

		while (depth > 0 && at < source.length) {
			if (source[at] === "[") depth += 1;

			if (source[at] === "]") depth -= 1;

			at += 1;
		}

		const after = /^(?:\/([\w-]+))?:/.exec(source.slice(at));

		found.push({
			condition: source.slice(from + opener.length, at - 1),
			group: after?.[1],
			malformed: after === null,
		});
		from = source.indexOf(opener, at);
	}

	return found;
}

/** The class names a hook's condition mentions, whole: `name-same2` in `.name-same2:checked`. */
const classesIn = (condition: string) =>
	[...condition.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);

const hooks = hooksOf(SOURCE);

describe("the Name row's hooks follow its exported constants", () => {
	it("finds the hooks it is meant to check", () => {
		expect(hooks.length).toBeGreaterThan(8);
	});

	it.each(EXPECTED_HOOKS)("writes the hook %s", (hook) => {
		expect(SOURCE).toContain(hook);
	});

	it("reads no hook with a name it does not know: every class is a whole exported class", () => {
		const unknown = hooks.flatMap((hook) =>
			classesIn(hook.condition).filter(
				(name) => name !== undefined && !HOOK_CLASSES.includes(name),
			),
		);

		expect(unknown).toEqual([]);
	});

	it("reads every hook's group as the edit form's, except the two on the Name row's own group", () => {
		const wrong = hooks.flatMap((hook) => {
			const expected = UNNAMED.includes(hook.condition) ? undefined : EDIT;

			return hook.group === expected ? [] : [hook.condition];
		});

		expect(wrong).toEqual([]);
	});

	it("reads no hook it cannot parse", () => {
		expect(hooks.filter((hook) => hook.malformed)).toEqual([]);
	});
});

describe("the reader of hooks sees the mistakes it guards against", () => {
	it("keeps a class whole when it ends in a digit", () => {
		const [hook] = hooksOf("group-has-[.name-same2:checked]/edit:hidden");

		expect(classesIn(hook?.condition ?? "")).toEqual(["name-same2"]);
	});

	it("reads a misspelled group as that group, not as none", () => {
		const [hook] = hooksOf("group-has-[.name-same:checked]/edit-form:hidden");

		expect(hook?.group).toBe("edit-form");
	});

	it("reads a hook with no group as unnamed, and one with a missing colon as malformed", () => {
		const [unnamed, broken] = hooksOf(
			"group-has-[.a:checked]:flex group-has-[.b:checked]/edit hidden",
		);

		expect(unnamed?.group).toBeUndefined();
		expect(unnamed?.malformed).toBe(false);
		expect(broken?.malformed).toBe(true);
	});

	it("reads two hooks chained in one class", () => {
		const found = hooksOf(
			"group-has-[a]/edit:group-has-[.linked-purchase:checked]/edit:hidden",
		);

		expect(found.map((hook) => hook.group)).toEqual(["edit", "edit"]);
	});
});

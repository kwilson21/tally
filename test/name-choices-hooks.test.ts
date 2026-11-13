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
// on its own would leave the hooks matching nothing, and the note or the field would stop folding with no error
// (audit finding: only a comment said the two must stay in step).

const SOURCE = present(
	Object.values(
		import.meta.glob("../src/views/name-choices.tsx", {
			query: "?raw",
			import: "default",
			eager: true,
		}),
	)[0],
);

const HOOK_CLASSES = [
	NAME_PICK_CLASS,
	OWN_PICK_CLASS,
	SAME_NAME_CLASS,
	LINKED_PURCHASE_CLASS,
	TALLY_CATEGORY_CLASS,
];

/** Every `group-has-[...]` hook in the file, with its optional `/group` name. The brackets nest (`input[name=x]`). */
function hooksOf(source: string) {
	const found: { condition: string; group: string | undefined }[] = [];
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

		const condition = source.slice(from + opener.length, at - 1);
		const group = /^\/([a-z]+):/.exec(source.slice(at))?.[1];

		found.push({ condition, group });
		from = source.indexOf(opener, at);
	}

	return found;
}

const hooks = hooksOf(SOURCE);

/** The class names a hook's condition mentions: `.name-same` in `.name-same:checked`. */
const classesIn = (condition: string) =>
	[...condition.matchAll(/\.([a-z][a-z-]*)/g)].map((match) => match[1]);

describe("the Name row's hooks follow its exported constants", () => {
	it("finds the hooks it is meant to check", () => {
		expect(hooks.length).toBeGreaterThan(8);
	});

	it.each(HOOK_CLASSES)("the class %s is named by a hook", (name) => {
		expect(hooks.some((hook) => classesIn(hook.condition).includes(name))).toBe(
			true,
		);
	});

	it("every class a hook names is one of the exported classes", () => {
		const unknown = hooks.flatMap((hook) =>
			classesIn(hook.condition).filter(
				(name) => name !== undefined && !HOOK_CLASSES.includes(name),
			),
		);

		expect(unknown).toEqual([]);
	});

	it("every named group a hook reads is the edit form's group", () => {
		const edit = present(EDIT_FORM_GROUP.split("/")[1]);

		const others = hooks.flatMap((hook) =>
			hook.group !== undefined && hook.group !== edit ? [hook.group] : [],
		);

		expect(others).toEqual([]);
		expect(hooks.some((hook) => hook.group === edit)).toBe(true);
	});
});

// What the Settings form may save for a category, checked before anything is written (spec §7).
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";
import { NONE_FIT } from "../ai/decide";
import { CATEGORY_NAME_MAX } from "../limits";

/** New categories take the next color in turn, so neighbors differ. */
export const COLORS = [
	"cat-blue",
	"cat-plum",
	"cat-slate",
	"cat-ochre",
	"cat-brown",
];

/**
 * Few enough that Settings, Home and the edit panel always show every category at once, with no
 * pagination (decision 37). Well under Jev's limit of 255 options, one being "None of these fit".
 */
export const MAX_ACTIVE = 50;

type Existing = { id: number; name: string; archived: boolean }[];

/** What a full list says, for adding a category or restoring one. */
export const fullMessage = (action: "add" | "restore") =>
	`Tally has room for ${MAX_ACTIVE} categories. Archive one to ${action} another.`;

export type CategoryValue = { name: string };

export type CategoryErrors = Partial<Record<"name", string>>;

export const normalizeName = (name: string) =>
	name.normalize("NFC").trim().replace(/\s+/g, " ");

/** A decode that reads `text` into a value with `read`, or refuses with the sentence `read` gives. Nothing is encoded back. */
const readText = <T>(read: (text: string) => { value: T } | { say: string }) =>
	SchemaGetter.transformEffect<T, string>((text, options) => {
		const answer = read(text);

		return "value" in answer
			? Effect.succeed(answer.value)
			: Effect.fail(
					new SchemaIssue.InvalidValue({ message: answer.say }, text, options),
				);
	});

/**
 * A typed category name, at the edge (decision 204): text in, the tidied name out, or one of the two sentences. Whether
 * the name is free is for the rules (src/rules/categories.ts), which know the stored list.
 */
export const CategoryName = Schema.String.pipe(
	Schema.decodeTo(Schema.String, {
		decode: readText<string>((text) => {
			const name = normalizeName(text);

			if (name === "") return { say: "Give the category a name." };

			return name.length <= CATEGORY_NAME_MAX
				? { value: name }
				: { say: `Keep the name to ${CATEGORY_NAME_MAX} characters.` };
		}),
		encode: SchemaGetter.passthrough(),
	}),
);

/** A category's id from the address: a whole number above zero. */
export const CategoryId = Schema.String.pipe(
	Schema.decodeTo(Schema.Number, {
		decode: readText<number>((text) => {
			const id = Number(text);

			return Number.isInteger(id) && id > 0
				? { value: id }
				: { say: "That is not a category." };
		}),
		encode: SchemaGetter.transform((id: number) => String(id)),
	}),
);

/** Which way a category moves in the list, from the address. */
export const MoveDirection = Schema.Literals(["up", "down"]);

/**
 * Reads a form field or a part of the address at the edge, from plain code: the typed value, or the sentence that says why not. An edge whose words a
 * person reads gives its own sentence (readText); any other failure's sentence is Schema's, and is for a log only.
 */
export function readAtEdge<S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	input: string,
): { ok: true; value: S["Type"] } | { ok: false; say: string } {
	const read = Schema.decodeUnknownResult(schema)(input);

	return Result.isSuccess(read)
		? { ok: true, value: read.success }
		: { ok: false, say: read.failure.message };
}

/**
 * A category name as the form compares it: ignoring case (Unicode-aware, unlike SQL NOCASE) and spacing. It is stored
 * as `name_key`, which the unique index checks, so the database refuses the second of two saves at once (migration 0052).
 */
export const nameKey = (name: string) => normalizeName(name).toLowerCase();

/** Whether two category names are the same, ignoring case (Unicode-aware, unlike SQL NOCASE) and spacing. */
export const sameName = (a: string, b: string) => nameKey(a) === nameKey(b);

/**
 * The active category with this name (ignoring case and spacing), or undefined. The one check for "is this name an
 * active category": the form, the Maybe card's "Existing category" row and the naming's choices all use it (decision 165).
 */
export function activeNamed<T extends { name: string; archived?: boolean }>(
	name: string,
	categories: readonly T[],
): T | undefined {
	return categories.find((c) => !c.archived && sameName(c.name, name));
}

const activeCount = (existing: Existing) =>
	existing.filter((c) => !c.archived).length;

/** A form that holds one category name, as parseCategory reads it (a New category name typed in a panel). */
export function nameForm(name: string | File | null): FormData {
	const form = new FormData();
	form.set("name", String(name ?? ""));

	return form;
}

/** Reads the add or rename form. `id` is the category being renamed, or null when adding one. */
export function parseCategory(
	form: FormData,
	existing: Existing,
	id: number | null,
): { ok: true; value: CategoryValue } | { ok: false; errors: CategoryErrors } {
	const read = readAtEdge(CategoryName, String(form.get("name") ?? ""));
	const name = read.ok ? read.value : "";
	const errors: CategoryErrors = {};

	const clash = existing.find((c) => c.id !== id && sameName(c.name, name));

	if (!read.ok) errors.name = read.say;
	else if (sameName(name, NONE_FIT))
		errors.name = "That name is reserved for Tally. Pick another.";
	else if (clash)
		errors.name = clash.archived
			? "An archived category has that name. Restore it instead."
			: "That name is taken.";
	else if (id === null && activeCount(existing) >= MAX_ACTIVE)
		errors.name = fullMessage("add");

	if (Object.keys(errors).length > 0) return { ok: false, errors };

	return { ok: true, value: { name } };
}

/** Why an archived category can't come back right now, or null when it can. */
export function restoreProblem(existing: Existing): string | null {
	return activeCount(existing) >= MAX_ACTIVE ? fullMessage("restore") : null;
}

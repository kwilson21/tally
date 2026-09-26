// What the Settings form may save for a category, checked before anything is written (spec §7).
import { NONE_FIT } from "../ai/decide";

const MAX_NAME = 40;
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

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const activeCount = (existing: Existing) =>
	existing.filter((c) => !c.archived).length;

/** Reads the add or rename form. `id` is the category being renamed, or null when adding one. */
export function parseCategory(
	form: FormData,
	existing: Existing,
	id: number | null,
): { ok: true; value: CategoryValue } | { ok: false; errors: CategoryErrors } {
	const name = String(form.get("name") ?? "").trim();
	const errors: CategoryErrors = {};

	const clash = existing.find((c) => c.id !== id && same(c.name, name));
	if (name === "") errors.name = "Give the category a name.";
	else if (name.length > MAX_NAME)
		errors.name = `Keep the name to ${MAX_NAME} characters.`;
	else if (same(name, NONE_FIT))
		errors.name = "That name is reserved for Jev. Pick another.";
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

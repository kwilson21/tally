// What the Settings form may save for a category, checked before anything is written (spec §7).
import { NONE_FIT } from "../ai/decide";
import { toCents } from "../money";

const MAX_NAME = 40;
/** Jev's Choice question takes 255 options, and "None of these fit" is always one of them. */
export const MAX_ACTIVE = 254;

type Existing = { id: number; name: string; archived: boolean }[];
export type CategoryValue = { name: string; budgetCents: number | null };
export type CategoryErrors = Partial<Record<"name" | "budget", string>>;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const activeCount = (existing: Existing) =>
	existing.filter((c) => !c.archived).length;

/** Reads the add or edit form. `id` is the category being edited, or null when adding one. */
export function parseCategory(
	form: FormData,
	existing: Existing,
	id: number | null,
): { ok: true; value: CategoryValue } | { ok: false; errors: CategoryErrors } {
	const name = String(form.get("name") ?? "").trim();
	const budget = String(form.get("budget") ?? "").trim();
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
		errors.name = `Tally has room for ${MAX_ACTIVE} categories. Archive one to add another.`;

	let budgetCents: number | null = null;
	if (budget !== "") {
		try {
			budgetCents = toCents(budget);
		} catch {
			budgetCents = -1;
		}
		if (budgetCents < 0)
			errors.budget = "Enter a dollar amount, like 250 or 250.50.";
	}

	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return { ok: true, value: { name, budgetCents } };
}

/** Why an archived category can't come back right now, or null when it can. */
export function restoreProblem(existing: Existing): string | null {
	return activeCount(existing) >= MAX_ACTIVE
		? `Tally has room for ${MAX_ACTIVE} categories. Archive one to restore another.`
		: null;
}

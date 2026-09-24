// What the edit panel's form may change, checked before anything is saved.

export type Edit = {
	/** null leaves the category as it is. */
	categoryId: number | null;
	alwaysForMerchant: boolean;
	/** null falls back to the bank's raw name. */
	displayName: string | null;
	note: string | null;
};

export type EditErrors = Partial<
	Record<"category" | "merchant" | "note", string>
>;

const MAX_NAME = 80;
const MAX_NOTE = 500;

const text = (form: FormData, key: string) =>
	String(form.get(key) ?? "").trim();

/** Reads the edit form. Category ids must be live categories; lengths are limited. */
export function parseEdit(
	form: FormData,
	categoryIds: number[],
): { ok: true; value: Edit } | { ok: false; errors: EditErrors } {
	const errors: EditErrors = {};
	const rawCategory = text(form, "category");
	const categoryId = rawCategory === "" ? null : Number(rawCategory);
	const alwaysForMerchant = form.get("always") === "1";
	const displayName = text(form, "merchant");
	const note = text(form, "note");

	if (categoryId !== null && !categoryIds.includes(categoryId)) {
		errors.category = "Pick a category from the list.";
	} else if (alwaysForMerchant && categoryId === null) {
		errors.category = "Pick a category to use for this merchant.";
	}
	if (displayName.length > MAX_NAME)
		errors.merchant = `Keep the name under ${MAX_NAME} characters.`;
	if (note.length > MAX_NOTE)
		errors.note = `Keep the note under ${MAX_NOTE} characters.`;

	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			categoryId,
			alwaysForMerchant,
			displayName: displayName || null,
			note: note || null,
		},
	};
}

const LIST_URL = /^\/transactions(\?[^#]*)?$/;

/** Where to go after saving: only ever back to a Transactions list URL, so the form can't redirect elsewhere. */
export function safeBack(url: string | null | undefined): string {
	return url && LIST_URL.test(url) ? url : "/transactions";
}

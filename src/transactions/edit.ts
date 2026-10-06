// What the edit panel's form may change, checked before anything is saved.

export type Edit = {
	/** null leaves the category as it is. */
	categoryId: number | null;
	alwaysForMerchant: boolean;
	/** null falls back to the bank's raw name. */
	displayName: string | null;
	/**
	 * The person gave this merchant a name in this form (picked a suggestion, typed one, or cleared it), so
	 * `displayName` is written. False leaves the merchant's name and its suggestion alone, so a panel
	 * opened before the name changed elsewhere can't put the old one back or erase the new one. Missing
	 * means yes, for callers that build an edit without a form.
	 */
	nameChanged?: boolean;
	/**
	 * "Keep the bank's name" was chosen from the suggested names (P29 A): the merchant keeps its tidied
	 * bank text, and its suggestions are turned down. Only with no name typed.
	 */
	keepBankName?: boolean;
	note: string | null;
	/** Left out of the budget (spec §6). A person can always toggle it. */
	excluded: boolean;
	/** Whether this transaction is income; a person can correct Jev's suggestion. */
	income: boolean;
	/** Whether a bank credit was reviewed as a refund or other non-income credit. */
	creditReviewed: boolean;
	/** False when the edit form omitted the credit-review control for an income credit. */
	creditReviewedProvided?: boolean;
	/**
	 * The purchase this refund refunds. Left out, the link stays; null unlinks. A purchase links it,
	 * unless it's more than what's left of that purchase (saveEdit refuses it, spec §8.5), and
	 * counts it in the budget even if it was excluded.
	 */
	refundOfId?: number | null;
};

export type EditErrors = Partial<
	Record<"category" | "merchant" | "note" | "refund", string>
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
	// A name typed in the field is a person's own and wins over a chip. The chips (P29 A) post `name_pick`:
	// "s:" and a suggested name, or "keep" for the bank's. No chip is chosen to start with.
	const typedName = text(form, "merchant");
	const pick = text(form, "name_pick");
	const pickedName = pick.startsWith("s:") ? pick.slice(2).trim() : "";
	const displayName = typedName || pickedName;
	const keepBankName = !typedName && pick === "keep";
	// The panel says what the name field held when it was drawn (`merchant_was`). A field that still holds
	// it is not a rename, and an emptied one is a person clearing the name; with no `merchant_was` the field
	// is read as it always was.
	const shown = form.get("merchant_was");
	const fieldChanged = shown === null || typedName !== String(shown).trim();
	const nameChanged = typedName
		? fieldChanged
		: pickedName
			? true
			: keepBankName
				? false
				: fieldChanged;
	const note = text(form, "note");
	const excluded = form.get("excluded") === "1";
	const income = form.get("income") === "1";
	const creditReviewed = form.get("creditReviewed") === "1";
	const creditReviewedProvided =
		form.get("creditReviewedVisible") === "1" || form.has("creditReviewed");

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
			nameChanged,
			keepBankName,
			note: note || null,
			excluded,
			income,
			creditReviewed,
			creditReviewedProvided,
		},
	};
}

const LIST_URL = /^\/transactions(\?[^#]*)?$/;

/** Where to go after saving: only ever back to a Transactions list URL, so the form can't redirect elsewhere. */
export function safeBack(url: string | null | undefined): string {
	return url && LIST_URL.test(url) ? url : "/transactions";
}

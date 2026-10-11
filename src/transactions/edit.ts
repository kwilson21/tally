// What the edit panel's form may change, checked before anything is saved.

import { followsPurchase } from "../db/counted-month";

export type Edit = {
	/** null leaves the category as it is. */
	categoryId: number | null;
	alwaysForMerchant: boolean;
	/** Toggle state when the panel opened. */
	alwaysWas?: boolean;
	/** Rule category shown when this panel opened, for clearing only the unchanged rule on save. */
	merchantRuleWas?: number | null;
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
	 * Which transactions a name reaches (decision 101): "one" gives this transaction its own name and
	 * leaves the merchant alone; "all" renames the merchant. Left out means "all", for callers that build an
	 * edit without a form; the form always says which.
	 */
	nameScope?: "one" | "all";
	/**
	 * "The store's own name" was chosen (decision 101): the bank's text tidied stays, and the merchant's
	 * suggestions are turned down when the name is for all of them. Its display name is then empty.
	 */
	keepBankName?: boolean;
	/**
	 * Jev answers categories now: its key is set and the categories switch is on. The route sets it; a
	 * one-off name lets Tally guess the category again only then (src/transactions/rename.ts).
	 */
	jevCategories?: boolean;
	note: string | null;
	noteWas?: string | null;
	noteProvided?: boolean;
	detailsFieldChanged?: boolean;
	/** Left out of the budget (spec §6). A person can always toggle it. */
	excluded: boolean;
	/** Whether this transaction is income; a person can correct Jev's suggestion. */
	income: boolean;
	/** The value shown when the person opened the form, so an unchanged post is not a new answer. */
	incomeWas?: boolean;
	/** Whether a bank credit was reviewed as a refund or other non-income credit. */
	creditReviewed: boolean;
	creditReviewedWas?: boolean;
	/** False when the edit form omitted the credit-review control for an income credit. */
	creditReviewedProvided?: boolean;
	kind?: "subscription" | "one_off" | "bill" | "transfer" | null;
	kindWas?: "subscription" | "one_off" | "bill" | "transfer" | null;
	forPersonId?: number | null;
	forPersonIdWas?: number | null;
	keepDetails?: boolean;
	/** False when the panel hid guesses because the details switch was off. */
	detailsVisible?: boolean;
	/**
	 * The purchase this refund refunds. Left out, the link stays; null unlinks. A purchase links it,
	 * unless it's more than what's left of that purchase (saveEdit refuses it, spec §8.5), and
	 * counts it in the budget even if it was excluded.
	 */
	refundOfId?: number | null;
	cashDate?: string;
	cashAmountCents?: number;
};

/** The edit panel changes a merchant rule only when the person changes the toggle. */
export function merchantRuleChange(
	alwaysWas: boolean,
	alwaysNow: boolean,
	ruleCategoryWas: number | null | undefined,
	categoryId: number | null,
): { action: "set" | "clear" | "keep"; recategorize: boolean } {
	if (!alwaysWas && alwaysNow)
		return { action: "set", recategorize: categoryId !== null };
	if (alwaysWas && !alwaysNow && ruleCategoryWas != null)
		return { action: "clear", recategorize: false };
	return { action: "keep", recategorize: false };
}

export type EditErrors = Partial<
	Record<
		| "category"
		| "merchant"
		| "note"
		| "refund"
		| "kind"
		| "forPerson"
		| "date"
		| "amount",
		string
	>
>;

const MAX_NAME = 80;
const MAX_NOTE = 500;

const text = (form: FormData, key: string) =>
	String(form.get(key) ?? "").trim();

/** The income and review answers the edit form posts. The "was" answers are undefined when the form omits them. */
export function postedCredit(
	form: FormData,
): Pick<
	Edit,
	| "income"
	| "incomeWas"
	| "creditReviewed"
	| "creditReviewedWas"
	| "creditReviewedProvided"
> {
	return {
		income: form.get("income") === "1",
		incomeWas: form.has("income_was")
			? form.get("income_was") === "1"
			: undefined,
		creditReviewed: form.get("creditReviewed") === "1",
		creditReviewedWas: form.has("creditReviewed_was")
			? form.get("creditReviewed_was") === "1"
			: undefined,
		creditReviewedProvided:
			form.get("creditReviewedVisible") === "1" || form.has("creditReviewed"),
	};
}

/**
 * Whether a linked credit counts with its purchase once this edit is saved, so the edit panel's lock and
 * "Counts in" line and the route's category drop say how the row will really count. saveEdit writes only the
 * income and review answers the person changed (against what the panel showed), keeps the rest, and a save
 * clears only a review a person made, so a review Jev holds stays. A new link reviews a credit. This follows
 * those writes. The purchase (linked, not excluded) is the caller's to check.
 */
export function followsPurchaseAfterSave(
	stored: {
		amountCents: number;
		refundOfId?: number | null;
		income: boolean;
		incomeSource: string | null;
		creditReviewed: boolean;
		creditReviewedByUser: boolean;
	},
	edit: Pick<
		Edit,
		| "refundOfId"
		| "income"
		| "incomeWas"
		| "creditReviewed"
		| "creditReviewedWas"
		| "creditReviewedProvided"
	>,
): boolean {
	const linking =
		typeof edit.refundOfId === "number" &&
		edit.refundOfId !== (stored.refundOfId ?? null);
	const incomeChanged = edit.income !== (edit.incomeWas ?? stored.income);
	const reviewChanged =
		edit.creditReviewedProvided !== false &&
		edit.creditReviewed !==
			(edit.creditReviewedWas ?? stored.creditReviewedByUser);
	// A review ticked as not income turns income off whatever the panel drew (saveEdit's flag_income).
	const reviewedAsNotIncome =
		reviewChanged && edit.creditReviewed && !edit.income;
	// Unticking income on a Jev credit, with the review unticked, leaves it unreviewed (saveEdit's credit_reviewed).
	const unreviewedByIncome =
		incomeChanged && !edit.creditReviewed && stored.incomeSource === "jev";
	// saveEdit clears only a review a person made (credit_reviewed_by = 'user'); a review Jev holds stays.
	const reviewCleared =
		reviewChanged && !edit.creditReviewed && stored.creditReviewedByUser;
	return followsPurchase({
		amountCents: stored.amountCents,
		income: incomeChanged || reviewedAsNotIncome ? edit.income : stored.income,
		// A new link is written as a review last, so it wins over the review chip and the Jev rule (saveEdit).
		creditReviewed:
			linking ||
			(reviewChanged && edit.creditReviewed) ||
			(stored.creditReviewed && !reviewCleared && !unreviewedByIncome),
	});
}

/** Reads the edit form. Category ids must be live categories; lengths are limited. */
export function parseEdit(
	form: FormData,
	categoryIds: number[],
	peopleIds?: number[],
): { ok: true; value: Edit } | { ok: false; errors: EditErrors } {
	const errors: EditErrors = {};
	const rawCategory = text(form, "category");
	const categoryId = rawCategory === "" ? null : Number(rawCategory);
	const alwaysForMerchant = form.get("always") === "1";
	const alwaysWas = form.get("always_was") === "1";
	const ruleCategoryWas = Number(form.get("rule_category_was")) || null;
	// The Name row is one choice (decision 101), posted as `name_pick`: "s:" and a suggested name, "store" for
	// the store's own name (the bank's text tidied, which clears a name), or "own" for the name typed in the
	// field. Only the ticked choice counts, and nothing is ticked at rest, so a save for another reason never
	// renames anything.
	const pick = text(form, "name_pick");
	const typedName = pick === "own" ? text(form, "merchant") : "";
	const pickedName = pick.startsWith("s:") ? pick.slice(2).trim() : "";
	const keepBankName = pick === "store";
	const displayName = pick === "own" ? typedName : pickedName;
	// The panel says what the name field held when it was drawn (`merchant_was`). With "own" ticked, a typed
	// name the merchant already has is no rename of the merchant under All, so the merchant keeps it. Under
	// This one only it still names this transaction. (A save under All that replaces this transaction's own
	// name counts as a change too; savePanel sets that once it knows the row has one.)
	const shown = form.get("merchant_was");
	const fieldChanged = shown === null || typedName !== String(shown).trim();
	const note = text(form, "note");
	const rawKind = text(form, "kind");
	const allowedKinds = ["subscription", "one_off", "bill", "transfer"];
	const kind = allowedKinds.includes(rawKind)
		? (rawKind as "subscription" | "one_off" | "bill" | "transfer")
		: null;
	const rawPerson = text(form, "for_person_id");
	const forPersonId = rawPerson ? Number(rawPerson) : null;
	const keepDetails = form.get("details_action") === "keep";
	// "Rename" (decision 101): this transaction alone, unless the scope says all the merchant's. A ticked name
	// under "Looks right" takes this choice like Save does; with nothing ticked, savePanel names the store's
	// guess for all (src/routes/transactions.tsx).
	const nameScope: "one" | "all" =
		form.get("name_scope") === "all" ? "all" : "one";
	const nameChanged =
		pick === "own"
			? nameScope === "one" || fieldChanged
			: pickedName !== "" || keepBankName;
	const detailsVisible = form.has("details_visible")
		? form.get("details_visible") !== "0"
		: undefined;
	const hiddenUntouched = detailsVisible === false;
	const noteWas = text(form, "note_was");
	const kindWas = text(form, "kind_was");
	const personWasRaw = text(form, "for_person_id_was");
	const personWas = personWasRaw ? Number(personWasRaw) : null;
	const excluded = form.get("excluded") === "1";
	const credit = postedCredit(form);

	if (categoryId !== null && !categoryIds.includes(categoryId)) {
		errors.category = "Pick a category from the list.";
	} else if (!alwaysWas && alwaysForMerchant && categoryId === null) {
		errors.category = "Pick a category to use for this merchant.";
	}
	if (displayName.length > MAX_NAME)
		errors.merchant = `Keep the name under ${MAX_NAME} characters.`;
	else if (pick === "own" && displayName === "")
		errors.merchant = "Type a name here, or pick one above.";
	if (note.length > MAX_NOTE)
		errors.note = `Keep the note under ${MAX_NOTE} characters.`;
	if (rawKind && !allowedKinds.includes(rawKind))
		errors.kind = "Pick a kind from the list.";
	if (
		rawPerson &&
		(!Number.isInteger(forPersonId) ||
			(peopleIds && !peopleIds.includes(forPersonId as number)))
	)
		errors.forPerson = "Pick a person from the household list.";

	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			categoryId,
			alwaysForMerchant,
			alwaysWas,
			merchantRuleWas: ruleCategoryWas,
			displayName: displayName || null,
			nameChanged,
			nameScope,
			keepBankName,
			note: note || null,
			...(form.has("details_visible")
				? {
						noteProvided: !(
							hiddenUntouched &&
							((!form.has("note_was") && note === "") ||
								(form.has("note_was") && note === noteWas))
						),
						detailsFieldChanged:
							hiddenUntouched &&
							((form.has("kind_was") && kind !== kindWas) ||
								(form.has("for_person_id_was") && forPersonId !== personWas)),
					}
				: {}),
			excluded,
			...credit,
			kind:
				form.has("kind") &&
				(!hiddenUntouched ||
					(form.has("kind_was") ? kind !== kindWas : kind !== null))
					? kind
					: undefined,
			forPersonId:
				form.has("for_person_id") &&
				(!hiddenUntouched ||
					(form.has("for_person_id_was")
						? forPersonId !== personWas
						: forPersonId !== null))
					? forPersonId
					: undefined,
			keepDetails,
			...(detailsVisible === undefined ? {} : { detailsVisible }),
		},
	};
}

const LIST_URL = /^\/transactions(\?[^#]*)?$/;

/** Where to go after saving: only ever back to a Transactions list URL, so the form can't redirect elsewhere. */
export function safeBack(url: string | null | undefined): string {
	return url && LIST_URL.test(url) ? url : "/transactions";
}

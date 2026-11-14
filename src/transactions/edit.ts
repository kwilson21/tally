// What the edit panel's form may change, checked before anything is saved.

import { followsPurchase } from "../db/counted-month";
import { DISPLAY_NAME_MAX, NOTE_MAX } from "../limits";
import { isTransactionKind, type TransactionKind } from "./kind";

export type Edit = {
	/** null leaves the category as it is. */
	categoryId: number | null;
	/**
	 * "New category" was chosen: the save makes the category from the name typed under the chips, then files
	 * the transaction in it (the route makes it, once everything else checks). categoryId is null until then.
	 */
	newCategory?: boolean;
	/** The name typed under the chips, kept for a panel drawn again after an error. Only a choice counts. */
	newCategoryName?: string;
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
	/** The Exclude value the panel showed when opened, so a stale panel's unchanged Exclude is not a new answer. */
	excludedWas?: boolean;
	/** Whether this transaction is income; a person can correct Jev's suggestion. */
	income: boolean;
	/** The value shown when the person opened the form, so an unchanged post is not a new answer. */
	incomeWas?: boolean;
	/** Whether a bank credit was reviewed as a refund or other non-income credit. */
	creditReviewed: boolean;
	creditReviewedWas?: boolean;
	/** False when the edit form omitted the credit-review control for an income credit. */
	creditReviewedProvided?: boolean;
	kind?: TransactionKind | null;
	kindWas?: TransactionKind | null;
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

/** The edit panel changes a merchant rule only when the person changes the tick, or saves a ticked row with another category. */
/** What a save does to the merchant's rule: set it, clear it or keep it, and whether to refile the merchant's rows. */
type MerchantRuleChange = {
	action: "set" | "clear" | "keep";
	recategorize: boolean;
};

export function merchantRuleChange(
	alwaysWas: boolean,
	alwaysNow: boolean,
	ruleCategoryWas: number | null | undefined,
	categoryId: number | null,
): MerchantRuleChange {
	if (!alwaysWas && alwaysNow)
		return { action: "set", recategorize: categoryId !== null };

	if (alwaysWas && !alwaysNow && ruleCategoryWas != null)
		return { action: "clear", recategorize: false };

	// A ticked row saved with another category changes the rule to it, as a new tick does (spec §7, decision 101).
	if (
		alwaysWas &&
		alwaysNow &&
		categoryId !== null &&
		ruleCategoryWas != null &&
		categoryId !== ruleCategoryWas
	)
		return { action: "set", recategorize: true };

	return { action: "keep", recategorize: false };
}

export type EditErrors = Partial<
	Record<
		| "category"
		| "newCategory"
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

/** The For field's error when the chosen person is not in the household (the form or the save). */
export const FOR_PERSON_ERROR = "Pick a person from the household list.";

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

/** Whether the review chip was changed from the state the panel showed (saveEdit's creditReviewChanged). */
function reviewWasChanged(
	stored: { creditReviewedByUser: boolean },
	edit: Pick<
		Edit,
		"creditReviewed" | "creditReviewedWas" | "creditReviewedProvided"
	>,
): boolean {
	return (
		edit.creditReviewedProvided !== false &&
		edit.creditReviewed !==
			(edit.creditReviewedWas ?? stored.creditReviewedByUser)
	);
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
		isIdNumber(edit.refundOfId) &&
		edit.refundOfId !== (stored.refundOfId ?? null);

	const incomeChanged = edit.income !== (edit.incomeWas ?? stored.income);
	const reviewChanged = reviewWasChanged(stored, edit);

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

/**
 * Whether a save leaves Exclude as the row is stored. The panel says what Exclude looked like when it loaded
 * (excludedWas); when the posted value is that same one, the person did not change it, so a sync or Jev may have
 * changed the row since, and the save must not write the old value back (#1086). A refund link is never kept: it
 * includes the row whatever the chip held (saveEdit). Without excludedWas (older callers) Exclude is always written.
 */
export function excludeKept(
	edit: Pick<Edit, "excluded" | "excludedWas">,
	linking: boolean,
): boolean {
	return (
		!linking &&
		edit.excludedWas !== undefined &&
		edit.excluded === edit.excludedWas
	);
}

/**
 * Whether a row is excluded from the budget once this edit is saved. The panel posts its Exclude chip as it was drawn,
 * so this is what the save leaves, not what was posted: a new link includes the row (saveEdit writes excluded = 0),
 * a save that leaves Exclude alone keeps the stored one (excludeKept), and a save lifts Plaid's exclusion off a credit
 * it reviews as not income or marks as income (saveEdit's lift, decision 70). A person's or Jev's exclusion is never
 * lifted. test/excluded-after-save.test.ts runs saveEdit for every stored exclusion and every answer the panel can
 * post, and fails where this and the row it leaves disagree.
 * A bill payment counts whatever its exclusion, which isIncluded (src/db/counted-month.ts) reads.
 */
export function excludedAfterSave(
	stored: {
		amountCents: number;
		excluded: boolean;
		excludedSource: string | null;
		refundOfId?: number | null;
		income: boolean;
		creditReviewedByUser: boolean;
	},
	edit: Pick<
		Edit,
		| "excluded"
		| "excludedWas"
		| "refundOfId"
		| "income"
		| "creditReviewed"
		| "creditReviewedWas"
		| "creditReviewedProvided"
	>,
): boolean {
	const linking =
		isIdNumber(edit.refundOfId) &&
		edit.refundOfId !== (stored.refundOfId ?? null);

	const kept = excludeKept(edit, linking);

	if (linking || !(kept ? stored.excluded : edit.excluded)) return false;

	// The lift's two triggers, as saveEdit writes them: a review ticked as not income, or income turned on.
	const reviewedAsNotIncome =
		reviewWasChanged(stored, edit) && edit.creditReviewed && !edit.income;

	const incomeTurnedOn = edit.income && !stored.income;

	const lifted =
		stored.excluded &&
		stored.excludedSource === "plaid" &&
		stored.amountCents < 0 &&
		(reviewedAsNotIncome || incomeTurnedOn);

	return !lifted;
}

/** True for a stored or posted id that is a number (not null or absent). */
const isIdNumber = (value: number | null | undefined): value is number =>
	typeof value === "number";

/** True for an integer, as Number.isInteger reads it; a value that is not one (null included) is false. */
const isWholeNumber = (value: number | null): value is number =>
	Number.isInteger(value);

/** Reads the edit form. Category ids must be live categories; lengths are limited. */
export function parseEdit(
	form: FormData,
	categoryIds: number[],
	peopleIds?: number[],
): { ok: true; value: Edit } | { ok: false; errors: EditErrors } {
	const errors: EditErrors = {};
	const rawCategory = text(form, "category");
	const newCategory = rawCategory === "new";

	const categoryId =
		rawCategory === "" || newCategory ? null : Number(rawCategory);

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
	const kind = isTransactionKind(rawKind) ? rawKind : null;
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
	const kindWas = text(form, "kind_was") || null;
	const personWasRaw = text(form, "for_person_id_was");
	const personWas = personWasRaw ? Number(personWasRaw) : null;
	const excluded = form.get("excluded") === "1";

	const excludedWas = form.has("excluded_was")
		? form.get("excluded_was") === "1"
		: undefined;

	const credit = postedCredit(form);

	if (categoryId !== null && !categoryIds.includes(categoryId)) {
		errors.category = "Pick a category from the list.";
	} else if (
		!alwaysWas &&
		alwaysForMerchant &&
		categoryId === null &&
		!newCategory
	) {
		errors.category = "Pick a category to use for this merchant.";
	}

	if (displayName.length > DISPLAY_NAME_MAX)
		errors.merchant = `Keep the name under ${DISPLAY_NAME_MAX} characters.`;
	else if (pick === "own" && displayName === "")
		errors.merchant = "Type a name here, or pick one above.";

	if (note.length > NOTE_MAX)
		errors.note = `Keep the note under ${NOTE_MAX} characters.`;

	if (rawKind && !isTransactionKind(rawKind))
		errors.kind = "Pick a kind from the list.";

	if (
		rawPerson &&
		(!isWholeNumber(forPersonId) ||
			(peopleIds && !peopleIds.includes(forPersonId)))
	)
		errors.forPerson = FOR_PERSON_ERROR;

	if (Object.keys(errors).length > 0) return { ok: false, errors };

	const value: Edit = {
		categoryId,
		alwaysForMerchant,
		alwaysWas,
		merchantRuleWas: ruleCategoryWas,
		displayName: displayName || null,
		nameChanged,
		nameScope,
		keepBankName,
		note: note || null,
		excluded,
		excludedWas,
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
	};

	if (newCategory) value.newCategory = true;

	if (form.has("details_visible")) {
		value.noteProvided = !(
			hiddenUntouched &&
			((!form.has("note_was") && note === "") ||
				(form.has("note_was") && note === noteWas))
		);
		value.detailsFieldChanged =
			hiddenUntouched &&
			((form.has("kind_was") && kind !== kindWas) ||
				(form.has("for_person_id_was") && forPersonId !== personWas));
	}

	if (detailsVisible !== undefined) value.detailsVisible = detailsVisible;

	return { ok: true, value };
}

const LIST_URL = /^\/transactions(\?[^#]*)?$/;

/** Where to go after saving: only ever back to a Transactions list URL, so the form can't redirect elsewhere. */
export function safeBack(url: string | null | undefined): string {
	return url && LIST_URL.test(url) ? url : "/transactions";
}

/**
 * A transfer credit a person turns Exclude off on counts as income, reviewed by that person (#878; the owner's
 * rule in chat on 2026-11-13, decision 217). A transfer credit is one Tally marked as a transfer or one whose Plaid
 * category is a transfer one (decision 227). The edit it returns is what saveEdit writes: the same save with the
 * income and the review ticked. It only applies when the save changes nothing else about income or review, so an
 * explicit review as not income wins, and so does a link as a refund. A split part or parent, a row that isn't a
 * transfer credit, a row that is already income or already linked (as a refund), a row whose income the person already
 * chose (income_source 'user', so unticking it and excluding it again keeps it not income), and a credit the person
 * already reviewed as not income keep their own rules.
 */
export function includedTransferCredit(
	edit: Edit,
	stored: {
		amountCents: number;
		flagTransfer: number;
		/** True when Plaid's category marks the row as a transfer (decision 227), whatever flagTransfer says. */
		plaidTransfer: boolean;
		excluded: number;
		income: number;
		isSplit: number;
		parentId: number | null;
		refundOfId: number | null;
		incomeSource: string | null;
		creditReviewedByUser: boolean;
	},
): Edit {
	// Exclude must have been on in the panel the person saw (excludedWas), so a stale panel whose Exclude was
	// already off when drawn cannot turn a credit a sync excluded after the page loaded into income. Without
	// excludedWas (older callers) only the posted Exclude counts.
	const turnedOffTransferCredit =
		stored.amountCents < 0 &&
		(stored.flagTransfer === 1 || stored.plaidTransfer) &&
		stored.excluded === 1 &&
		stored.income === 0 &&
		stored.isSplit === 0 &&
		stored.parentId === null &&
		stored.refundOfId === null &&
		stored.incomeSource !== "user" &&
		!stored.creditReviewedByUser &&
		(edit.excludedWas ?? true) &&
		!edit.excluded;

	const linking =
		edit.refundOfId !== undefined &&
		edit.refundOfId !== null &&
		edit.refundOfId !== stored.refundOfId;

	const incomeLeftAlone =
		(edit.incomeWas ?? stored.income === 1) === edit.income;

	const reviewLeftAlone =
		edit.creditReviewedProvided === false ||
		edit.creditReviewed ===
			(edit.creditReviewedWas ?? stored.creditReviewedByUser);

	if (
		!turnedOffTransferCredit ||
		linking ||
		!incomeLeftAlone ||
		!reviewLeftAlone
	)
		return edit;

	return {
		...edit,
		income: true,
		incomeWas: false,
		creditReviewed: true,
		creditReviewedWas: false,
		creditReviewedProvided: true,
	};
}

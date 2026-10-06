// Turns Jev's answers into what gets stored (spec §7). Jev suggests; this code decides.

export type Flag = "transfer" | "reimbursement" | "income";

/** The extra option Jev can pick when no category fits; it never applies a category (decision 29). */
export const NONE_FIT = "None of these fit";

/** What Jev said about one transaction: its category pick and a yes-probability per flag. */
export type JevAnswer = {
	category: { label: string; confidence: number };
	flags: Record<Flag, number>;
	kind?: { label: string; confidence: number };
	forPerson?: { label: string; confidence: number };
};

export type Decision = {
	/** Jev's explicit no-fit answer, distinct from an unanswered category question. */
	noneFit?: boolean;
	/** The category to apply, or null when Jev wasn't confident enough (or named no known category). */
	categoryId: number | null;
	/** Jev's pick whether or not it's applied; null when Jev said none fit (decision 29). */
	suggestedCategoryId: number | null;
	/** Always stored, so a transaction Jev was unsure about isn't asked again (decision 27). */
	confidence: number;
	flags: Record<Flag, boolean>;
};

/**
 * `categories` is the household's categories-and-exclusions switch (spec §8.6). Off, Jev's category
 * answer is neither applied nor suggested and its transfer and reimbursement flags exclude nothing;
 * the confidence is still kept, so the transaction isn't asked about again. The income answer
 * belongs to the income switch, which `saveJevResult` honors.
 */
export function decide(
	answer: JevAnswer,
	categories: { id: number; name: string }[],
	threshold: number,
	{ categories: categoriesOn = true }: { categories?: boolean } = {},
): Decision {
	const match =
		answer.category.label === NONE_FIT || !categoriesOn
			? undefined
			: categories.find((c) => c.name === answer.category.label);
	const confidence = answer.category.confidence;
	const confident = confidence >= threshold;
	return {
		noneFit: answer.category.label === NONE_FIT && categoriesOn,
		categoryId: match && confident ? match.id : null,
		suggestedCategoryId: match ? match.id : null,
		confidence,
		flags: {
			transfer: categoriesOn && answer.flags.transfer >= threshold,
			reimbursement: categoriesOn && answer.flags.reimbursement >= threshold,
			income: answer.flags.income >= threshold,
		},
	};
}

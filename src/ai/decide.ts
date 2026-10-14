// Turns Jev's answers into what gets stored (spec §7). Jev suggests; this code decides.
import { meetsConfidenceThreshold } from "./confidence";

export type Flag = "transfer" | "reimbursement" | "income";

/** The extra option Jev can pick when no category fits; it never applies a category (decision 29). */
export const NONE_FIT = "None of these fit";

/** What Jev said about one transaction: its category pick and a yes-probability per flag. */
export type JevAnswer = {
	category: { label: string; confidence: number };
	flags: Record<Flag, number>;
	kind?: { label: string; confidence: number };
	forPerson?: { label: string; confidence: number };
	/** Jev's yes-probability that a "what it was" line could say more than the store's name (decision 103). */
	noteWorthWriting?: number;
	/**
	 * Jev's probability that the trip spans more than one category, and the other category it named (#233): a
	 * category label, or NONE_FIT when it named none. Absent when Jev wasn't asked (no categories).
	 */
	mixed?: { probability: number; also: string };
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
	/** Jev's raw yes-probabilities for flags, retained for below-threshold suggestions. */
	flagConfidence?: Record<Flag, number>;
	flags: Record<Flag, boolean>;
	/** Jev's probability the trip spans more than one category, stored as given (#233); absent or null when not asked. */
	mixedProbability?: number | null;
	/** The other active category Jev named, or null when it named none, or none is active (#233). */
	alsoCategoryId?: number | null;
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
	const confident = meetsConfidenceThreshold(
		answer.category.confidence,
		threshold,
	);
	// The mixed-trip reading belongs to the categories switch, as the category answer does (#233). Absent when
	// Jev gave none, so a decision without one reads as it always did.
	const mixed = categoriesOn ? answer.mixed : undefined;
	return {
		noneFit: answer.category.label === NONE_FIT && categoriesOn,
		...(mixed
			? {
					mixedProbability: mixed.probability,
					alsoCategoryId:
						mixed.also !== NONE_FIT
							? (categories.find((c) => c.name === mixed.also)?.id ?? null)
							: null,
				}
			: {}),
		categoryId: match && confident ? match.id : null,
		suggestedCategoryId: match ? match.id : null,
		confidence: answer.category.confidence,
		flagConfidence: answer.flags,
		flags: {
			transfer:
				categoriesOn &&
				meetsConfidenceThreshold(answer.flags.transfer, threshold),
			reimbursement:
				categoriesOn &&
				meetsConfidenceThreshold(answer.flags.reimbursement, threshold),
			income: meetsConfidenceThreshold(answer.flags.income, threshold),
		},
	};
}

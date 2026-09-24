// Turns Jev's answers into what gets stored (spec §7). Jev suggests; this code decides.

export type Flag = "transfer" | "reimbursement" | "income";

/** What Jev said about one transaction: its category pick and a yes-probability per flag. */
export type JevAnswer = {
	category: { label: string; confidence: number };
	flags: Record<Flag, number>;
};

export type Decision = {
	/** The category to apply, or null when Jev wasn't confident enough (or named no known category). */
	categoryId: number | null;
	/** Always stored, so a transaction Jev was unsure about isn't asked again (decision 27). */
	confidence: number;
	flags: Record<Flag, boolean>;
};

export function decide(
	answer: JevAnswer,
	categories: { id: number; name: string }[],
	threshold: number,
): Decision {
	const match = categories.find((c) => c.name === answer.category.label);
	const confident = answer.category.confidence >= threshold;
	return {
		categoryId: match && confident ? match.id : null,
		confidence: answer.category.confidence,
		flags: {
			transfer: answer.flags.transfer >= threshold,
			reimbursement: answer.flags.reimbursement >= threshold,
			income: answer.flags.income >= threshold,
		},
	};
}

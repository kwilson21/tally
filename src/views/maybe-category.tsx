import { JEV_THRESHOLD } from "../ai/categorize";
import { confidenceBasisPoints } from "../ai/confidence";
import { Chip } from "./chip";
import { Icon } from "./icons";

/** A low-confidence credit is a visible income guess only until someone decides what it is. */
export function maybeIncomeVisible({
	amountCents,
	income,
	incomeConfidence,
	creditReviewed,
	excluded,
	paysBill,
}: {
	amountCents: number;
	income: boolean;
	incomeConfidence?: number | null;
	creditReviewed: boolean;
	excluded?: boolean;
	paysBill?: boolean;
}) {
	const confidence =
		incomeConfidence == null ? null : confidenceBasisPoints(incomeConfidence);
	const threshold = confidenceBasisPoints(JEV_THRESHOLD);
	return (
		amountCents < 0 &&
		!income &&
		!creditReviewed &&
		!(excluded && !paysBill) &&
		incomeConfidence != null &&
		confidence !== null &&
		confidence < threshold &&
		confidence > 10_000 - threshold
	);
}

function MaybeTag({
	word,
	details,
	icon = false,
}: {
	word: "category" | "income";
	details?: string;
	icon?: boolean;
}) {
	return (
		<span class="inline-flex min-h-11 items-center gap-1 truncate rounded-control border border-dashed border-ink px-2 text-sm text-ink">
			{icon && <Icon name="circle-dashed" class="size-4" />}
			Maybe {word === "income" ? word : details}
		</span>
	);
}

/** Shared dashed category guess: a row label distinguishes a new category; a chip is chosen by a person. */
export function MaybeCategory({
	name,
	kind,
}: {
	name: string;
	kind: "new" | "category";
}) {
	return (
		<MaybeTag
			word="category"
			details={`${kind === "new" ? "new: " : ""}${name}`}
			icon
		/>
	);
}

/** A below-threshold paycheck answer uses the same dashed row tag as other Maybe suggestions. */
export function MaybeIncome() {
	return <MaybeTag word="income" />;
}

/** P32 A: first option in the category field, explicitly marked as a suggestion. */
export function SuggestedCategoryChip({
	name,
	value,
	sure,
	transactionId,
	checked = false,
}: {
	name: string;
	value: string;
	sure: number;
	transactionId: number;
	checked?: boolean;
}) {
	const confidenceId = `category-suggestion-confidence-${transactionId}-${value}`;
	return (
		<span class="relative inline-flex rounded-full border border-dashed border-ink">
			<Chip
				type="radio"
				name="category"
				value={value}
				checked={checked}
				describedBy={confidenceId}
			>
				{name} <span class="text-muted">· Suggested</span>
			</Chip>
			<span class="sr-only" id={confidenceId}>
				Tally's guess · {sure}% sure
			</span>
		</span>
	);
}

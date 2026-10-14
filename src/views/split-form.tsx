import { formatCents } from "../money";
import { splitStatus } from "../transactions/split";
import { Button } from "./button";
import { Icon } from "./icons";
import { MoneyInput } from "./money-input";
import { WhyLink } from "./why-link";

type Category = { id: number; name: string };
/**
 * A part row. `partId` is the saved part a correction updates; a new row has none. `kept` is that part's
 * own category when it is archived: the row's select offers it, and no other row does. `guess` is the category
 * id Tally guessed for this part (#233, decision 64), or empty; it stays a guess only while its category is
 * unchanged and its amount empty, so a part turns solid once a person types an amount or picks a category.
 */
export type SplitValue = {
	category: string;
	amount: string;
	partId?: number;
	kept?: Category;
	guess?: string;
};

/** Whether a part is still Tally's guess: dashed, with its category and no amount typed (#233). */
export function isGuessedPart(value: SplitValue): boolean {
	return (
		value.guess !== undefined &&
		value.guess !== "" &&
		value.category === value.guess &&
		value.amount === ""
	);
}

export function SplitLine({
	parentCents,
	amounts,
}: {
	parentCents: number;
	amounts: string[];
}) {
	const status = splitStatus(parentCents, amounts);
	return (
		<p
			class={`flex items-center gap-2 text-lg font-medium ${status.kind === "over" ? "text-over" : "text-ink"}`}
		>
			{status.kind === "done" && <Icon name="check" class="size-5" />}
			{status.text}
		</p>
	);
}

/**
 * A part's label and category select (#233). The live line draws both again out of band (`oob`) as a person
 * types or picks, so the part turns solid at once. A redraw never carries autofocus: focus must not move while
 * a person types in another part.
 */
export function PartCategory({
	index,
	value,
	categories,
	autofocus = false,
	oob = false,
}: {
	index: number;
	value: SplitValue;
	categories: Category[];
	autofocus?: boolean;
	oob?: boolean;
}) {
	const guessed = isGuessedPart(value);
	const swap = oob ? "outerHTML" : undefined;
	return (
		<>
			<label
				id={`part-label-${index}`}
				for={`part-category-${index}`}
				class="sr-only"
				hx-swap-oob={swap}
			>
				{`Part ${index + 1} category${guessed ? ", Tally's guess" : ""}`}
			</label>
			<select
				id={`part-category-${index}`}
				name="part_category"
				class={`min-h-11 rounded-full border ${guessed ? "border-dashed border-ink" : "border-rule"} bg-paper px-3`}
				hx-swap-oob={swap}
				autofocus={autofocus}
				required
			>
				<option value="">Pick a category</option>
				{[...categories, ...(value.kept ? [value.kept] : [])].map((cat) => (
					<option value={cat.id} selected={value.category === String(cat.id)}>
						{cat.name}
					</option>
				))}
			</select>
		</>
	);
}

/**
 * Tally's guess above the parts (#233): shown while a part is still Tally's guess. It is hidden, not removed, once
 * none is, so the live line can draw it again out of band (`oob`) when a person types or picks.
 */
export function GuessLine({
	label,
	guessing,
	oob = false,
}: {
	label: string;
	guessing: boolean;
	oob?: boolean;
}) {
	return (
		<p
			id="split-guess"
			hidden={!guessing}
			hx-swap-oob={oob ? "outerHTML" : undefined}
			class="flex flex-wrap items-center gap-x-2 text-sm text-muted"
		>
			{`Tally's guess: ${label} · `}
			<WhyLink section="categorization" topic="Tally's guess" />
		</p>
	);
}

/**
 * The split sheet's form. In correction mode (Change the parts, spec §8.4) `totalCents` is the entry's
 * new amount, which the live line counts against, and `amountWas` is the amount the saved parts were
 * drawn with; the parts' own sum is always that amount, so the line says how far the parts are from
 * the new one. `pendingEdit` is the panel's other unsaved changes, carried through every redraw so
 * they are saved with the corrected parts.
 */
export function SplitForm({
	id,
	parentCents,
	totalCents,
	amountWas,
	pendingEdit,
	categories,
	values,
	back,
	error,
	guessLabel,
}: {
	id: number;
	parentCents: number;
	totalCents?: number;
	amountWas?: number;
	pendingEdit?: string;
	categories: Category[];
	values: SplitValue[];
	back: string;
	error?: string;
	/** Jev's two categories, as "Groceries and Household", when the trip looks mixed (#233); shown while a part is still a guess. */
	guessLabel?: string;
}) {
	const correcting = totalCents !== undefined && amountWas !== undefined;
	const guessing = values.some(isGuessedPart);
	return (
		<form
			method="post"
			action={`/transactions/${id}/split`}
			class="mt-4 flex flex-col gap-4 border-t border-rule pt-4"
			hx-post={`/transactions/${id}/split`}
			hx-target="#page"
			hx-select="#page"
			hx-swap="outerHTML"
			hx-select-oob="#needs-count:innerHTML"
		>
			<input type="hidden" name="back" value={back} />
			{correcting && (
				<>
					<input type="hidden" name="total" value={String(totalCents)} />
					<input type="hidden" name="amount_was" value={String(amountWas)} />
					{pendingEdit !== undefined && (
						<input type="hidden" name="pending_edit" value={pendingEdit} />
					)}
				</>
			)}
			<div class="flex items-center justify-between gap-3">
				<div id="split-line" aria-live="polite">
					<SplitLine
						parentCents={totalCents ?? parentCents}
						amounts={values.map((v) => v.amount)}
					/>
				</div>
				<Button kind="text" type="submit" name="add" value="1" formnovalidate>
					Add a part
				</Button>
			</div>
			{correcting && amountWas !== totalCents && (
				<p class="text-sm text-muted">
					{`The parts add up to ${formatCents(amountWas)}. Change them to match ${formatCents(totalCents)}.`}
				</p>
			)}
			{error && (
				<p role="alert" class="text-sm text-over">
					{error}
				</p>
			)}
			{guessLabel && <GuessLine label={guessLabel} guessing={guessing} />}
			{values.map((value, index) => (
				<div
					class={`flex flex-col gap-2 ${index ? "border-t border-rule pt-3" : ""}`}
					// A part's category or amount changed: the live line redraws the parts, so a part turns solid as a
					// person types or picks (#233). Every part shares one queue: a request waits for the one in flight,
					// and only the newest waiting one is sent, so the last answer is always about the newest values.
					// Nothing is cancelled, so htmx logs no error.
					hx-post={`/transactions/${id}/split/line`}
					hx-trigger="input delay:300ms"
					hx-sync="#split-line:queue last"
					hx-target="#split-line"
					hx-select="#split-line > *"
					hx-swap="innerHTML"
					hx-include="closest form"
				>
					{correcting && (
						<input
							type="hidden"
							name="part_id"
							value={value.partId === undefined ? "" : String(value.partId)}
						/>
					)}
					{/* Posted back so a redraw knows which categories were Tally's guess (#233). */}
					<input type="hidden" name="part_guess" value={value.guess ?? ""} />
					<PartCategory
						index={index}
						value={value}
						categories={categories}
						autofocus={index === values.length - 1 && values.length > 2}
					/>
					<MoneyInput
						id={`part-amount-${index}`}
						name="part_amount"
						label={`Part ${index + 1} amount`}
						value={value.amount}
					/>
				</div>
			))}
			<div class="grid grid-cols-2 gap-3">
				<Button href={back} kind="secondary">
					Cancel
				</Button>
				<Button type="submit">Save split</Button>
			</div>
		</form>
	);
}

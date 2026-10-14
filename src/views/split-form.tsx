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
 * A part's label, category select and Tally's-guess marker (#233). The live line draws them again out of band (`oob`)
 * for a part a person has touched, so it turns solid once and its marker is cleared. The marker is posted back, empty
 * unless the part is still a guess, so a full redraw never carries the guess of a touched part. A redraw never carries
 * autofocus: focus must not move while a person types in another part.
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
			<input
				type="hidden"
				id={`part-guess-${index}`}
				name="part_guess"
				value={guessed ? (value.guess ?? "") : ""}
				hx-swap-oob={swap}
			/>
		</>
	);
}

/**
 * Tally's guess above the parts (#233, decision 113): shown for the whole of a split that opened with Tally's guessed
 * parts, whatever the parts hold now. The live line never redraws it.
 */
export function GuessLine({ label }: { label: string }) {
	return (
		<p
			id="split-guess"
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
	cancelHref = back,
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
	/** Where Cancel goes, when it is not the list the form returns to (a sheet's close asks for focus). */
	cancelHref?: string;
	error?: string;
	/** Jev's two categories, as "Groceries and Household", when the trip looks mixed (#233): the guess line, for the whole split. */
	guessLabel?: string;
}) {
	const correcting = totalCents !== undefined && amountWas !== undefined;
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
			{guessLabel && <GuessLine label={guessLabel} />}
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
				<Button href={cancelHref} kind="secondary">
					Cancel
				</Button>
				<Button type="submit">Save split</Button>
			</div>
		</form>
	);
}

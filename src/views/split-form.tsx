import { shortDay } from "../dates";
import { formatCents } from "../money";
import type { SplitRefund } from "../transactions/refund-guards";
import { positiveCents, splitStatus } from "../transactions/split";
import { Button } from "./button";
import { Chip } from "./chip";
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
			{/* One span, so the line's flex gap doesn't split the sentence around its figures. */}
			<span>
				{status.before}
				<span class="tabular-nums">{status.figures}</span>
				{status.after}
			</span>
		</p>
	);
}

/**
 * A part's chip on the refund chooser: its category and amount, or "Part N" until both are filled in. Only the amount
 * is a tabular span; the category name and the dot stay normal text, since a name can be hyphenated (#676, decision 128).
 */
function partLabel(value: SplitValue, index: number, categories: Category[]) {
	const category = categories.find((cat) => String(cat.id) === value.category);
	const cents = positiveCents(value.amount);
	return category && cents !== null ? (
		<>
			{category.name}
			{" · "}
			<span class="tabular-nums">{formatCents(cents)}</span>
		</>
	) : (
		`Part ${index + 1}`
	);
}

/**
 * The id of a part's label on the refund chooser: /split/line redraws it out of band, by sheet, refund and part. Each
 * drawing of the sheet has its own mark, so a label update meant for an earlier drawing finds nothing to change.
 */
const partLabelId = (sheet: string, refundId: number, index: number) =>
	`refund-${sheet}-${refundId}-part-${index}`;

/**
 * The linked refunds of a split purchase (decision 99): for each, "The refund on Oct 5 goes with", one radio chip
 * per part, then Not linked. Nothing is chosen when the sheet opens. A part's chip text is its own span, which
 * /split/line redraws out of band (RefundPartLabels); the radios are never redrawn, so a pick made meanwhile stays
 * checked and focused. `choices` is what the sheet posted, so a redraw of the whole sheet keeps the answers given:
 * "none" for Not linked, or a part's index.
 */
export function RefundChoices({
	refunds,
	values,
	categories,
	today,
	choices,
	sheet,
}: {
	refunds: SplitRefund[];
	values: SplitValue[];
	categories: Category[];
	today: string;
	choices: Record<number, string | undefined>;
	sheet: string;
}) {
	return (
		<div id="refund-choices" class="flex flex-col gap-4">
			{refunds.map((refund) => (
				<fieldset class="flex flex-col gap-2">
					<legend class="text-sm text-muted">
						{`The refund on ${shortDay(refund.date, today)} goes with`}
					</legend>
					<div class="flex flex-wrap gap-2">
						{values.map((value, index) => (
							<Chip
								type="radio"
								name={`refund_${refund.id}`}
								value={String(index)}
								checked={choices[refund.id] === String(index)}
							>
								<span id={partLabelId(sheet, refund.id, index)}>
									{partLabel(value, index, categories)}
								</span>
							</Chip>
						))}
						<Chip
							type="radio"
							name={`refund_${refund.id}`}
							value="none"
							checked={choices[refund.id] === "none"}
						>
							Not linked
						</Chip>
					</div>
				</fieldset>
			))}
		</div>
	);
}

/**
 * The refund chooser's part labels, redrawn out of band by /split/line as the parts' categories and amounts are typed
 * (decision 99). Each one replaces the text of one chip, found by its id, which carries the sheet's token; the radios
 * are not in the reply.
 */
export function RefundPartLabels({
	refunds,
	values,
	categories,
	sheet,
}: {
	refunds: SplitRefund[];
	values: SplitValue[];
	categories: Category[];
	sheet: string;
}) {
	return (
		<>
			{refunds.flatMap((refund) =>
				values.map((value, index) => (
					<span id={partLabelId(sheet, refund.id, index)} hx-swap-oob="true">
						{partLabel(value, index, categories)}
					</span>
				)),
			)}
		</>
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
 * they are saved with the corrected parts. A correction keeps each part's links, so it asks about no
 * refund: `refunds` is for a new split only (decision 99).
 */
export function SplitForm({
	id,
	parentCents,
	totalCents,
	amountWas,
	pendingEdit,
	categories,
	values,
	refunds = [],
	choices = {},
	today,
	back,
	cancelHref = back,
	error,
	guessLabel,
	// Each drawing of the sheet gets a new token, which every line request posts back (hx-include).
	sheet = crypto.randomUUID(),
}: {
	id: number;
	parentCents: number;
	totalCents?: number;
	amountWas?: number;
	pendingEdit?: string;
	categories: Category[];
	values: SplitValue[];
	refunds?: SplitRefund[];
	choices?: Record<number, string | undefined>;
	today: string;
	back: string;
	/** Where Cancel goes, when it is not the list the form returns to (a sheet's close asks for focus). */
	cancelHref?: string;
	error?: string;
	/** Jev's two categories, as "Groceries and Household", when the trip looks mixed (#233): the guess line, for the whole split. */
	guessLabel?: string;
	sheet?: string;
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
			<input type="hidden" name="sheet" value={sheet} />
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
					// person types or picks (#233), and the refund chooser's labels follow (decision 99). Every part shares one queue: a request waits for the one in flight,
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
			<RefundChoices
				refunds={correcting ? [] : refunds}
				values={values}
				categories={categories}
				today={today}
				choices={choices}
				sheet={sheet}
			/>
			<div class="grid grid-cols-2 gap-3">
				<Button href={cancelHref} kind="secondary">
					Cancel
				</Button>
				<Button type="submit">Save split</Button>
			</div>
		</form>
	);
}

import { shortDay } from "../dates";
import { formatCents } from "../money";
import type { SplitRefund } from "../transactions/refund-guards";
import { positiveCents, splitStatus } from "../transactions/split";
import { Button } from "./button";
import { Chip } from "./chip";
import { Icon } from "./icons";
import { MoneyInput } from "./money-input";

type Category = { id: number; name: string };
/**
 * A part row. `partId` is the saved part a correction updates; a new row has none. `kept` is that part's
 * own category when it is archived: the row's select offers it, and no other row does.
 */
export type SplitValue = {
	category: string;
	amount: string;
	partId?: number;
	kept?: Category;
};

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

/** A part's chip on the refund chooser: its category and amount, or "Part N" until both are filled in. */
function partLabel(
	value: SplitValue,
	index: number,
	categories: Category[],
): string {
	const category = categories.find((cat) => String(cat.id) === value.category);
	const cents = positiveCents(value.amount);
	return category && cents !== null
		? `${category.name} · ${formatCents(cents)}`
		: `Part ${index + 1}`;
}

/** The id of a part's label on the refund chooser: /split/line redraws it out of band, by refund and part. */
const partLabelId = (refundId: number, index: number) =>
	`refund-${refundId}-part-${index}`;

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
}: {
	refunds: SplitRefund[];
	values: SplitValue[];
	categories: Category[];
	today: string;
	choices: Record<number, string | undefined>;
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
								<span id={partLabelId(refund.id, index)}>
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
 * (decision 99). Each one replaces the text of one chip, found by its id; the radios are not in the reply.
 */
export function RefundPartLabels({
	refunds,
	values,
	categories,
}: {
	refunds: SplitRefund[];
	values: SplitValue[];
	categories: Category[];
}) {
	return (
		<>
			{refunds.flatMap((refund) =>
				values.map((value, index) => (
					<span id={partLabelId(refund.id, index)} hx-swap-oob="true">
						{partLabel(value, index, categories)}
					</span>
				)),
			)}
		</>
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
	error,
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
	error?: string;
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
			{values.map((value, index) => (
				<div
					class={`flex flex-col gap-2 ${index ? "border-t border-rule pt-3" : ""}`}
				>
					{correcting && (
						<input
							type="hidden"
							name="part_id"
							value={value.partId === undefined ? "" : String(value.partId)}
						/>
					)}
					<label for={`part-category-${index}`} class="sr-only">
						Part {index + 1} category
					</label>
					<select
						id={`part-category-${index}`}
						name="part_category"
						class="min-h-11 rounded-full border border-rule bg-paper px-3"
						autofocus={index === values.length - 1 && values.length > 2}
						required
						// A category change redraws the refund chooser's part labels too (/split/line).
						hx-post={`/transactions/${id}/split/line`}
						hx-trigger="change"
						hx-sync="#split-line:queue last"
						hx-target="#split-line"
						hx-select="#split-line > *"
						hx-swap="innerHTML"
						hx-include="closest form"
					>
						<option value="">Pick a category</option>
						{[...categories, ...(value.kept ? [value.kept] : [])].map((cat) => (
							<option
								value={cat.id}
								selected={value.category === String(cat.id)}
							>
								{cat.name}
							</option>
						))}
					</select>
					<div
						hx-post={`/transactions/${id}/split/line`}
						hx-trigger="input delay:300ms"
						// Every part shares one queue: a request waits for the one in flight, and only the newest
						// waiting one is sent, so the last answer is always about the newest amounts. Nothing is
						// cancelled, so htmx logs no error.
						hx-sync="#split-line:queue last"
						hx-target="#split-line"
						hx-select="#split-line > *"
						hx-swap="innerHTML"
						hx-include="closest form"
					>
						<MoneyInput
							id={`part-amount-${index}`}
							name="part_amount"
							label={`Part ${index + 1} amount`}
							value={value.amount}
						/>
					</div>
				</div>
			))}
			<RefundChoices
				refunds={correcting ? [] : refunds}
				values={values}
				categories={categories}
				today={today}
				choices={choices}
			/>
			<div class="grid grid-cols-2 gap-3">
				<Button href={back} kind="secondary">
					Cancel
				</Button>
				<Button type="submit">Save split</Button>
			</div>
		</form>
	);
}

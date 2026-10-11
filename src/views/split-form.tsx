import { formatCents } from "../money";
import { splitStatus } from "../transactions/split";
import { Button } from "./button";
import { Icon } from "./icons";
import { MoneyInput } from "./money-input";

type Category = { id: number; name: string };
/** A part row. `partId` is the saved part a correction updates; a new row has none. */
export type SplitValue = { category: string; amount: string; partId?: number };

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
 * The split sheet's form. In correction mode (Change the parts, spec §8.4) `totalCents` is the entry's
 * new amount, which the live line counts against, and `amountWas` is the amount the saved parts were
 * drawn with; the parts' own sum is always that amount, so the line says how far the parts are from
 * the new one.
 */
export function SplitForm({
	id,
	parentCents,
	totalCents,
	amountWas,
	categories,
	values,
	back,
	error,
}: {
	id: number;
	parentCents: number;
	totalCents?: number;
	amountWas?: number;
	categories: Category[];
	values: SplitValue[];
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
					>
						<option value="">Pick a category</option>
						{categories.map((cat) => (
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
			<div class="grid grid-cols-2 gap-3">
				<Button href={back} kind="secondary">
					Cancel
				</Button>
				<Button type="submit">Save split</Button>
			</div>
		</form>
	);
}

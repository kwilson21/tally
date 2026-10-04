import { formatCents } from "../money";
import { splitStatus } from "../transactions/split";
import { Button } from "./button";
import { Icon } from "./icons";
import { MoneyInput } from "./money-input";

type Category = { id: number; name: string };
export type SplitValue = { category: string; amount: string };

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
			id="split-line"
			aria-live="polite"
			class={`flex items-center gap-2 text-lg font-medium ${status.kind === "over" ? "text-over" : "text-ink"}`}
		>
			{status.kind === "done" && <Icon name="check" class="size-5" />}
			{status.text}
		</p>
	);
}

export function SplitForm({
	id,
	parentCents,
	categories,
	values,
	back,
	error,
}: {
	id: number;
	parentCents: number;
	categories: Category[];
	values: SplitValue[];
	back: string;
	error?: string;
}) {
	return (
		<form
			method="post"
			action={`/transactions/${id}/split`}
			class="mt-4 flex flex-col gap-4 border-t border-rule pt-4"
			hx-post={`/transactions/${id}/split`}
			hx-target="#page"
			hx-select="#page"
			hx-swap="outerHTML"
		>
			<input type="hidden" name="back" value={back} />
			<div class="flex items-center justify-between gap-3">
				<SplitLine
					parentCents={parentCents}
					amounts={values.map((v) => v.amount)}
				/>
				<Button kind="text" type="submit" name="add" value="1" formnovalidate>
					Add a part
				</Button>
			</div>
			{error && (
				<p role="alert" class="text-sm text-over">
					{error}
				</p>
			)}
			{values.map((value, index) => (
				<div class="flex flex-col gap-2 border-t border-rule pt-3">
					<label for={`part-category-${index}`} class="text-base text-ink">
						Part {index + 1} category
					</label>
					<select
						id={`part-category-${index}`}
						name="part_category"
						class="min-h-11 rounded-control border border-rule bg-paper px-3"
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
						hx-trigger="input changed delay:300ms"
						hx-target="#split-line"
						hx-swap="outerHTML"
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
			<p class="text-sm text-muted">
				Parts must total {formatCents(Math.abs(parentCents))}.
			</p>
			<div class="grid grid-cols-2 gap-3">
				<Button href={back} kind="secondary">
					Cancel
				</Button>
				<Button type="submit">Save split</Button>
			</div>
		</form>
	);
}

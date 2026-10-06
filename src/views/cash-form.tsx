import type { CashErrors, CashValues } from "../transactions/cash";
import { Button } from "./button";
import { CategoryIcon } from "./category";
import { Chip } from "./chip";
import { FormField } from "./form-field";
import { MoneyInput } from "./money-input";
import { TextInput } from "./text-input";

type Category = { id: number; name: string; icon: string; color: string };
export function CashForm({
	values,
	errors = {},
	categories,
	today,
	action = "/transactions/cash",
	back = "/transactions",
	entryKey,
}: {
	values: CashValues;
	errors?: CashErrors;
	categories: Category[];
	today: string;
	action?: string;
	back?: string;
	/** A one-time key (a UUID) made when the form is drawn, so posting the form twice saves once. */
	entryKey?: string;
}) {
	return (
		<form
			method="post"
			action={action}
			class="mt-4 flex flex-col gap-4"
			hx-post={action}
			hx-target="#page"
			hx-select="#page"
			hx-swap="outerHTML"
			hx-disable="findAll button[type=submit]"
		>
			<input type="hidden" name="back" value={back} />
			{entryKey && <input type="hidden" name="entry_key" value={entryKey} />}
			<MoneyInput
				id="cash-amount"
				name="amount"
				label="Amount"
				value={values.amount}
				error={errors.amount}
			/>
			<div class="grid grid-cols-2 gap-3">
				<TextInput
					id="cash-date"
					name="date"
					label="Date"
					type="date"
					value={values.date}
					max={today}
					surface="paper"
					error={errors.date}
				/>
				<TextInput
					id="cash-merchant"
					name="merchant"
					label="Where"
					value={values.merchant}
					autocomplete="off"
					surface="paper"
					error={errors.merchant}
				/>
			</div>
			<fieldset
				aria-describedby={errors.category ? "cash-category-error" : undefined}
			>
				<legend>Category</legend>
				<div class="mt-2 flex flex-wrap gap-2">
					{categories.map((cat) => (
						<Chip
							type="radio"
							name="category"
							value={String(cat.id)}
							checked={values.category === String(cat.id)}
							icon={<CategoryIcon icon={cat.icon} color={cat.color} />}
						>
							{cat.name}
						</Chip>
					))}
				</div>
				{errors.category && (
					<p
						id="cash-category-error"
						role="alert"
						class="mt-2 text-sm text-over"
					>
						{errors.category}
					</p>
				)}
			</fieldset>
			<FormField id="cash-note" label="Note (optional)" error={errors.note}>
				{({ class: errorClass, ...a11y }) => (
					<input
						id="cash-note"
						name="note"
						class={`rounded-control border border-rule bg-paper px-3 py-2 text-lg ${errorClass ?? ""}`}
						value={values.note}
						{...a11y}
					/>
				)}
			</FormField>
			<div class="grid grid-cols-2 gap-3">
				<Button href={back} kind="secondary">
					Cancel
				</Button>
				<Button type="submit" busyLabel="Adding…">
					Add
				</Button>
			</div>
		</form>
	);
}

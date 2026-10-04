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
}: {
	values: CashValues;
	errors?: CashErrors;
	categories: Category[];
	today: string;
	action?: string;
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
			<MoneyInput
				id="cash-amount"
				name="amount"
				label="Amount"
				value={values.amount}
				error={errors.amount}
			/>
			<fieldset
				aria-describedby={errors.direction ? "direction-error" : undefined}
			>
				<legend>Direction</legend>
				<div class="mt-2 flex gap-2">
					<Chip
						type="radio"
						name="direction"
						value="out"
						checked={values.direction === "out"}
					>
						Money out
					</Chip>
					<Chip
						type="radio"
						name="direction"
						value="in"
						checked={values.direction === "in"}
					>
						Money in
					</Chip>
				</div>
				{errors.direction && (
					<p id="direction-error" role="alert" class="text-sm text-over">
						{errors.direction}
					</p>
				)}
			</fieldset>
			<TextInput
				id="cash-merchant"
				name="merchant"
				label="Merchant name"
				value={values.merchant}
				autocomplete="off"
				surface="paper"
				error={errors.merchant}
			/>
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
					<p id="cash-category-error" role="alert" class="text-sm text-over">
						{errors.category}
					</p>
				)}
			</fieldset>
			<FormField id="cash-note" label="Note (optional)" error={errors.note}>
				{({ class: errorClass, ...a11y }) => (
					<textarea
						id="cash-note"
						name="note"
						rows={2}
						class={`rounded-control border border-rule bg-paper px-3 py-2 text-lg ${errorClass ?? ""}`}
						{...a11y}
					>
						{values.note}
					</textarea>
				)}
			</FormField>
			<div class="grid grid-cols-2 gap-3">
				<Button href="/transactions" kind="secondary">
					Cancel
				</Button>
				<Button type="submit" busyLabel="Adding…">
					Add
				</Button>
			</div>
		</form>
	);
}

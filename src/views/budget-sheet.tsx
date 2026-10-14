// The budget sheet's contents (#66, #83): one category's name and this month's spending, its counted
// transactions, and one amount from this month on. The route wraps it in a BottomSheet, as it wraps
// SavingsGoalSheet; the catalog draws it in an inert box.

import { monthName } from "../dates";
import type { BudgetCategory } from "../db/budgets";
import { formatCents } from "../money";
import { Button } from "./button";
import { CategoryIcon } from "./category";
import { MoneyInput } from "./money-input";
import { TransactionsButton } from "./transactions-button";

/** The budget sheet: one amount, from this month on, with the money input's helpers. */
export function BudgetSheet({
	id = "budget",
	category,
	value,
	error,
	spentCents,
	lastMonthCents,
	averageCents,
	transactionCount,
	month: monthPeriod,
	closeHref,
	closeAttrs,
}: {
	/** Prefixes the ids of the heading, the amount field and Save; a drawing of three sheets gives each its own. */
	id?: string;
	category: BudgetCategory;
	value: string;
	error?: string;
	spentCents: number;
	lastMonthCents: number;
	averageCents: number | null;
	transactionCount: number;
	/** The household's current month, YYYY-MM. */
	month: string;
	/** Where Cancel goes without JavaScript: the sheet's backdrop address. */
	closeHref: string;
	/** htmx attributes for Cancel, which closes the sheet the way its backdrop does. */
	closeAttrs: Record<string, string>;
}) {
	const month = monthName(monthPeriod);
	const transactionsHref = `/transactions?${new URLSearchParams({
		category: String(category.id),
		month: monthPeriod,
		show: "spending",
	})}`;
	return (
		<>
			<div class="flex items-center gap-3">
				<CategoryIcon icon={category.icon} color={category.color} />
				<h2
					id={`${id}-sheet-title`}
					class="min-w-0 wrap-anywhere font-serif text-4xl font-semibold tracking-tight"
					tabindex={-1}
				>
					{category.name}
				</h2>
			</div>
			<p class="mt-1 text-muted">
				{/* The same net amount as the Home row: refunds reduce spending (spec §6). */}
				{spentCents < 0
					? `${formatCents(-spentCents)} more refunded than spent in ${month}`
					: `${formatCents(spentCents)} spent so far in ${month}`}
			</p>
			<TransactionsButton href={transactionsHref} count={transactionCount} />
			<form
				method="post"
				action={`/budget/${category.id}`}
				class="mt-4 flex flex-col gap-4 border-t border-rule pt-4"
				hx-post={`/budget/${category.id}`}
				hx-disable="findAll button[type=submit]"
				hx-indicator={`#${id}-save`}
				hx-target="#page"
				hx-select="#page"
				hx-swap="outerHTML"
			>
				<MoneyInput
					id={id}
					name="budget"
					label={`Budget from ${month} on`}
					value={value}
					error={error}
					lastMonthCents={lastMonthCents}
					averageCents={averageCents}
					autofocus
				/>
				<div class="mt-2 grid grid-cols-2 gap-3">
					<Button
						href={closeHref}
						kind="secondary"
						class="w-full"
						{...closeAttrs}
					>
						Cancel
					</Button>
					<Button
						id={`${id}-save`}
						type="submit"
						class="w-full"
						busyLabel="Saving…"
					>
						Save
					</Button>
				</div>
			</form>
		</>
	);
}

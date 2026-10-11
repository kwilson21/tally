import { shortDay } from "../dates";
import type { LikelyRow } from "../db/likely-transactions";
import { formatCents } from "../money";
import { BottomSheet } from "./bottom-sheet";
import { Button } from "./button";
import { SelectableTransactionRow } from "./selectable-transaction-row";
import { WhyLink } from "./why-link";

/**
 * The button that files the ticked rows, "Add 2 to Pet Care" (P73 A). The server draws it again as the ticks
 * change, so the number always follows them; with none ticked it is disabled.
 */
export function LikelyAdd({
	count,
	categoryName,
}: {
	count: number;
	categoryName: string;
}) {
	if (count === 0)
		return (
			<Button type="submit" disabled>
				Add to {categoryName}
			</Button>
		);
	return (
		<Button type="submit">
			Add {count} to {categoryName}
		</Button>
	);
}

/** The reason under a row, in plain words: a same-merchant fact, or Tally's guess with its Why? link. */
function LikelyReason({
	row,
	categoryName,
	savedDate,
	savedCents,
	today,
}: {
	row: LikelyRow;
	categoryName: string;
	savedDate: string;
	savedCents: number;
	/** The household's date: the saved date shows its year only when it isn't this year. */
	today: string;
}) {
	if (row.sameMerchant)
		return (
			<span>
				{`Same merchant as ${shortDay(savedDate, today)} (${formatCents(Math.abs(savedCents))})`}
			</span>
		);
	return (
		<>
			<span class="min-w-0 flex-1">
				{`Tally's guess: none of your categories fit, and it reads like ${categoryName}.`}
			</span>
			<WhyLink section="categorization" topic="Tally's guess" />
		</>
	);
}

type PanelProps = {
	savedId: number;
	savedDate: string;
	savedCents: number;
	back: string;
	/** The attributes of the form's own actions; the sheet passes none, the catalog none. */
	closeAttrs?: Record<string, string>;
	categoryId: number;
	categoryName: string;
	rows: LikelyRow[];
	/** The ids ticked now; a new panel ticks the same-merchant rows. */
	ticked: Set<number>;
	today: string;
};

/**
 * What the panel says and offers, without its sheet: "Pet Care is made.", "These might belong too:", the
 * likely transactions each with its reason, then Add and Not now. Only the ticked ones move, when Add is
 * chosen; Not now leaves them all. A tick redraws only the Add count.
 */
export function LikelyPanel({
	savedId,
	savedDate,
	savedCents,
	back,
	closeAttrs = {},
	categoryId,
	categoryName,
	rows,
	ticked,
	today,
}: PanelProps) {
	const count = rows.filter((row) => ticked.has(row.id)).length;
	return (
		<>
			<h2
				id="likely-title"
				tabindex={-1}
				autofocus
				class="font-serif text-4xl font-semibold tracking-tight outline-none"
			>
				{categoryName} is made.
			</h2>
			<p class="text-lg">These might belong too:</p>
			<form
				method="post"
				action={`/transactions/${savedId}/likely`}
				class="flex flex-col gap-4"
				hx-post={`/transactions/${savedId}/likely`}
				hx-target="#page"
				hx-select="#page"
				hx-swap="outerHTML"
				hx-select-oob="#needs-count:innerHTML"
			>
				<input type="hidden" name="back" value={back} />
				<input type="hidden" name="category" value={String(categoryId)} />
				{/* A tick redraws the Add count only; the rows stay as the person left them. */}
				<div
					hx-post={`/transactions/${savedId}/likely/count`}
					hx-trigger="change"
					hx-include="closest form"
					hx-target="#likely-add"
					hx-swap="innerHTML"
					hx-sync="#likely-add:queue last"
				>
					<ul class="divide-y divide-rule border-y border-rule">
						{rows.map((row) => (
							<SelectableTransactionRow
								row={row}
								checked={ticked.has(row.id)}
								today={today}
								reason={
									<LikelyReason
										row={row}
										categoryName={categoryName}
										savedDate={savedDate}
										savedCents={savedCents}
										today={today}
									/>
								}
							/>
						))}
					</ul>
				</div>
				<div class="flex flex-wrap items-center gap-3">
					<div id="likely-add" aria-live="polite">
						<LikelyAdd count={count} categoryName={categoryName} />
					</div>
					<Button kind="text" href={back} {...closeAttrs}>
						Not now
					</Button>
				</div>
			</form>
		</>
	);
}

/** The panel in its sheet, after a new category is saved from the edit panel (decision 76). */
export function LikelySheet({
	closeAttrs,
	...panel
}: PanelProps & { closeAttrs: Record<string, string> }) {
	return (
		<BottomSheet
			labelledBy="likely-title"
			closeHref={panel.back}
			closeAttrs={closeAttrs}
			still
		>
			<LikelyPanel {...panel} closeAttrs={closeAttrs} />
		</BottomSheet>
	);
}

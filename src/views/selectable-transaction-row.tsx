import type { Child } from "hono/jsx";
import { DEFAULT_TIME_ZONE, dayLabel, todayIn } from "../dates";
import type { ListRow } from "../db/transactions";
import { formatCents } from "../money";
import { Icon } from "./icons";
import { TransactionRow } from "./transaction-row";

/** A transaction row whose round check mark selects it for a bulk action. */
export function SelectableTransactionRow({
	row,
	checked = false,
	autofocus = false,
	today = todayIn(DEFAULT_TIME_ZONE),
	after,
	reason,
}: {
	row: ListRow;
	/** Ticked already (coming back from the Set category sheet). */
	checked?: boolean;
	/** Takes focus when its list is drawn: the first row's tick after Older or Newer (FOCUS_FIRST_TICK). */
	autofocus?: boolean;
	/** The household's date. Pages pass it; the catalog, which has no household, takes Eastern's. */
	today?: string;
	/** Optional content below the row, shown when this row is unchecked. */
	after?: Child;
	/**
	 * The reason under the row, in muted words, lined up with its name (the likely-transactions panel: a
	 * same-merchant fact, or Tally's guess with its Why? link). It sits outside the label, so a link in it
	 * doesn't toggle the tick.
	 */
	reason?: Child;
}) {
	const nameId = `select-${row.id}-name`;
	const reasonId = `select-${row.id}-reason`;
	return (
		<li data-transaction={row.id} class="group/tx">
			{/* relative keeps the visually hidden checkbox inside its own row. */}
			<label class="group relative flex min-h-16 min-w-11 cursor-pointer items-center gap-3 has-[:focus-visible]:[&_.selection-mark]:outline-2 has-[:focus-visible]:[&_.selection-mark]:outline-offset-2 has-[:focus-visible]:[&_.selection-mark]:outline-accent">
				<input
					class="peer sr-only"
					type="checkbox"
					name="ids"
					value={row.id}
					checked={checked}
					autofocus={autofocus}
					aria-labelledby={nameId}
					aria-describedby={reason ? reasonId : undefined}
				/>
				<span class="selection-mark flex size-7 shrink-0 items-center justify-center rounded-full border border-muted peer-checked:border-ink peer-checked:bg-band">
					<span class="hidden group-has-[:checked]:flex">
						<Icon name="check" class="size-4" />
					</span>
				</span>
				<span id={nameId} class="sr-only">
					Select {row.displayName}
					{row.nameSuggested && " (suggested name)"},{" "}
					{formatCents(row.amountCents, { signed: true })},{" "}
					{dayLabel(row.date, today)}
					{/* The checkbox is named by this label alone, so a pending row says so here too. */}
					{row.pending && ", pending"}
				</span>
				<span class="min-w-0 flex-1">
					<TransactionRow row={row} bare />
				</span>
			</label>
			{reason && (
				<div
					id={reasonId}
					class="flex flex-wrap items-center gap-x-2 pb-2 pl-21 text-sm text-muted"
				>
					{reason}
				</div>
			)}
			{after}
		</li>
	);
}

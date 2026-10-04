import { dayLabel, todayUtc } from "../dates";
import type { ListRow } from "../db/transactions";
import { formatCents } from "../money";
import { Icon } from "./icons";
import { TransactionRow } from "./transaction-row";

/** A transaction row whose round check mark selects it for a bulk action. */
export function SelectableTransactionRow({
	row,
	checked = false,
}: {
	row: ListRow;
	/** Ticked already (coming back from the Set category sheet). */
	checked?: boolean;
}) {
	const nameId = `select-${row.id}-name`;
	return (
		<li data-transaction={row.id}>
			{/* relative keeps the visually hidden checkbox inside its own row. */}
			<label class="group relative flex min-h-16 cursor-pointer items-center gap-3 has-[:focus-visible]:[&_.selection-mark]:outline-2 has-[:focus-visible]:[&_.selection-mark]:outline-offset-2 has-[:focus-visible]:[&_.selection-mark]:outline-accent">
				<input
					class="peer sr-only"
					type="checkbox"
					name="ids"
					value={row.id}
					checked={checked}
					aria-labelledby={nameId}
				/>
				<span class="selection-mark flex size-7 shrink-0 items-center justify-center rounded-full border border-muted peer-checked:border-ink peer-checked:bg-band">
					<span class="hidden group-has-[:checked]:flex">
						<Icon name="check" class="size-4" />
					</span>
				</span>
				<span id={nameId} class="sr-only">
					Select {row.displayName},{" "}
					{formatCents(row.amountCents, { signed: true })},{" "}
					{dayLabel(row.date, todayUtc())}
				</span>
				<span class="min-w-0 flex-1">
					<TransactionRow row={row} bare />
				</span>
			</label>
		</li>
	);
}

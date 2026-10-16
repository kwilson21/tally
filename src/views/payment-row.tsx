import { formatCents } from "../money";
import { Icon } from "./icons";

/** How many payments a picker lists before "Show all N charges" (#645, P138 A, decision 126). */
export const CLOSEST_PAYMENTS = 5;

/** One payment as a 44px radio row, with the look of TransactionRow: its name, its date under it, the amount at the right. */
export function PaymentRow({
	candidate,
	checked = false,
	required = false,
	...htmx
}: {
	candidate: {
		id: number;
		displayName: string;
		dateLabel: string;
		amountCents: number;
		excluded?: boolean;
	};
	checked?: boolean;
	/** On the first row of a group, makes choosing one of them required. */
	required?: boolean;
	"hx-get"?: string;
	"hx-include"?: string;
	"hx-target"?: string;
	"hx-swap"?: string;
}) {
	return (
		<label class="group relative flex min-h-11 cursor-pointer items-center gap-4 py-2 text-ink has-[:focus-visible]:[&_.selection-mark]:outline-2 has-[:focus-visible]:[&_.selection-mark]:outline-offset-2 has-[:focus-visible]:[&_.selection-mark]:outline-accent">
			<input
				type="radio"
				name="transaction_id"
				value={String(candidate.id)}
				checked={checked}
				class="peer sr-only"
				// Nothing is chosen for the person; one required radio makes the group required.
				required={required}
				{...htmx}
			/>
			<span
				aria-hidden="true"
				class="selection-mark flex size-7 shrink-0 items-center justify-center rounded-full border border-muted peer-checked:border-ink peer-checked:bg-band"
			>
				<span class="hidden group-has-[:checked]:flex">
					<Icon name="check" class="size-4" />
				</span>
			</span>
			<span class="min-w-0 flex-1">
				<span class="block truncate text-lg leading-6">
					{candidate.displayName}
				</span>
				<span class="block truncate leading-6 text-muted">
					{candidate.dateLabel}
					{candidate.excluded ? " · Excluded" : ""}
				</span>
			</span>
			<span class="shrink-0 text-lg tabular-nums">
				{formatCents(candidate.amountCents)}
			</span>
		</label>
	);
}

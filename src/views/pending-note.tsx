import { Icon } from "./icons";

/**
 * The line under a pending transaction's date in its edit panel (P34 A, decision 72): a muted clock and
 * what pending means, so a person knows the amount can still change. The row's own "Pending" is on its
 * caption line (TransactionRow).
 */
export function PendingNote() {
	return (
		<p class="flex items-start gap-2 text-muted">
			<span class="mt-0.5 shrink-0">
				<Icon name="clock" class="size-5" />
			</span>
			Pending. The bank hasn't finished it, so its amount can still change.
		</p>
	);
}

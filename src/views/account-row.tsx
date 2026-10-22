import { formatCents } from "../money";
import { Icon } from "./icons";

type Props = {
	name: string;
	/** Plaid's last four digits, or null when the bank gives none. */
	mask: string | null;
	/** Plaid's account type: "credit" draws a card, anything else a bank. */
	type: string;
	/** Plaid's current balance in cents; for debt, the amount owed. Null draws the row with no amount (Apple Card, before a balance counts). */
	balanceCents: number | null;
	isLiability: boolean;
	/** A line under the name in place of the last four digits (Apple Card's "Balance as of Oct 18"). */
	detail?: string;
};

/**
 * One account: its icon, name, last four digits and balance, with debt shown negative (spec §5). A detail line (Apple
 * Card's date) takes the digits' place, and a row with no balance draws no amount.
 */
export function AccountRow({
	name,
	mask,
	type,
	balanceCents,
	isLiability,
	detail,
}: Props) {
	return (
		<li class="flex h-16 items-center gap-4">
			<span class="shrink-0">
				<Icon name={type === "credit" ? "card" : "bank"} class="size-7" />
			</span>
			<span class="min-w-0 flex-1">
				<span class="block truncate text-lg leading-6">{name}</span>
				{detail ? (
					<span class="block leading-6 text-muted">{detail}</span>
				) : (
					mask && (
						<span class="block leading-6 text-muted">
							<span class="sr-only">ending in </span>
							<span aria-hidden="true">••</span>
							{mask}
						</span>
					)
				)}
			</span>
			{balanceCents !== null && (
				<span class="shrink-0 text-lg tabular-nums">
					{formatCents(isLiability ? -balanceCents : balanceCents)}
				</span>
			)}
		</li>
	);
}

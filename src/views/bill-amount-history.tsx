import { formatCents } from "../money";

// A bill's amount history (spec §8.4, decision 101, P61 A): one muted line under the amount line says when
// the price last changed, and the edit sheet says what a new amount applies to, under its amount field.

/** "Price went up to $17.99 in October", under the bill's amount line on its page. */
export function PriceChangeLine({
	direction,
	amountCents,
	month,
}: {
	direction: "up" | "down";
	amountCents: number;
	/** The month the price changed, in words ("October", or "December 2025"). */
	month: string;
}) {
	return (
		<p class="text-muted">
			{`Price went ${direction} to ${formatCents(amountCents)} in ${month}`}
		</p>
	);
}

/**
 * "Applies from October on. Earlier months keep $15.49.", centered under the edit sheet's amount field.
 * The caller shows it only when the bill had an earlier price (`earlierAmount`), so `keptCents` is there.
 */
export function AppliesNote({
	month,
	keptCents,
}: {
	/** The month the new amount applies from, in words. */
	month: string;
	keptCents: number;
}) {
	return (
		<p class="mt-2 text-center text-muted">
			{`Applies from ${month} on. Earlier months keep ${formatCents(keptCents)}.`}
		</p>
	);
}

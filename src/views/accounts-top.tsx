import { formatCents } from "../money";

/**
 * The Accounts screen's top (round 5 study): the title, Net worth in whole dollars as the serif headline,
 * and a ruled space where the net-worth chart goes in Phase 4.
 */
export function AccountsTop({ netWorthCents }: { netWorthCents: number }) {
	return (
		<>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">Accounts</h1>
			<p class="mt-3 text-lg text-muted">Net worth</p>
			<p class="font-serif text-6xl font-semibold tracking-tight lg:text-7xl">
				{formatCents(netWorthCents, { wholeDollars: true })}
			</p>
			{/* Paper's own rules, like a ledger page waiting for the chart; decorative until Phase 4. */}
			<div
				data-chart-space
				aria-hidden="true"
				class="mt-6 flex h-20 flex-col justify-between lg:h-32"
			>
				<div class="border-t border-rule" />
				<div class="border-t border-rule" />
				<div class="border-t border-rule" />
				<div class="border-t border-rule" />
				<div class="border-t border-rule" />
			</div>
			<p class="mt-2 text-sm text-muted">Net worth over time arrives later</p>
		</>
	);
}

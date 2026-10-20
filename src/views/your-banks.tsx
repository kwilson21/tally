// Home's Your banks list during a new family's first week (P140 A, decision 133, spec §8.8): one ruled row per connected bank,
// in link order, with the bank icon, its name and how far Tally has got at the right. While a bank is being read, the list
// polls itself every 5 seconds (the fragment route /home/banks); it stops once none is, and never swaps an error in.
import {
	type BankState,
	bankState,
	type YourBank,
} from "../first-tally/your-banks";
import { BusyRing } from "./busy-ring";
import { Icon } from "./icons";

const count = (n: number) => n.toLocaleString("en-US");

/** A bank's words at the right of its row. Nothing stored yet says "Reading" or "Paused" alone. */
export function bankWords(state: BankState, transactions: number): string {
	const soFar = transactions > 0 ? ` · ${count(transactions)} so far` : "";
	if (state === "in") return `90 days in · ${count(transactions)}`;
	if (state === "paused") return `Paused${soFar}`;
	return `Reading${soFar}`;
}

/**
 * The section, its label and its rows. `today` is the household's date (bankFlag reads it). The poll attributes are on the
 * section only while a bank is being read, and the list asks for the banks it already shows as in (`in`), so a bank that
 * just came in is announced once.
 */
export function YourBanks({
	banks,
	today,
	polls = true,
}: {
	banks: YourBank[];
	today: string;
	/** False for a picture on the proposals page, which fires nothing by itself (#448): the rows draw, the list doesn't poll. */
	polls?: boolean;
}) {
	const states = banks.map((bank) => ({ bank, state: bankState(bank, today) }));
	const polling = polls && states.some(({ state }) => state === "being-read");
	const inIds = states
		.filter(({ state }) => state === "in")
		.map(({ bank }) => bank.id);
	return (
		<section
			id="your-banks"
			class="mt-4"
			aria-labelledby="your-banks-label"
			{...(polling
				? {
						"hx-get": `/home/banks?in=${inIds.join(",")}`,
						"hx-trigger": "every 5s",
						"hx-swap": "outerHTML",
						"hx-status:4xx": "swap:none",
						"hx-status:5xx": "swap:none",
						"data-quiet": true,
					}
				: {})}
		>
			<p id="your-banks-label" class="text-sm text-muted">
				Your banks
			</p>
			<ul class="mt-2 border-t border-rule">
				{states.map(({ bank, state }) => (
					<li class="flex min-h-11 items-center gap-3 border-b border-rule">
						<span class="shrink-0 text-muted">
							<Icon name="bank" class="size-6" />
						</span>
						<span class="min-w-0 flex-1 py-2 text-base text-ink">
							{bank.name}
						</span>
						<span class="flex shrink-0 items-center gap-2 text-sm text-muted tabular-nums">
							{state === "being-read" && <BusyRing />}
							{bankWords(state, bank.count)}
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}

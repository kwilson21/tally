import type { ListRow, StartHereLines } from "../db/transactions";
import { safeToSpendText } from "./home-top";
import { LedgerIllustration } from "./illustration";
import { ThingsToTry } from "./things-to-try";
import { TransactionRow } from "./transaction-row";

/**
 * How Tally works' first section in the demo (spec §8.8, P124 A): the made-up family's bank lines, struck through,
 * with Tally's own row under each, under the list's count of them; the sentence on what would count without
 * Tally; this month's Safe to spend under a double rule; and the three things to try. The numbers come from the
 * same functions Home uses.
 */
export function StartHere({
	storyMonthName,
	monthName,
	rawHref,
	lines,
	safeToSpendCents,
}: {
	/** The month the bank lines are from (transaction 110's, the seed's): "October". */
	storyMonthName: string;
	/** Today's month, which Safe to spend is for: "October" until the month turns. */
	monthName: string;
	/** The list without Tally for the story's month: /transactions?raw=1, with &month= when that differs from today's. */
	rawHref: string;
	/** The lines and the list's count, from startHereRows. A line the month doesn't have is null. */
	lines: StartHereLines;
	/** The month's Safe to spend, as Home counts it for the same day. */
	safeToSpendCents: number;
}) {
	const { paycheck, transfer, bakery, lineCount } = lines;
	const bankLines = [paycheck, transfer, bakery].filter(
		(row): row is ListRow => row !== null,
	);
	return (
		<section id="start-here" aria-labelledby="start-here-title" class="mt-8">
			<div class="flex items-center justify-between gap-4">
				<h2 id="start-here-title" class="font-serif text-3xl font-semibold">
					Start here
				</h2>
				<div class="shrink-0 [&>svg]:size-24">
					<LedgerIllustration />
				</div>
			</div>
			<p class="mt-4 text-lg">
				The Riveras are a made-up family. Here's what their bank sent this{" "}
				{storyMonthName}, and what Tally wrote down.
			</p>
			{bankLines.length === 3 && (
				<h3 class="mt-6 font-medium text-muted">
					Three lines of {lineCount} so far
				</h3>
			)}
			<div class="mt-3 flex flex-col gap-4">
				{bankLines.map((row) => (
					<div>
						<p class="text-sm text-muted">
							<span class="sr-only">The bank sent </span>
							<s class="decoration-muted">{row.rawName}</s>
						</p>
						<ul class="mt-1 border-y border-rule">
							{/* The bank's text is struck above, so the row says only what Tally did with it. */}
							<TransactionRow row={row} bankText={false} />
						</ul>
					</div>
				))}
			</div>
			{paycheck && transfer && (
				<p class="mt-4">
					Without Tally, the paycheck and the transfer would both count as
					spending.
				</p>
			)}
			<a href={rawHref} class="inline-flex min-h-11 items-center">
				See every line without Tally
			</a>
			<div class="mt-4 border-t border-ink pt-3">
				<div class="flex items-baseline justify-between gap-4">
					<p class="text-lg">Safe to spend</p>
					<p class="text-2xl font-semibold tabular-nums">
						{safeToSpendText(safeToSpendCents)}
					</p>
				</div>
				<div
					aria-hidden="true"
					class="mt-1 border-b-[3px] border-double border-ink"
				/>
				<p class="mt-2 text-sm text-muted">
					What's left of {monthName}'s budget after its spending so far, bills
					due and savings. It's the big number on Home.
				</p>
			</div>
			<ThingsToTry />
		</section>
	);
}

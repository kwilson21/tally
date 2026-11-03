// The re-sort's progress line (decision 159): one quiet sentence, "Tally is re-checking… N done", shown on the page a
// Create lands on while its run is going. Two parts. The sentence polls /resort/progress every 2 seconds, and each
// answer replaces only that sentence; its count is aria-hidden, so a screen reader doesn't hear each count. The count
// is spoken once per quarter of the run instead: a visually hidden polite region beside the sentence, in the stable
// wrapper, holds the milestone's text ("4 of 14 done."). The poll sends that region again only when a quarter is
// crossed, so nothing is spoken between milestones. The answer that ends the run is empty, so the sentence and its
// polling leave the page with it. Nothing here is drawn without a running run.
import { BusyRing } from "./busy-ring";

/** A running run as the line draws it: its id (the poll's address) and how many of its rows are done. */
export type RecheckRun = { id: string; done: number; total: number };

/** The count the line says: never below zero, never past the run's total. */
export const recheckDone = (run: RecheckRun): number =>
	Math.min(Math.max(0, run.done), run.total);

/**
 * The quarter of the run the count has reached: 0 before a quarter, 1 from a quarter, 2 from half, 3 from three quarters.
 * The hidden region speaks only when this changes (decision 159, #821 owner feedback).
 */
export const recheckMilestone = (done: number, total: number): number =>
	total > 0 ? Math.min(3, Math.floor((done * 4) / total)) : 0;

/** The milestone's words for the hidden region: the row count at that quarter ("4 of 14 done."), or "" before one. */
export const recheckMilestoneText = (
	milestone: number,
	total: number,
): string =>
	milestone === 0
		? ""
		: `${Math.ceil((total * milestone) / 4)} of ${total} done.`;

/**
 * The sentence alone, the part that polls. `polls` is false for a picture in the catalog, which fires nothing by itself
 * and draws no ids (so the catalog never repeats the app's). The count is its own tabular span, aria-hidden, since the
 * spoken count is the milestone region's (decision 128 keeps the figures tabular).
 */
export function RecheckSentence({
	run,
	polls = true,
}: {
	run: RecheckRun;
	polls?: boolean;
}) {
	const done = recheckDone(run);
	const milestone = recheckMilestone(done, run.total);
	return (
		<p
			{...(polls ? { id: "recheck-line" } : {})}
			class="flex items-center gap-2 text-sm text-muted"
			{...(polls
				? {
						"hx-get": `/resort/progress?run=${run.id}&m=${milestone}`,
						"hx-trigger": "every 2s",
						"hx-swap": "outerHTML",
						"hx-status:4xx": "swap:none",
						"hx-status:5xx": "swap:none",
						"data-quiet": true,
					}
				: {})}
		>
			<BusyRing />
			<span>
				Tally is re-checking…{" "}
				<span aria-hidden="true" class="tabular-nums">
					{done}
				</span>{" "}
				done
			</span>
		</p>
	);
}

/**
 * The hidden polite region's new text, sent as an out-of-band swap into the stable region (so the region itself is never
 * replaced). The poll sends it only when the quarter changed.
 */
export function RecheckMilestoneSwap({ run }: { run: RecheckRun }) {
	const done = recheckDone(run);
	return (
		<span id="recheck-milestone" hx-swap-oob="innerHTML">
			{recheckMilestoneText(recheckMilestone(done, run.total), run.total)}
		</span>
	);
}

/** The live region with the sentence and the hidden milestone region, or nothing when no run is going. */
export function RecheckLine({
	run,
	polls = true,
}: {
	run: RecheckRun | null;
	polls?: boolean;
}) {
	if (!run) return null;
	const done = recheckDone(run);
	const milestone = recheckMilestone(done, run.total);
	return (
		<div {...(polls ? { id: "recheck" } : {})} class="mt-4">
			<RecheckSentence run={run} polls={polls} />
			<span
				{...(polls ? { id: "recheck-milestone" } : {})}
				role="status"
				aria-live="polite"
				class="sr-only"
			>
				{recheckMilestoneText(milestone, run.total)}
			</span>
		</div>
	);
}

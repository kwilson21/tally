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

/**
 * The hidden region's words: the count it has now ("5 of 14 done."), or "" before the first quarter. The quarter decides
 * whether the region speaks at all; the words speak the live count, so a jump past a quarter never says a lower number
 * than the visible one (#821 owner feedback).
 */
export const recheckMilestoneText = (
	milestone: number,
	done: number,
	total: number,
): string => (milestone === 0 ? "" : `${done} of ${total} done.`);

/**
 * The quarter index the page holds, from the poll's `m`. Only a whole 0 to 3 counts; anything else (missing, NaN, a
 * negative, a fraction, a huge number) is treated as 0, so junk never makes the server resend the region every poll.
 */
export const heldQuarter = (raw: string | undefined): number =>
	raw !== undefined && /^[0-3]$/.test(raw) ? Number(raw) : 0;

/**
 * The pages a line can sit on, by the key its poll carries (`p`), and the element each one's Undo redraws (#842 round 2).
 * The server maps the key to the selector; a client never sends a selector.
 */
export const RECHECK_PAGES = {
	suggestions: "#suggestions-page",
	organize: "#organize-page",
	categories: "#categories",
} as const;
export type RecheckPage = keyof typeof RECHECK_PAGES;

/** The page a poll's `p` names, or undefined for a key that is not on the list (never an element it was not given). */
export const recheckPage = (
	raw: string | undefined,
): RecheckPage | undefined =>
	raw !== undefined && Object.hasOwn(RECHECK_PAGES, raw)
		? (raw as RecheckPage)
		: undefined;

/**
 * The sentence alone, the part that polls. `polls` is false for a picture in the catalog, which fires nothing by itself
 * and draws no ids (so the catalog never repeats the app's). The count is its own tabular span, aria-hidden, since the
 * spoken count is the milestone region's (decision 128 keeps the figures tabular).
 */
export function RecheckSentence({
	run,
	polls = true,
	page,
}: {
	run: RecheckRun;
	polls?: boolean;
	page?: RecheckPage;
}) {
	const done = recheckDone(run);
	const milestone = recheckMilestone(done, run.total);
	return (
		<p
			{...(polls ? { id: "recheck-line" } : {})}
			class="flex items-center gap-2 text-sm text-muted"
			{...(polls
				? {
						"hx-get": `/resort/progress?run=${run.id}&m=${milestone}${page ? `&p=${page}` : ""}`,
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
			{recheckMilestoneText(recheckMilestone(done, run.total), done, run.total)}
		</span>
	);
}

/** The live region with the sentence and the hidden milestone region, or nothing when no run is going. */
export function RecheckLine({
	run,
	polls = true,
	page,
}: {
	run: RecheckRun | null;
	polls?: boolean;
	page?: RecheckPage;
}) {
	if (!run) return null;
	const done = recheckDone(run);
	const milestone = recheckMilestone(done, run.total);
	return (
		<div {...(polls ? { id: "recheck" } : {})} class="mt-4">
			<RecheckSentence run={run} polls={polls} page={page} />
			<span
				{...(polls ? { id: "recheck-milestone" } : {})}
				role="status"
				aria-live="polite"
				class="sr-only"
			>
				{recheckMilestoneText(milestone, done, run.total)}
			</span>
		</div>
	);
}

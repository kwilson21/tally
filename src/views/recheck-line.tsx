// The re-sort's progress line (decision 159): one quiet sentence, "Tally is re-checking… N done", shown on the page a
// Create lands on while its run is going. The wrapper is the live region (role=status, polite), and it is stable; the
// sentence inside it polls /resort/progress every 2 seconds and each answer replaces only that sentence, so the count
// is announced politely and never as a list. The answer that ends the run is empty, so the sentence and its polling
// leave the page with it. Nothing here is drawn without a running run.
import { BusyRing } from "./busy-ring";

/** A running run as the line draws it: its id (the poll's address) and how many of its rows are done. */
export type RecheckRun = { id: string; done: number; total: number };

/** The count the line says: never below zero, never past the run's total. */
export const recheckDone = (run: RecheckRun): number =>
	Math.min(Math.max(0, run.done), run.total);

/**
 * The sentence alone, the part that polls. `polls` is false for a picture in the catalog, which fires nothing by itself.
 * The count is its own tabular span, since it changes in place inside the sentence (decision 128).
 */
export function RecheckSentence({
	run,
	polls = true,
}: {
	run: RecheckRun;
	polls?: boolean;
}) {
	return (
		<p
			id="recheck-line"
			class="flex items-center gap-2 text-sm text-muted"
			{...(polls
				? {
						"hx-get": `/resort/progress?run=${run.id}`,
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
				<span class="tabular-nums">{recheckDone(run)}</span> done
			</span>
		</p>
	);
}

/** The live region with the sentence in it, or nothing when no run is going. */
export function RecheckLine({
	run,
	polls = true,
}: {
	run: RecheckRun | null;
	polls?: boolean;
}) {
	if (!run) return null;
	return (
		<div id="recheck" role="status" aria-live="polite" class="mt-4">
			<RecheckSentence run={run} polls={polls} />
		</div>
	);
}

// The presence check-in (decision 146): setup's reading screen and the questions page post to /home/seen every 30 seconds
// while they are open, so Tally knows who is still there and emails only the people who have left (ready-email.tsx). Home's
// check-in also sends the step its page shows (`step`), so /home/seen redraws the page's first-week top once that step has
// moved on, and someone watching sees the questions appear (it never reloads the page). It is a hidden element that swaps
// nothing and announces nothing, so it is not a live region. It checks in on load, every 30 seconds, and again at once when
// the tab comes back to the screen (visibilitychange). A tab that isn't on screen counts as away (decision 149, the owner's
// pick): home-seen.js, which Layout loads on every page, cancels the check-in while the tab is hidden, so the push and the
// email go to someone who has switched away, unless Plaid Link is open (plaid-link.js then sends a quiet ping).
import { HOME_SEEN_EVERY_MS } from "../first-tally/home-seen";

/** The id lets a refresh swap a new check-in in for the one the page shows (hx-swap-oob="outerHTML"). */
export const HOME_SEEN_ID = "home-seen";

/** The reading step setup's page shows: the words the banks refresh's poll names too (setup-reading.tsx's readingStep). */
export type ShownStep = "reading" | "sorting" | "slow" | "run";

/**
 * The check-in. `step` is given by Home only, as a form value; the questions page sends none. `oob` swaps this check-in in
 * for the one the page shows, which a refresh does once it finds the step has changed, so the page keeps checking in with the
 * step it shows.
 */
export function HomeSeenCheckIn({
	step,
	oob = false,
}: {
	step?: ShownStep;
	oob?: boolean;
}) {
	const checkIn = {
		"hx-post": "/home/seen",
		// visibilitychange from:document checks in when the tab comes back. htmx 4 resolves `from:document` to the document itself
		// (node_modules/htmx.org/dist/htmx.js #findAllExt), so the event reaches it. Going hidden fires it too, and home-seen.js
		// cancels that one.
		"hx-trigger": `load, every ${HOME_SEEN_EVERY_MS / 1000}s, visibilitychange from:document`,
		"hx-swap": "none",
		"hx-status:4xx": "swap:none",
		"hx-status:5xx": "swap:none",
		"data-quiet": true,
		// A Plaid Link window pauses the check-in too, so its answer can't redraw Home mid-link; a quiet ping with no step stands
		// in for each skipped tick, so the person still counts as there (plaid-link.js, decisions 146 and 149).
		"data-waits-for-link": true,
		...(step ? { "hx-vals": JSON.stringify({ step }) } : {}),
	};
	return (
		<div
			id={HOME_SEEN_ID}
			{...(oob ? { "hx-swap-oob": "outerHTML" } : {})}
			hidden
			{...checkIn}
		/>
	);
}

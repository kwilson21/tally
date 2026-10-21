// The presence check-in (decision 146): Home's first-week setup and the questions page post to /home/seen every 30 seconds
// while they are open, so Tally knows who is still there and emails only the people who have left (ready-email.tsx). Home's
// check-in also sends the step its page shows (`step`), so /home/seen reloads the page once that step has moved on, and
// someone watching sees the questions appear. It is a hidden element that swaps nothing and announces nothing, so it is
// not a live region. It is plain htmx, no script.
import { HOME_SEEN_EVERY_MS } from "../first-tally/home-seen";

/** The id lets a refresh swap a new check-in in for the one the page shows (hx-swap-oob="outerHTML"). */
export const HOME_SEEN_ID = "home-seen";

/** The step Home's page shows: the words the banks refresh's poll names too (home.tsx). */
export type ShownStep = "reading" | "sorting" | "slow" | "ready";

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
		"hx-trigger": `load, every ${HOME_SEEN_EVERY_MS / 1000}s`,
		"hx-swap": "none",
		"hx-status:4xx": "swap:none",
		"hx-status:5xx": "swap:none",
		"data-quiet": true,
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

// The presence check-in (decision 146): Home's first-week setup and the questions page post to /home/seen every 30 seconds
// while they are open, so Tally knows who is still there and emails only the people who have left (ready-email.tsx). Home's
// setup draws it only while it can show the change itself (refreshes), and its refresh takes it out once the page stops
// refreshing (home.tsx), so a page that no longer updates counts as away. It is a hidden element that swaps nothing and
// announces nothing, so it is not a live region. It is plain htmx, no script.
import { HOME_SEEN_EVERY_MS } from "../first-tally/home-seen";

/** The id lets the banks refresh take the element out of the page (hx-swap-oob="delete"). */
export const HOME_SEEN_ID = "home-seen";

export function HomeSeenCheckIn() {
	const checkIn = {
		"hx-post": "/home/seen",
		"hx-trigger": `load, every ${HOME_SEEN_EVERY_MS / 1000}s`,
		"hx-swap": "none",
		"hx-status:4xx": "swap:none",
		"hx-status:5xx": "swap:none",
		"data-quiet": true,
	};
	return <div id={HOME_SEEN_ID} hidden {...checkIn} />;
}

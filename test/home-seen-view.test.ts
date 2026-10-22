import { describe, expect, it } from "vitest";
import { HOME_SEEN_EVERY_MS } from "../src/first-tally/home-seen";
import { HomeSeenCheckIn } from "../src/views/home-seen";

// The presence check-in's trigger (decision 149). It checks in on load, every 30 seconds, and at once when the tab comes back
// to the screen: visibilitychange from the document (htmx 4's `from:` modifier takes the keyword `document`, which resolves to
// the document, node_modules/htmx.org/dist/htmx.js #findAllExt). A hidden tab's check-in is cancelled by home-seen.js, so the
// trigger never has to know about visibility, and Tally's CSP has no 'unsafe-eval' for htmx's filter expressions (src/security.ts).

const html = (node: unknown) => String(node).replaceAll("&#39;", "'");

/** The check-in's opening tag, as the page draws it. */
const tagOf = (markup: string) =>
	markup.match(/<div id="home-seen"[^>]*>/)?.[0] ?? "";
const triggerOf = (markup: string) =>
	tagOf(markup).match(/hx-trigger="([^"]*)"/)?.[1];

describe("the presence check-in's trigger (decision 149)", () => {
	it("checks in on load, every 30 seconds, and when the tab comes back to the screen", () => {
		expect(triggerOf(html(HomeSeenCheckIn({})))).toBe(
			"load, every 30s, visibilitychange from:document",
		);
	});

	it("keeps the 30-second interval the constant names", () => {
		expect(HOME_SEEN_EVERY_MS).toBe(30_000);
		expect(triggerOf(html(HomeSeenCheckIn({})))).toContain(
			`every ${HOME_SEEN_EVERY_MS / 1000}s`,
		);
	});

	it("keeps the same trigger on the check-in a refresh swaps in out of band", () => {
		const oob = html(HomeSeenCheckIn({ oob: true, step: "sorting" }));
		expect(triggerOf(oob)).toBe(
			"load, every 30s, visibilitychange from:document",
		);
		expect(tagOf(oob)).toContain('hx-swap-oob="outerHTML"');
	});

	it("never draws htmx's filter expression, which the page's CSP would block", () => {
		expect(triggerOf(html(HomeSeenCheckIn({})))).not.toContain("[");
	});
});

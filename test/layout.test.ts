import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import css from "../src/styles/app.css?raw";

async function home() {
	const res = await exports.default.fetch("http://tally.test/");
	return res.text();
}

describe("app shell", () => {
	it("gives phone scrolling and the last row the same token-derived bottom room", async () => {
		const html = await home();
		const main = html.match(/<main id="main" class="([^"]*)"/)?.[1] ?? "";
		expect(main).toContain("pb-[var(--focus-scroll-room)]");
		expect(main).toContain("lg:pb-24");
		expect(css).toMatch(
			/--focus-scroll-room:\s*calc\([\s\S]*?var\(--tabs-height\)[\s\S]*?var\(--feedback-bottom\)[\s\S]*?var\(--feedback-height\)[\s\S]*?var\(--focus-scroll-gap\)[\s\S]*?var\(--safe-area-bottom\)[\s\S]*?\);/,
		);
		expect(css).toMatch(/scroll-padding-bottom:\s*var\(--focus-scroll-room\)/);
	});

	it("loads our CSS and htmx from our own origin", async () => {
		const html = await home();
		expect(html).toContain('href="/assets/app.css"');
		expect(html).toContain('src="/vendor/htmx.min.js"');
		expect(html).toContain('src="/js/toast.js"');
	});

	it("links the tally-mark favicon, so browsers don't request a missing /favicon.ico", async () => {
		const html = await home();
		expect(html).toContain(
			'<link rel="icon" href="/favicon.svg" type="image/svg+xml"',
		);
	});

	it("shows the demo banner", async () => {
		expect(await home()).toContain("Demo data. Nothing here is real.");
	});

	it("has a skip link, labeled navs, and marks Home as current", async () => {
		const html = await home();
		expect(html).toContain('href="#main"');
		expect(html).toContain('aria-label="Main"');
		expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>[\s\S]*?Home/);
	});

	it("keeps phone tabs above the iPhone home-indicator area", async () => {
		const html = await home();
		expect(html).toContain(
			'<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"',
		);
		expect(html).toMatch(
			/<nav aria-label="Tabs" class="[^"]*pb-\[var\(--safe-area-bottom\)\][^"]*pl-\[var\(--safe-area-left\)\][^"]*pr-\[var\(--safe-area-right\)\][^"]*">/,
		);
		expect(html).toContain("pt-[var(--safe-area-top)]");
		expect(html).toContain(
			"focus:left-[calc(1rem+var(--safe-area-left))] focus:top-[calc(1rem+var(--safe-area-top))]",
		);
		expect(html).toContain(
			"pl-[calc(1.25rem+var(--safe-area-left))] pr-[calc(1.25rem+var(--safe-area-right))]",
		);
		expect(html).toContain(
			"bottom-[calc(var(--feedback-bottom)+var(--safe-area-bottom))]",
		);
	});

	it("has a polite live region and a toast container for HTMX feedback", async () => {
		const html = await home();
		expect(html).toContain('id="announcer"');
		expect(html).toContain('aria-live="polite"');
		expect(html).toContain('id="toasts"');
	});

	it("puts the toast region above an open sheet (z-50), so a failed save can be read", async () => {
		const html = await home();
		const region = html.match(/<div id="toasts" class="([^"]*)"/)?.[1] ?? "";
		const layer = Number(region.match(/(?:^| )z-(\d+)(?: |$)/)?.[1]);
		expect(layer).toBeGreaterThan(50);
		// Taps pass through the region, so a toast over Save never eats the tap that tries again.
		expect(region).toContain("pointer-events-none");
	});

	it("doesn't swap a server error's reply into the page, so a sheet keeps what was typed", async () => {
		const html = await home();
		const content =
			html.match(/<meta name="htmx-config" content="([^"]*)"/)?.[1] ?? "{}";
		const config = JSON.parse(content.replaceAll("&quot;", '"'));
		// htmx 4 swaps every reply but 204 and 304; a 500 joins them. A 4xx (a field's error) and a
		// 502 (a bank that couldn't be reached, which Tally sends with its own message) still swap.
		expect(config.noSwap).toEqual([204, 304, 500]);
	});

	it("turns htmx's own request timeout off, since toast.js keeps the 60 seconds itself", async () => {
		const html = await home();
		const content =
			html.match(/<meta name="htmx-config" content="([^"]*)"/)?.[1] ?? "{}";
		// htmx 4 aborts a timed-out request the same way it aborts a replaced one, so it can't be told apart.
		expect(JSON.parse(content.replaceAll("&quot;", '"')).defaultTimeout).toBe(
			0,
		);
	});
});

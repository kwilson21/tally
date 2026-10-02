import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

async function home() {
	const res = await exports.default.fetch("http://tally.test/");
	return res.text();
}

describe("app shell", () => {
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
		expect(html).toContain("bottom-[calc(6.5rem+var(--safe-area-bottom))]");
	});

	it("has a polite live region and a toast container for HTMX feedback", async () => {
		const html = await home();
		expect(html).toContain('id="announcer"');
		expect(html).toContain('aria-live="polite"');
		expect(html).toContain('id="toasts"');
	});
});

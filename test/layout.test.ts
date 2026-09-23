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

	it("shows the demo banner", async () => {
		expect(await home()).toContain("Demo data. Nothing here is real.");
	});

	it("has a skip link, labeled navs, and marks Home as current", async () => {
		const html = await home();
		expect(html).toContain('href="#main"');
		expect(html).toContain('aria-label="Main"');
		expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>[\s\S]*?Home/);
	});

	it("has a polite live region and a toast container for HTMX feedback", async () => {
		const html = await home();
		expect(html).toContain('id="announcer"');
		expect(html).toContain('aria-live="polite"');
		expect(html).toContain('id="toasts"');
	});
});

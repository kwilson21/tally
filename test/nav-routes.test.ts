import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SIDEBAR_ITEMS } from "../src/views/nav";

// Every destination in the shell's navigation must resolve, even before its feature ships.
const DESTINATIONS = [
	["/transactions", "Transactions"],
	["/bills", "Bills"],
	["/trends", "Trends"],
	["/accounts", "Accounts"],
	["/settings", "Settings"],
	["/more", "More"],
] as const;

describe("navigation destinations", () => {
	it.each(DESTINATIONS)(
		"%s renders inside the shell with its nav item current",
		async (path, label) => {
			const res = await exports.default.fetch(`http://tally.test${path}`);
			const html = await res.text();

			expect(res.status).toBe(200);
			expect(html).toContain('aria-label="Main"');
			expect(html).toMatch(
				new RegExp(`<a[^>]*aria-current="page"[^>]*>[\\s\\S]*?${label}`),
			);
		},
	);

	it("/more links to Accounts and Settings, and not to Documents (decision 84)", async () => {
		const html = await (
			await exports.default.fetch("http://tally.test/more")
		).text();

		for (const href of ["/accounts", "/settings"]) {
			expect(html).toContain(`href="${href}"`);
		}
		expect(html).not.toContain('href="/documents"');
		expect(html).not.toContain(">Documents<");
	});

	it("the sidebar and the phone tabs on every page have no Documents item (decision 84)", async () => {
		for (const path of ["/", "/transactions", "/bills", "/accounts", "/more"]) {
			const html = await (
				await exports.default.fetch(`http://tally.test${path}`)
			).text();
			expect(html, path).not.toContain('href="/documents"');
		}
		expect(SIDEBAR_ITEMS.map((item) => item.key)).not.toContain("documents");
	});

	it("/documents still resolves inside the shell, with no nav item current", async () => {
		const res = await exports.default.fetch("http://tally.test/documents");
		const html = await res.text();

		expect(res.status).toBe(200);
		expect(html).toContain('aria-label="Main"');
		expect(html).toContain("This part of Tally isn&#39;t built yet.");
		expect(html).not.toContain('aria-current="page"');
	});
});

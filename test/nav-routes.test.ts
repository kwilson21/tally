import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Every destination in the shell's navigation must resolve, even before its feature ships.
const DESTINATIONS = [
	["/transactions", "Transactions"],
	["/bills", "Bills"],
	["/trends", "Trends"],
	["/accounts", "Accounts"],
	["/documents", "Documents"],
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

	it("/more links to Accounts, Documents, and Settings", async () => {
		const html = await (
			await exports.default.fetch("http://tally.test/more")
		).text();

		for (const href of ["/accounts", "/documents", "/settings"]) {
			expect(html).toContain(`href="${href}"`);
		}
	});
});

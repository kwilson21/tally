import { describe, expect, it } from "vitest";
import { HowLink } from "../src/views/how-link";
import { SystemDiagram } from "../src/views/system-diagram";
import { ThingsToTry } from "../src/views/things-to-try";

describe("ThingsToTry", () => {
	it("is a labeled section with the three things to do and the How it works link", async () => {
		const html = await ThingsToTry().toString();
		expect(html).toMatch(/<section[^>]*aria-labelledby="things-title"/);
		expect(html).toMatch(
			/<h2 id="things-title"[^>]*>New here\? Things to try<\/h2>/,
		);
		const links = [...html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)</g)].map(
			(m) => [m[1], m[2]],
		);
		expect(links).toEqual([
			["/transactions?uncategorized=1", "Give a transaction a category"],
			["/transactions/110?uncategorized=1", "Set a rule for a merchant"],
			["/transactions/110?uncategorized=1", "Rename a merchant"],
			["/how-it-works", "How Tally works →"],
		]);
	});

	it("gives every link a 44px touch target", async () => {
		const html = await ThingsToTry().toString();
		for (const a of html.match(/<a [^>]*>/g) ?? []) {
			expect(a).toContain("min-h-11");
		}
	});
});

describe("HowLink", () => {
	it("links to its section of How Tally works in the demo", async () => {
		const html = String(await HowLink({ section: "budget", demo: true }));
		expect(html).toMatch(/href="\/how-it-works#budget"/);
		expect(html).toContain("How this works");
		expect(html).toContain("min-h-11");
	});

	it("renders nothing outside the demo", async () => {
		expect(HowLink({ section: "budget", demo: false })).toBeNull();
	});
});

describe("SystemDiagram", () => {
	it("is an accessible image with a title and a description", async () => {
		const html = await SystemDiagram().toString();
		expect(html).toMatch(
			/<svg[^>]*role="img"[^>]*aria-labelledby="diagram-title diagram-desc"/,
		);
		expect(html).toMatch(/<title id="diagram-title">[^<]+<\/title>/);
		expect(html).toMatch(/<desc id="diagram-desc">[^<]+<\/desc>/);
	});

	it("shows every part of the system", async () => {
		const html = await SystemDiagram().toString();
		for (const label of [
			"Your bank",
			"(via Plaid)",
			"Tally server",
			"(Cloudflare Worker)",
			"Database",
			"(D1)",
			"Jev:",
			"picks categories",
			"Workers AI:",
			"suggests names",
		]) {
			expect(html).toContain(`>${label}<`);
		}
	});

	it("scales to the screen width and uses the icon stroke width", async () => {
		const html = await SystemDiagram().toString();
		expect(html).toMatch(/<svg[^>]*viewBox="[^"]+"/);
		const svgClass = html.match(/<svg[^>]*class="([^"]+)"/)?.[1] ?? "";
		expect(svgClass.split(" ")).toEqual(
			expect.arrayContaining(["w-full", "h-auto"]),
		);
		expect(html.match(/stroke-width="([^"]+)"/g)).toEqual([
			'stroke-width="1.75"',
		]);
	});
});

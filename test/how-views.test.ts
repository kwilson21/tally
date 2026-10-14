import { describe, expect, it } from "vitest";
import { START_HERE } from "../src/design-system/mock";
import { HowLink } from "../src/views/how-link";
import { DemoBanner } from "../src/views/layout";
import { StartHere } from "../src/views/start-here";
import { SystemDiagram } from "../src/views/system-diagram";
import { ThingsToTry } from "../src/views/things-to-try";
import { WhyLink } from "../src/views/why-link";

const decode = (html: string) =>
	html
		.replaceAll("&#39;", "'")
		.replaceAll("&quot;", '"')
		.replaceAll("&amp;", "&");

describe("ThingsToTry", () => {
	it("is the three things to do under a heading, each linking to where it's done (spec §9)", async () => {
		const html = await ThingsToTry().toString();
		expect(html).toMatch(/<h3[^>]*>Three things to try<\/h3>/);
		const links = [...html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)</g)].map(
			(m) => [m[1], m[2]],
		);
		expect(links).toEqual([
			["/transactions?uncategorized=1", "Give a transaction a category"],
			["/transactions/110?uncategorized=1", "Set a rule for a merchant"],
			["/transactions/110?uncategorized=1", "Rename a merchant"],
		]);
	});

	it("drops Home's box and its How Tally works link, which Start here is already part of", async () => {
		const html = await ThingsToTry().toString();
		expect(html).not.toContain("New here?");
		expect(html).not.toContain("How Tally works");
		expect(html).not.toContain("<section");
	});

	it("names the edit panel's own controls: the rule tick and the Name row (#491, #353)", async () => {
		const html = await ThingsToTry().toString();
		expect(html).toContain(
			"For a rule, open a transaction and tick &quot;Use this category for … from now on.&quot;",
		);
		expect(html).toContain("For a new name, pick one in its Name row.");
		expect(html).not.toContain("Always for this merchant");
		expect(html).not.toContain("Rename or add a note");
	});

	it("gives every link a 44px touch target", async () => {
		const html = await ThingsToTry().toString();
		for (const a of html.match(/<a [^>]*>/g) ?? []) {
			expect(a).toContain("min-h-11");
		}
	});
});

describe("DemoBanner", () => {
	it("reads Demo data and links Start here, in ink and underlined, to How Tally works' first section (P124 A)", async () => {
		const html = await DemoBanner().toString();
		expect(html).toContain("Demo data. Nothing here is real. ·");
		const link = html.match(/<a [^>]*>Start here<\/a>/)?.[0] ?? "";
		expect(link).toContain('href="/how-it-works#start-here"');
		for (const word of ["min-h-11", "text-ink", "underline"]) {
			expect(link).toContain(word);
		}
	});

	it("is not hidden on any width, so it shows above the sidebar on desktop too (#549)", async () => {
		const html = await DemoBanner().toString();
		expect(html).not.toMatch(/hidden/);
	});
});

describe("StartHere", () => {
	const view = async () =>
		StartHere({
			monthName: "October",
			rows: START_HERE.rows,
			safeToSpendCents: START_HERE.safeToSpendCents,
		}).toString();

	it("is the demo's first section, labelled by its h2, with the made-up family sentence in this month's name", async () => {
		const html = await view();
		expect(html).toMatch(
			/<section id="start-here" aria-labelledby="start-here-title"/,
		);
		expect(html).toMatch(/<h2 id="start-here-title"[^>]*>Start here<\/h2>/);
		expect(decode(html)).toContain(
			"The Riveras are a made-up family. Here's what their bank sent this October, and what Tally wrote down.",
		);
	});

	it("strikes each bank line, says so for a screen reader, and puts Tally's row for it under the line", async () => {
		const html = await view();
		const pairs = [
			...html.matchAll(
				/<s class="decoration-muted">([^<]+)<\/s>[\s\S]*?data-transaction="(\d+)"/g,
			),
		].map((m) => [m[1], Number(m[2])]);
		expect(pairs).toEqual([
			["ACME CORP PAYROLL", 901],
			["ONLINE TRANSFER TO SAV ...5678", 902],
			["SQ *LOCAL BAKERY 4432", 110],
		]);
		expect(
			html.match(/<span class="sr-only">The bank sent <\/span>/g),
		).toHaveLength(3);
	});

	it("says what would count without Tally, with its link to the list without Tally", async () => {
		const html = await view();
		expect(html).toContain(
			"Without Tally, the paycheck and the transfer would both count as spending.",
		);
		expect(html).toMatch(
			/<a href="\/transactions\?raw=1"[^>]*>See every line without Tally<\/a>/,
		);
	});

	it("shows Safe to spend in whole dollars under a decorative double rule, with one line on what it means", async () => {
		const html = await view();
		expect(html).toContain("$1,240");
		expect(html).toMatch(/<div[^>]*border-double[^>]*>/);
		expect(html.match(/<div[^>]*border-double[^>]*>/)?.[0]).toContain(
			'aria-hidden="true"',
		);
		expect(decode(html)).toContain(
			"What's left of October's budget after its spending so far, bills due and savings. It's the big number on Home.",
		);
	});

	it("gives the three things to try under their heading, and every link a 44px target", async () => {
		const html = await view();
		expect(html).toContain("Three things to try");
		for (const a of html.match(/<a [^>]*>/g) ?? []) {
			expect(a).toContain("min-h-11");
		}
	});

	it("draws the ledger picture for decoration only", async () => {
		const html = await view();
		expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
	});
});

describe("HowLink", () => {
	it("links to its section of How Tally works", async () => {
		const html = String(await HowLink({ section: "budget" }));
		expect(html).toMatch(/href="\/how-it-works#budget"/);
		expect(html).toContain("How this works");
		expect(html).toContain("min-h-11");
		// Each link says where it goes, so several on one page stay distinct (WCAG 2.4.4).
		expect(html).toContain('aria-label="How this works: the budget"');
	});
});

describe("WhyLink", () => {
	it("links to the exact explanation with a distinct name and 44px target", async () => {
		const html = String(
			await WhyLink({ section: "categorization", topic: "Tally's guess" }),
		);
		expect(html).toContain('href="/how-it-works#categorization"');
		expect(html).toContain('aria-label="Why? Tally&#39;s guess"');
		expect(html).toContain("min-h-11");
		expect(html).toContain("min-w-11");
		expect(html).toContain("justify-center");
		expect(html).toContain(">Why?</a>");
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

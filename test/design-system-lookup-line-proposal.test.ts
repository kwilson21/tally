import { exports } from "cloudflare:workers";
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { LookupLine } from "../src/views/lookup-line";

// P146 (#988): how the store lookup's line and its "Don't use this" look on a Maybe guess, after P145 on the proposals page.

const PROPOSAL = 'aria-labelledby="p146-title"';

/**
 * The P146 section, from its opening tag to its matching closing one. It holds no section of its own, so the end is
 * the first close that brings the nesting depth back to zero.
 */
async function proposal(): Promise<string> {
	const res = await exports.default.fetch(
		"http://tally.test/design-system/proposals",
	);

	const html = await res.text();

	expect(res.status).toBe(200);

	const heading = html.indexOf(PROPOSAL);
	expect(heading, "P146 heading").toBeGreaterThan(-1);
	const start = html.lastIndexOf("<section", heading);

	let depth = 0;
	let end = -1;

	for (const tag of html.slice(start).matchAll(/<\/?section\b/g)) {
		depth += tag[0] === "</section" ? -1 : 1;

		if (depth === 0) {
			end = start + (tag.index ?? 0) + "</section>".length;
			break;
		}
	}

	expect(end, "P146 section closes").toBeGreaterThan(start);

	return html.slice(start, end);
}

const count = (html: string, text: string) => html.split(text).length - 1;

describe("P146, the store lookup's line on a Maybe guess", () => {
	it("sits at the end of the proposals page, after the Decided list, with its heading and intro", async () => {
		const res = await exports.default.fetch(
			"http://tally.test/design-system/proposals",
		);

		const html = await res.text();

		expect(html.indexOf(PROPOSAL)).toBeGreaterThan(
			html.indexOf('aria-labelledby="decided-title"'),
		);
		expect(html).toContain("P146 · The store lookup&#39;s line on a guess");
		expect(html).toContain("Drawn Nov 22 for issue #988.");
	});

	it("draws the three treatments of the line, each by name, on the card at both widths and in the edit panel", async () => {
		const block = await proposal();

		expect(block).toContain("On the review card");
		expect(block).toContain(
			"With the longest line (80 characters), on a phone",
		);
		expect(block).toContain("In the edit panel");
		expect(block).toContain("Not part of the pick: the Settings switch");
		expect(block).toContain("At 1280");

		// Block 1 at phone and desktop width, block 2 and block 3 at phone width: four drawings of each option.
		expect(count(block, ">Looked up, action beside<")).toBe(4);
		expect(count(block, ">From the web, action under<")).toBe(4);
		expect(count(block, ">A note of its own<")).toBe(4);
	});

	it("shows the lookup line in both forms, and the longest line in full", async () => {
		const block = await proposal();

		expect(block).toContain("Looked up: Coffee shop in Arlington, VA");
		expect(block).toContain("From the web: Coffee shop in Arlington, VA");
		expect(block).toContain(">Coffee shop in Arlington, VA<");
		expect(block).toContain(
			"Independent hardware store and garden store in Takoma Park, Maryland, since 1946",
		);
	});

	it("marks option B picked once, on the first phone card block, and nowhere else", async () => {
		const block = await proposal();

		expect(count(block, ">Picked<")).toBe(1);
		expect(block.indexOf(">Picked<")).toBeGreaterThan(
			block.indexOf(">From the web, action under<"),
		);
	});

	it("draws option B with the real LookupLine, the same markup for the same store and line", async () => {
		const block = await proposal();

		const real = renderToString(
			LookupLine({
				line: "Coffee shop in Arlington, VA",
				store: "La Coop",
				button: { type: "button" },
			}),
		);

		expect(block).toContain(real);
	});

	it("puts a real Don't use this button on each treatment, with no lost action", async () => {
		const block = await proposal();

		// Four drawings of each of three options, each with one Don't use this button in its text.
		expect(count(block, ">Don&#39;t use this</button>")).toBe(12);
		expect(block).toContain('aria-label="Don&#39;t use this for La Coop"');
		expect(block).toContain(
			'aria-label="Don&#39;t use this for Maple Street Hardware"',
		);
	});

	it("draws the Settings switch on and greyed out, with its words and no request attributes", async () => {
		const block = await proposal();

		expect(block).toContain("Look up new stores on the web");
		expect(block).toContain(
			"Searches the web once for a store, to help guess its category and name. Only the store&#39;s name as your bank gives it is sent, with numbers taken out.",
		);
		expect(block).toContain("Needs Categories and exclusions and Income on.");
		expect(block).not.toMatch(/<input[^>]*hx-/);
	});

	it("uses unique IDs inside the section", async () => {
		const block = await proposal();

		const ids = [...block.matchAll(/\sid="([^"]+)"/g)].map(
			(match) => match[1] ?? "",
		);

		expect(new Set(ids).size).toBe(ids.length);
	});
});

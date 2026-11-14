import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SORTING_TURN_EXCERPT } from "../src/design-system/proposals-machine-context";
import { machineGraph } from "../src/machines/graph";
import {
	SORTING_TURN_LABELS,
	sortingTurnMachine,
} from "../src/machines/sorting-turn";
import sortingTurnSource from "../src/machines/sorting-turn.ts?raw";

// P144 (#865): the sorting turn's picture with the context the owner asked for, after P143 on the proposals page.

const PROPOSAL = 'aria-labelledby="p144-title"';

/**
 * The P144 section, from its opening tag to its matching closing one. It holds one section of its own, the code's
 * scrolling region, so the end is the close that brings the nesting depth back to zero.
 */
async function proposal(): Promise<string> {
	const res = await exports.default.fetch(
		"http://tally.test/design-system/proposals",
	);

	const html = await res.text();

	expect(res.status).toBe(200);

	const start = html.indexOf(`<section ${PROPOSAL}`);
	expect(start, "P144 section").toBeGreaterThan(-1);

	let depth = 0;
	let end = -1;

	for (const tag of html.slice(start).matchAll(/<\/?section\b/g)) {
		depth += tag[0] === "</section" ? -1 : 1;

		if (depth === 0) {
			end = start + (tag.index ?? 0) + "</section>".length;
			break;
		}
	}

	expect(end, "P144 section closes").toBeGreaterThan(start);

	const block = html.slice(start, end);
	expect(block.match(/<section\b/g)?.length ?? 0, "its one region").toBe(2);

	return block;
}

const decode = (text: string) =>
	text
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");

describe("P144, the sorting turn's picture with its context", () => {
	it("sits after P143 on the proposals page, as an open proposal (not in DECIDED)", async () => {
		const res = await exports.default.fetch(
			"http://tally.test/design-system/proposals",
		);

		const html = await res.text();

		expect(html.indexOf(`<section ${PROPOSAL}`)).toBeGreaterThan(
			html.indexOf('aria-labelledby="p143-title"'),
		);
		expect(html).toContain(
			'<h2 id="p144-title" class="font-serif text-3xl font-semibold">',
		);
	});

	it("draws CURRENT and PROPOSED (C), each picture the real MachineDiagram of the sorting turn with every arrow", async () => {
		const block = await proposal();

		expect(block).toContain("Current: the picture as the catalog shows it");
		expect(block).toContain("Proposed (C): the picture with its context");

		const { edges } = machineGraph(sortingTurnMachine);
		// The picture draws one arrow per pair of states, plus the arrow from its start dot into the first state; the
		// sentences list every transition.
		const pairs = new Set(edges.map((e) => `${e.from}>${e.to}`)).size;
		const arrows = block.match(/class="pele-edge pele-transition"/g) ?? [];

		expect(arrows).toHaveLength((pairs + 1) * 2);
		expect(block.match(/<dt /g)?.length ?? 0).toBe(edges.length * 2);

		for (const label of Object.values(SORTING_TURN_LABELS))
			expect(block).toContain(`>${label}<`);
	});

	it("has a state table with one row per state of the machine, under a caption and header cells", async () => {
		const block = await proposal();
		const states = Object.keys(sortingTurnMachine.config.states);

		expect(Object.keys(SORTING_TURN_LABELS).sort()).toEqual([...states].sort());
		expect(block).toMatch(/<table[^>]*>/);
		expect(block).toContain("<caption");
		expect(block).toContain("How Tally tells which state it is in");
		expect(block.match(/<th scope="col"/g)?.length ?? 0).toBe(2);
		expect(block.match(/<th scope="row"/g)?.length ?? 0).toBe(states.length);

		for (const label of Object.values(SORTING_TURN_LABELS))
			expect(block, label).toContain(`${label}</th>`);
	});

	it("names the real stored columns and the rule's files, and says what is not stored", async () => {
		const block = await proposal();

		for (const name of [
			"household_settings",
			"sorting_turn",
			"until",
			"src/machines/sorting-turn.ts",
			"src/db/sorting-turn.ts",
			"test/sorting-turn-machine.test.ts",
		])
			expect(block, name).toContain(name);

		expect(block).toContain("Decisions 139 and 143");
		expect(block).toContain(
			"One sorting group at a time may ask Jev about the household",
		);
	});

	it("shows the code excerpt verbatim in a labelled, keyboard-reachable scroll region", async () => {
		const block = await proposal();

		const start = block.indexOf(
			'aria-label="src/machines/sorting-turn.ts, lines 30 to 42"',
		);

		expect(start).toBeGreaterThan(-1);
		expect(block.slice(start - 60, start)).toContain('tabindex="0"');

		const region = block.slice(start, block.indexOf("</pre>", start));
		expect(region).toContain("overflow-x-auto");

		const code = region.slice(region.indexOf("<pre"));
		const shown = decode(code.slice(code.indexOf(">") + 1));
		expect(shown).toContain(SORTING_TURN_EXCERPT);
	});

	it("has a worked story of five numbered steps, each naming its state and event", async () => {
		const block = await proposal();

		expect(block).toContain("One turn, step by step");
		expect(block.match(/<ol[^>]*>/g)?.length ?? 0).toBe(1);
		expect(block.match(/<li>/g)?.length ?? 0).toBe(5);
	});

	it("keeps to the page's rules: tokens and classes only, no style or htmx attributes, no fixed widths that would overflow a phone", async () => {
		const block = await proposal();

		expect(block).not.toContain("style=");
		expect(block).not.toMatch(/\shx-/);
		expect(block).not.toMatch(/\b(?:min-)?w-\[/);
		expect(block).not.toMatch(/\bw-(?:[4-9]\d\d|\d{4})\b/);
		expect(block).not.toMatch(/>Recommended</);
	});
});

describe("the code excerpt", () => {
	it("is an exact substring of the machine's real source, so it can't drift from it", () => {
		expect(sortingTurnSource).toContain(SORTING_TURN_EXCERPT);
		expect(SORTING_TURN_EXCERPT.split("\n")).toHaveLength(13);
	});
});

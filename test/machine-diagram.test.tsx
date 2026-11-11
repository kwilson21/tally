/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import type { AnyStateMachine } from "xstate";
import {
	CATEGORY_SUGGESTION_LABELS,
	categorySuggestionMachine,
} from "../src/machines/category-suggestion";
import { machineGraph } from "../src/machines/graph";
import {
	MERCHANT_SUGGESTION_LABELS,
	merchantSuggestionMachine,
} from "../src/machines/merchant-suggestion";
import { MachineDiagram, machineSource } from "../src/views/machine-diagram";

const draw = (machine: AnyStateMachine, labels: Record<string, string>) =>
	String(
		MachineDiagram({ id: "d", title: "A test machine", machine, labels }),
	).replaceAll("&#39;", "'");

const MACHINES = [
	[categorySuggestionMachine, CATEGORY_SUGGESTION_LABELS],
	[merchantSuggestionMachine, MERCHANT_SUGGESTION_LABELS],
] as const;

describe("MachineDiagram", () => {
	it("draws a box for every state and says every arrow in a sentence, read from the machine", () => {
		for (const [machine, labels] of MACHINES) {
			const html = draw(machine, labels);
			const { nodes, edges } = machineGraph(machine);
			expect(html.match(/class="pele-node pele-state[ "]/g)).toHaveLength(
				nodes.length,
			);
			expect(html.match(/<dt /g)).toHaveLength(edges.length);

			for (const edge of edges) expect(html).toContain(`${edge.words}.`);

			for (const node of nodes) expect(html).toContain(`>${labels[node.key]}<`);
		}
	});

	it("says each pair of states once, with all its events on one arrow", () => {
		const source = machineSource(
			merchantSuggestionMachine,
			MERCHANT_SUGGESTION_LABELS,
		);

		expect(source).toContain("none --> pending: bank name, names");
		expect(source).toContain("pending --> pending: bank name");
	});

	it("shades the finished states and no others, and draws no end marker after them", () => {
		const html = draw(merchantSuggestionMachine, MERCHANT_SUGGESTION_LABELS);
		expect(html.match(/pele-state done"/g)).toHaveLength(2);
		expect(html).not.toContain("pele-state-end");
	});

	it("is one labelled picture whose description walks the arrows", () => {
		const html = draw(merchantSuggestionMachine, MERCHANT_SUGGESTION_LABELS);
		expect(html).toContain('role="img"');
		expect(html).toContain('aria-labelledby="d-title d-desc"');
		expect(html).toContain("None is where it starts.");
		expect(html).toContain("Waiting goes to Accepted on accept.");
	});

	it("keeps every word inside the picture's frame", () => {
		for (const [machine, labels] of MACHINES) {
			const html = draw(machine, labels);
			const frame = html.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
			const width = Number(frame?.[1]);
			const height = Number(frame?.[2]);
			expect(width).toBeGreaterThan(0);
			expect(width).toBeLessThanOrEqual(520);

			for (const word of html.matchAll(
				/<text[^>]* x="([-\d.]+)" y="([-\d.]+)"/g,
			)) {
				expect(Number(word[1])).toBeGreaterThanOrEqual(0);
				expect(Number(word[1])).toBeLessThanOrEqual(width);
				expect(Number(word[2])).toBeGreaterThanOrEqual(0);
				expect(Number(word[2])).toBeLessThanOrEqual(height);
			}
		}
	});
});

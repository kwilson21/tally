/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import {
	CATEGORY_SUGGESTION_LABELS,
	categorySuggestionMachine,
} from "../src/machines/category-suggestion";
import { machineGraph } from "../src/machines/graph";
import {
	MERCHANT_SUGGESTION_LABELS,
	merchantSuggestionMachine,
} from "../src/machines/merchant-suggestion";
import { MachineDiagram } from "../src/views/machine-diagram";

const draw = (
	machine: typeof merchantSuggestionMachine,
	labels: Record<string, string>,
) =>
	String(
		MachineDiagram({ id: "d", title: "A test machine", machine, labels }),
	).replaceAll("&#39;", "'");

describe("MachineDiagram", () => {
	it("draws a box for every state and says every arrow in a sentence, read from the machine", () => {
		for (const [machine, labels] of [
			[categorySuggestionMachine, CATEGORY_SUGGESTION_LABELS],
			[merchantSuggestionMachine, MERCHANT_SUGGESTION_LABELS],
		] as const) {
			const html = draw(machine as typeof merchantSuggestionMachine, labels);
			const { nodes, edges } = machineGraph(machine);
			expect(html.match(/<rect /g)).toHaveLength(nodes.length);
			expect(html.match(/<dt /g)).toHaveLength(edges.length);
			for (const edge of edges) expect(html).toContain(`${edge.words}.`);
			for (const node of nodes) expect(html).toContain(`>${labels[node.key]}<`);
		}
	});

	it("shades the finished states and no others", () => {
		const html = draw(merchantSuggestionMachine, MERCHANT_SUGGESTION_LABELS);
		expect(html.match(/fill-band/g)).toHaveLength(2);
	});

	it("is one labelled picture whose description walks the arrows", () => {
		const html = draw(merchantSuggestionMachine, MERCHANT_SUGGESTION_LABELS);
		expect(html).toContain('role="img"');
		expect(html).toContain('aria-labelledby="d-title d-desc"');
		expect(html).toContain("None is where it starts.");
		expect(html).toContain("Waiting goes to Accepted on accept.");
	});

	it("stays inside its 360 wide frame, loop and arrow back included", () => {
		const html = draw(merchantSuggestionMachine, MERCHANT_SUGGESTION_LABELS);
		expect(html).toContain('viewBox="0 0 360 ');
		for (const x of html.matchAll(/ x="(-?[\d.]+)"/g))
			expect(Number(x[1])).toBeGreaterThanOrEqual(0);
	});
});

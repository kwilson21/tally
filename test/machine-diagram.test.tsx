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

	it("keeps every box, arrow and word inside its frame, loop and arrow back included", () => {
		for (const [machine, labels] of [
			[categorySuggestionMachine, CATEGORY_SUGGESTION_LABELS],
			[merchantSuggestionMachine, MERCHANT_SUGGESTION_LABELS],
		] as const) {
			const html = draw(machine as typeof merchantSuggestionMachine, labels);
			const frame = html.match(/viewBox="0 0 (\d+) (\d+)"/);
			const width = Number(frame?.[1]);
			const height = Number(frame?.[2]);
			expect(width).toBe(360);
			const inside = (x: number, y: number, what: string) => {
				expect(x, `${what} x`).toBeGreaterThanOrEqual(0);
				expect(x, `${what} x`).toBeLessThanOrEqual(width);
				expect(y, `${what} y`).toBeGreaterThanOrEqual(0);
				expect(y, `${what} y`).toBeLessThanOrEqual(height);
			};
			for (const rect of html.matchAll(
				/<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g,
			))
				inside(
					Number(rect[1]) + Number(rect[3]),
					Number(rect[2]) + Number(rect[4]),
					"box far corner",
				);
			for (const text of html.matchAll(/<text x="([-\d.]+)" y="([-\d.]+)"/g))
				inside(Number(text[1]), Number(text[2]), "word");
			for (const path of html.matchAll(/<path d="([^"]+)"/g)) {
				// Every command here is M, L, C (pairs), H (an x) or V (a y); read its points in order.
				let x = 0;
				let y = 0;
				for (const part of path[1]?.match(/[MLCHV][^MLCHV]*/g) ?? []) {
					const nums = (part.slice(1).match(/-?[\d.]+/g) ?? []).map(Number);
					if (part[0] === "H") {
						x = nums[0] as number;
						inside(x, y, "arrow");
					} else if (part[0] === "V") {
						y = nums[0] as number;
						inside(x, y, "arrow");
					} else
						for (let i = 0; i + 1 < nums.length; i += 2) {
							x = nums[i] as number;
							y = nums[i + 1] as number;
							inside(x, y, "arrow");
						}
				}
			}
		}
	});
});

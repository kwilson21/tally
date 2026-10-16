import { describe, expect, it } from "vitest";
import { Notebook } from "../src/views/notebook";
import { stepsOf, TallySteps } from "../src/views/tally-steps";

const NAMES = [
	"Link your bank",
	"Your pay",
	"Your bills",
	"Your budgets",
	"Tomorrow · Tally keeps count on its own",
];

// The notebook's five strokes are the only lines at these x positions; the frame and the pencil are elsewhere.
const drawnStrokes = (html: string) =>
	(html.match(/<line x1="(?:46|53|60|67|41)"/g) ?? []).length;

describe("Notebook", () => {
	it("draws only the strokes so far, and is decorative", async () => {
		expect(drawnStrokes(String(await Notebook({ strokes: 0 })))).toBe(0);
		expect(
			drawnStrokes(String(await Notebook({ strokes: 2, ink: true }))),
		).toBe(2);
		expect(
			drawnStrokes(String(await Notebook({ strokes: 5, ink: true }))),
		).toBe(5);
		expect(String(await Notebook({ strokes: 5 }))).toContain(
			'aria-hidden="true"',
		);
	});

	it("draws drawn strokes in pencil unless asked for ink", async () => {
		const pencil = String(await Notebook({ strokes: 1 }));
		expect(pencil).toContain('class="stroke-muted"');
		const inked = String(await Notebook({ strokes: 1, ink: true }));
		expect(inked).toContain("stroke-ink");
		expect(inked).not.toContain("stroke-muted");
	});
});

describe("TallySteps", () => {
	it("names the done count, names each step, and says done only on done lines", async () => {
		const steps = stepsOf(
			NAMES,
			[
				"Chase, linked",
				"Next",
				"Tomorrow morning",
				"Tomorrow morning",
				"Later",
			],
			1,
		);
		const html = String(await TallySteps({ steps }));
		expect(html).toContain("Your first tally · 1 of 5");
		for (const name of NAMES) expect(html).toContain(name);
		expect(html.match(/, done</g)?.length).toBe(1);
		expect(html).toContain("Chase, linked");
		expect(html).toContain("Next");
	});

	it("counts done from the lines it is given", async () => {
		const blank = NAMES.map(() => "");
		const none = String(await TallySteps({ steps: stepsOf(NAMES, blank, 0) }));
		expect(none).toContain("Your first tally · 0 of 5");
		expect(none).not.toContain(", done<");
		const all = String(await TallySteps({ steps: stepsOf(NAMES, blank, 5) }));
		expect(all).toContain("Your first tally · 5 of 5");
		expect(all.match(/, done</g)?.length).toBe(5);
	});
});

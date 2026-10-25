/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { READING_STEP, StepBar } from "../src/views/step-bar";

// Setup's step bar (P142 A, decision 148): four segments, one inked for each step done and the next one half inked, with the
// words that say where setup is. The segments are hidden from assistive technology.
const bars = async (done: number, label = "Step done") => {
	const html = String(await StepBar({ done, label }));
	// Each segment is a span of its own class; the fill is the one background token it carries.
	const fills = [
		...html.matchAll(/<span class="h-1 rounded-full ([^"]*)"><\/span>/g),
	].map((m) => m[1]);
	return { html, fills };
};

describe("StepBar", () => {
	it("draws one ink segment, one half-inked, and two rule segments at step one done", async () => {
		const { fills } = await bars(1);
		expect(fills).toHaveLength(4);
		expect(fills.filter((f) => f === "bg-ink")).toHaveLength(1);
		expect(fills.filter((f) => f === "bg-ink/40")).toHaveLength(1);
		expect(fills.filter((f) => f === "bg-rule")).toHaveLength(2);
	});

	it("draws four ink segments and no half-inked one once setup is done", async () => {
		const { fills } = await bars(4);
		expect(fills).toEqual(["bg-ink", "bg-ink", "bg-ink", "bg-ink"]);
		expect(fills).not.toContain("bg-ink/40");
	});

	it("draws no ink at step zero, and the next segment half inked", async () => {
		const { fills } = await bars(0);
		expect(fills).toEqual(["bg-ink/40", "bg-rule", "bg-rule", "bg-rule"]);
	});

	it("says where setup is in a paragraph, and hides the segments from assistive technology", async () => {
		const { html } = await bars(1, "Step 2 of 4 · Your pay");
		expect(html).toContain('<p class="text-sm text-muted">Step 2 of 4 · Your pay</p>');
		expect(html).toMatch(
			/<div class="mt-2 grid grid-cols-4 gap-1\.5" aria-hidden="true">/,
		);
	});

	it("exports the reading screen's label, as the words the step bar says", () => {
		expect(READING_STEP).toBe("Step 1 of 4 done · Reading your bank");
	});
});

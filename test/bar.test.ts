import { describe, expect, it } from "vitest";
import { barGeometry } from "../src/views/bar";

// Decision 46 (P4, P5): the bar has no limit marker. Under budget it fills by spent over budget;
// over budget it's simply full.
describe("barGeometry", () => {
	it("fills by spent over budget", () => {
		expect(barGeometry(41200, 70000)).toEqual({ fillPct: 58.9 });
	});

	it("is full when spending is at or over the budget", () => {
		expect(barGeometry(25000, 25000)).toEqual({ fillPct: 100 });
		expect(barGeometry(28600, 25000)).toEqual({ fillPct: 100 });
	});

	it("shows an empty bar when refunds make spent negative", () => {
		expect(barGeometry(-500, 10000)).toEqual({ fillPct: 0 });
	});

	it("handles a zero budget without dividing by zero", () => {
		expect(barGeometry(0, 0)).toEqual({ fillPct: 0 });
		expect(barGeometry(500, 0)).toEqual({ fillPct: 100 });
	});
});

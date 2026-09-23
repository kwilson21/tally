import { describe, expect, it } from "vitest";
import { barGeometry } from "../src/views/bar";

describe("barGeometry", () => {
	it("fills by spent over budget, with the limit at the end", () => {
		expect(barGeometry(41200, 70000)).toEqual({ fillPct: 58.9, limitPct: 100 });
	});

	it("when over, fills the whole track and moves the limit notch back", () => {
		expect(barGeometry(28600, 25000)).toEqual({ fillPct: 100, limitPct: 87.4 });
	});

	it("shows an empty bar when refunds make spent negative", () => {
		expect(barGeometry(-500, 10000)).toEqual({ fillPct: 0, limitPct: 100 });
	});

	it("handles a zero budget without dividing by zero", () => {
		expect(barGeometry(0, 0)).toEqual({ fillPct: 0, limitPct: 0 });
		expect(barGeometry(500, 0)).toEqual({ fillPct: 100, limitPct: 0 });
	});
});

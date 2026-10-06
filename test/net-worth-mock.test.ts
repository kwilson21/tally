import { describe, expect, it } from "vitest";
import {
	NET_WORTH_CENTS,
	NET_WORTH_TODAY,
	NET_WORTH_VIEWS,
	netWorthViewEnding,
} from "../src/design-system/mock";
import { formatCents } from "../src/money";

describe("the catalog's net-worth examples", () => {
	const headline = formatCents(NET_WORTH_CENTS, { wholeDollars: true });

	it("every line ends on today's net worth, the headline's, however it got there", () => {
		for (const name of ["rising", "falling", "startedThisMonth"] as const) {
			const view = NET_WORTH_VIEWS[name];
			if (view.kind !== "line") throw new Error(`${name} should be a line`);
			expect(view.description, name).toContain(`is ${headline} today.`);
			expect(view.endLabel, name).toBe("Today");
		}
	});

	it("the falling line starts $3,600 above today's net worth, not below it", () => {
		const view = NET_WORTH_VIEWS.falling;
		if (view.kind !== "line") throw new Error("expected a line");
		expect(view.sentence).toBe("Down $3,600 since May.");
		expect(view.description).toContain(
			`It was ${formatCents(NET_WORTH_CENTS + 360000, { wholeDollars: true })} on May 1`,
		);
		expect(NET_WORTH_TODAY).toBe("2026-10-05");
	});

	it("a line can be drawn to end on any headline, as a proposal's own number needs", () => {
		const view = netWorthViewEnding(2340000);
		if (view.kind !== "line") throw new Error("expected a line");
		expect(view.description).toContain("and is $23,400 today.");
		expect(view.sentence).toBe("Up $3,600 since May.");
	});

	it("the waiting example draws no line and says what it waits for", () => {
		expect(NET_WORTH_VIEWS.waiting).toEqual({
			kind: "early",
			sentence: null,
			note: "The chart starts once every account has a balance.",
		});
	});
});

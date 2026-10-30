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
		for (const name of [
			"rising",
			"falling",
			"startedThisMonth",
			"cardAdded",
			"bankLinked",
		] as const) {
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

	// The SVG points, in order: the weekly climb (22 points, May 1 to Sep 25), then a day each from Sep 28 to Oct 4, then
	// today. So Sep 30 is the 25th point (index 24) and Oct 1, the account's first day, the one after it (index 25).
	const pointsOf = (view: { points: string }) =>
		view.points
			.split(" ")
			.map((p) => p.split(",").map(Number) as [number, number]);

	it("an account added steps the line down on its first day by what the card owes, and the sentence names the card", () => {
		const view = NET_WORTH_VIEWS.cardAdded;
		if (view.kind !== "line") throw new Error("expected a line");
		// The card wasn't counted in May, so May's net worth is $1,240 higher than the climb; the change reads $2,360, not $3,600.
		expect(view.startLabel).toBe("May");
		expect(view.sentence).toBe(
			"Up $2,360 since May. You added Apple Card on Oct 1.",
		);
		expect(view.description).toContain(
			`It was ${formatCents(NET_WORTH_CENTS - 236000, { wholeDollars: true })} on May 1`,
		);
		// Lower net worth sits lower on the page (a larger y), so the line steps down from Sep 30 to Oct 1.
		const points = pointsOf(view);
		expect(points[25]?.[1]).toBeGreaterThan(points[24]?.[1] ?? 0);
	});

	it("a bank linked steps the line up on its first day by its cash, and the sentence names the bank", () => {
		const view = NET_WORTH_VIEWS.bankLinked;
		if (view.kind !== "line") throw new Error("expected a line");
		expect(view.startLabel).toBe("May");
		expect(view.sentence).toBe(
			"Up $9,940 since May. You linked Wells Fargo on Oct 1.",
		);
		expect(view.description).toContain(
			`It was ${formatCents(NET_WORTH_CENTS - 994000, { wholeDollars: true })} on May 1`,
		);
		const points = pointsOf(view);
		expect(points[25]?.[1]).toBeLessThan(points[24]?.[1] ?? 0);
	});

	it("no example still waits for an account: the waiting state is gone from the catalog's views", () => {
		expect(Object.keys(NET_WORTH_VIEWS)).not.toContain("waiting");
	});
});

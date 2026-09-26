import { describe, expect, it } from "vitest";
import { MAX_BUDGET_CENTS } from "../src/budgets/amount";
import { NUDGE_STEP_CENTS, nudgeCents } from "../src/budgets/nudge";

describe("nudgeCents", () => {
	it("steps by $10", () => {
		expect(NUDGE_STEP_CENTS).toBe(1000);
	});

	it("moves a round amount by one step", () => {
		expect(nudgeCents(72000, "up")).toBe(73000);
		expect(nudgeCents(72000, "down")).toBe(71000);
	});

	it("moves any other amount to the next round $10 that way", () => {
		expect(nudgeCents(71200, "up")).toBe(72000);
		expect(nudgeCents(71200, "down")).toBe(71000);
		expect(nudgeCents(71299, "up")).toBe(72000);
		expect(nudgeCents(70001, "down")).toBe(70000);
	});

	it("never goes below $0", () => {
		expect(nudgeCents(0, "down")).toBe(0);
		expect(nudgeCents(300, "down")).toBe(0);
		expect(nudgeCents(1000, "down")).toBe(0);
		expect(nudgeCents(0, "up")).toBe(1000);
	});

	it("never goes above the largest budget", () => {
		expect(nudgeCents(MAX_BUDGET_CENTS, "up")).toBe(MAX_BUDGET_CENTS);
		expect(nudgeCents(MAX_BUDGET_CENTS - 500, "up")).toBe(MAX_BUDGET_CENTS);
		expect(nudgeCents(MAX_BUDGET_CENTS, "down")).toBe(MAX_BUDGET_CENTS - 1000);
	});
});

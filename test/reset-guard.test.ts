import { describe, expect, it } from "vitest";
import { canResetDemo } from "../src/demo/reset";

describe("canResetDemo", () => {
	it("allows the reset in the demo", () => {
		expect(canResetDemo({ DEMO: "true" })).toBe(true);
	});

	it("refuses when DEMO is not true", () => {
		expect(canResetDemo({ DEMO: "false" })).toBe(false);
		expect(canResetDemo({})).toBe(false);
	});

	it("refuses when Plaid credentials are present, even with DEMO set to true", () => {
		expect(canResetDemo({ DEMO: "true", PLAID_SECRET: "x" })).toBe(false);
		expect(canResetDemo({ DEMO: "true", PLAID_CLIENT_ID: "x" })).toBe(false);
	});
});

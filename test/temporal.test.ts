import { describe, expect, it } from "vitest";

// The `temporal` compatibility flag (wrangler.jsonc) makes Temporal available; src/dates.ts uses it.
describe("Temporal in the Worker runtime", () => {
	it("is available", () => {
		expect(typeof Temporal).toBe("object");
		expect(
			Temporal.PlainDate.from("2026-02-28").add({ days: 1 }).toString(),
		).toBe("2026-03-01");
	});
});

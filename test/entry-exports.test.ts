import { describe, expect, it } from "vitest";
import * as entry from "../src/index";

// workerd treats every named export of the Worker's entry module as an entrypoint, and refuses to
// start if one isn't a function or a handler object (a plain string broke `wrangler dev` once).
describe("the Worker's entry module", () => {
	it("exports only functions and handler objects", () => {
		for (const [name, value] of Object.entries(entry)) {
			const ok =
				typeof value === "function" ||
				(typeof value === "object" &&
					value !== null &&
					typeof (value as { fetch?: unknown }).fetch === "function");
			expect(ok, `${name} must be a function or a handler`).toBe(true);
		}
	});
});

import { describe, expect, it } from "vitest";
import * as entry from "../src/index";

// workerd treats every named export of the Worker's entry module as an entrypoint, and refuses to
// start if one isn't a function or a handler object (a plain string broke `wrangler dev` once).

/** A function, or an object whose `fetch` is a function: the two shapes workerd accepts as an entrypoint. */
type Entrypoint =
	| ((...args: never[]) => void)
	| { fetch: (...args: never[]) => void };

function isEntrypoint(value: unknown): value is Entrypoint {
	return (
		typeof value === "function" ||
		(typeof value === "object" &&
			value !== null &&
			"fetch" in value &&
			typeof value.fetch === "function")
	);
}

describe("the Worker's entry module", () => {
	it("exports only functions and handler objects", () => {
		for (const [name, value] of Object.entries(entry)) {
			const ok = isEntrypoint(value);

			expect(ok, `${name} must be a function or a handler`).toBe(true);
		}
	});
});

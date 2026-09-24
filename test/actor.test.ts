import { describe, expect, it } from "vitest";
import { actor } from "../src/actor";

describe("actor", () => {
	it("records 'demo' in the demo (spec §5)", () => {
		expect(actor({ DEMO: "true" } as Env)).toBe("demo");
	});

	it("refuses to guess outside the demo until #22 adds the verified Access identity", () => {
		expect(() => actor({ DEMO: "false" } as unknown as Env)).toThrow(/#22/);
	});
});

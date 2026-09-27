import { describe, expect, it } from "vitest";
import css from "../public/assets/app.css?raw";

describe("production CSS", () => {
	it("includes the money field focus reset", () => {
		expect(css).toContain("focus-visible\\:outline-none");
	});
});

import { describe, expect, it } from "vitest";
import { sitePath } from "../src/address";

describe("sitePath (the path a keys sheet's link takes)", () => {
	it("keeps a path on this site, with its leading slashes collapsed to one", () => {
		expect(sitePath("/transactions")).toBe("/transactions");
		expect(sitePath("//evil.example/x")).toBe("/evil.example/x");
	});

	it("closes to / for a path a browser would read as another host: a backslash, a tab, LF or CR", () => {
		for (const path of [
			"/\\evil.example/x",
			"/\t/evil.example",
			"/\n/x",
			"/\r/x",
			"/a\\b",
		])
			expect(sitePath(path)).toBe("/");
	});
});

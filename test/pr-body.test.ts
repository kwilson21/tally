import { describe, expect, it } from "vitest";
import { PAGES, withScreenshots } from "../scripts/pr-body.mjs";
import { SIDEBAR_ITEMS } from "../src/views/nav";

const SECTION =
	"<!-- screenshots:start -->\n## Screenshots\nnew\n<!-- screenshots:end -->";

describe("withScreenshots", () => {
	it("appends the section to a description without one", () => {
		expect(withScreenshots("Closes #9.", SECTION)).toBe(
			`Closes #9.\n\n${SECTION}`,
		);
	});

	it("handles an empty description", () => {
		expect(withScreenshots(null, SECTION)).toBe(SECTION);
		expect(withScreenshots("", SECTION)).toBe(SECTION);
	});

	it("replaces only the marked section, keeping text before and after", () => {
		const body =
			"Intro\n\n<!-- screenshots:start -->\nold\n<!-- screenshots:end -->\n\nOutro";
		expect(withScreenshots(body, SECTION)).toBe(`Intro\n\n${SECTION}\n\nOutro`);
	});
});

describe("PAGES", () => {
	it("covers every navigation destination plus More", () => {
		const paths = PAGES.map((p) => p.path);
		for (const item of SIDEBAR_ITEMS) expect(paths).toContain(item.href);
		expect(paths).toContain("/more");
	});
});

import { describe, expect, it } from "vitest";
import {
	changedShots,
	comparisonProblem,
	PAGES,
	screenshotSection,
	withScreenshots,
} from "../scripts/pr-body.mjs";
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

describe("changedShots", () => {
	const png = (text: string) => new TextEncoder().encode(text);

	it("lists images that differ from the base or are new, and leaves out identical ones", () => {
		expect(
			changedShots([
				{ file: "home-phone.png", after: png("a"), before: png("a") },
				{ file: "settings-phone.png", after: png("b"), before: png("c") },
				{ file: "new-phone.png", after: png("d"), before: null },
			]),
		).toEqual([
			{ file: "settings-phone.png", hasBefore: true },
			{ file: "new-phone.png", hasBefore: false },
		]);
	});
});

describe("screenshotSection", () => {
	const base = {
		sha: "abc1234def",
		raw: "https://raw.example/pr-9/abc1234",
	};

	it("shows before and after for each changed image, first", () => {
		const section = screenshotSection({
			...base,
			changes: [{ file: "transaction-edit-phone.png", hasBefore: true }],
		});
		expect(section).toContain("## Before and after");
		expect(section).toContain(
			'<img src="https://raw.example/pr-9/abc1234/before/transaction-edit-phone.png"',
		);
		expect(section).toContain(
			'<img src="https://raw.example/pr-9/abc1234/transaction-edit-phone.png"',
		);
		expect(section).toContain("`/transactions/110?uncategorized=1` (phone)");
		expect(section.indexOf("## Before and after")).toBeLessThan(
			section.indexOf("## Screenshots"),
		);
	});

	it("marks a page that didn't exist before as new", () => {
		const section = screenshotSection({
			...base,
			changes: [{ file: "settings-desktop.png", hasBefore: false }],
		});
		expect(section).toMatch(/`\/settings` \(desktop\) \| New page \|/);
	});

	it("says so when nothing looks different from the base", () => {
		const section = screenshotSection({ ...base, changes: [] });
		expect(section).toContain("No page looks different from `main`.");
		expect(section).not.toContain("/before/");
	});

	it("keeps the full table of every page, and the markers withScreenshots looks for", () => {
		const section = screenshotSection({ ...base, changes: [] });
		expect(section.startsWith("<!-- screenshots:start -->")).toBe(true);
		expect(section.endsWith("<!-- screenshots:end -->")).toBe(true);
		for (const page of PAGES) expect(section).toContain(`\`${page.path}\``);
	});
});

describe("comparisonProblem", () => {
	const run = (started: string, finished = started) => ({ started, finished });

	it("allows a comparison when both runs finished on the same UTC day", () => {
		expect(comparisonProblem(run("2026-09-25"), run("2026-09-25"))).toBeNull();
	});

	it("says so when the base run never finished, instead of calling its pages new", () => {
		expect(comparisonProblem(run("2026-09-25"), null)).toMatch(
			/screenshots of `main` didn't finish/,
		);
	});

	it("says so when the runs straddle midnight UTC, since the demo data follows the date", () => {
		expect(
			comparisonProblem(run("2026-09-25", "2026-09-26"), run("2026-09-26")),
		).toMatch(/midnight UTC/);
		expect(comparisonProblem(run("2026-09-25"), run("2026-09-26"))).toMatch(
			/midnight UTC/,
		);
	});
});

describe("screenshotSection when there's nothing to compare", () => {
	it("gives the reason, shows no before-and-after rows, and keeps the full table", () => {
		const section = screenshotSection({
			sha: "abc1234",
			raw: "https://raw.example/x",
			changes: [],
			unavailable: "The screenshots of `main` didn't finish.",
		});
		expect(section).toContain(
			"No before-and-after this time: The screenshots of `main` didn't finish.",
		);
		expect(section).not.toContain("No page looks different");
		expect(section).toContain("## Screenshots");
	});
});

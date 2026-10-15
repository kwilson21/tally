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

	it("shows the demo's list straight from the bank (#197)", () => {
		expect(PAGES.map((p) => p.path)).toContain("/transactions?raw=1");
	});
});

describe("changedShots", () => {
	const shot = (file: string, text: string) => ({
		file,
		png: new TextEncoder().encode(text),
	});

	it("lists images that differ from the base or are new, and leaves out identical ones", () => {
		expect(
			changedShots({
				after: [
					shot("home-phone.png", "a"),
					shot("settings-phone.png", "b"),
					shot("new-phone.png", "d"),
				],
				before: [shot("home-phone.png", "a"), shot("settings-phone.png", "c")],
			}),
		).toEqual([
			{ before: ["settings-phone.png"], after: ["settings-phone.png"] },
			{ before: [], after: ["new-phone.png"] },
		]);
	});

	it("puts a page taken whole on main and in slices here in one row with both lists", () => {
		expect(
			changedShots({
				after: [shot("p-phone-01.png", "a"), shot("p-phone-02.png", "b")],
				before: [shot("p-phone.png", "a")],
			}),
		).toEqual([
			{
				before: ["p-phone.png"],
				after: ["p-phone-01.png", "p-phone-02.png"],
			},
		]);
	});

	it("puts a page sliced on main and taken whole here in one row with both lists", () => {
		expect(
			changedShots({
				after: [shot("p-phone.png", "a")],
				before: [shot("p-phone-01.png", "a"), shot("p-phone-02.png", "b")],
			}),
		).toEqual([
			{
				before: ["p-phone-01.png", "p-phone-02.png"],
				after: ["p-phone.png"],
			},
		]);
	});

	it("compares slices part by part when both sides are sliced the same way", () => {
		expect(
			changedShots({
				after: [shot("p-phone-01.png", "a"), shot("p-phone-02.png", "c")],
				before: [shot("p-phone-01.png", "a"), shot("p-phone-02.png", "b")],
			}),
		).toEqual([{ before: ["p-phone-02.png"], after: ["p-phone-02.png"] }]);
	});

	it("keeps every slice on both sides when the slice counts differ, both ways", () => {
		const two = [shot("p-phone-01.png", "a"), shot("p-phone-02.png", "b")];
		const three = [...two, shot("p-phone-03.png", "c")];
		expect(changedShots({ after: three, before: two })).toEqual([
			{
				before: ["p-phone-01.png", "p-phone-02.png"],
				after: ["p-phone-01.png", "p-phone-02.png", "p-phone-03.png"],
			},
		]);
		expect(changedShots({ after: two, before: three })).toEqual([
			{
				before: ["p-phone-01.png", "p-phone-02.png", "p-phone-03.png"],
				after: ["p-phone-01.png", "p-phone-02.png"],
			},
		]);
	});

	it("makes a new sliced page one row, its slices in part order whatever order they came in", () => {
		expect(
			changedShots({
				after: [shot("p-phone-02.png", "b"), shot("p-phone-01.png", "a")],
				before: [shot("home-phone.png", "x")],
			}),
		).toEqual([{ before: [], after: ["p-phone-01.png", "p-phone-02.png"] }]);
	});

	it("treats a file it can't read as a whole page of its own", () => {
		expect(
			changedShots({
				after: [shot("notes.png", "b")],
				before: [shot("notes.png", "a")],
			}),
		).toEqual([{ before: ["notes.png"], after: ["notes.png"] }]);
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
			changes: [
				{
					before: ["transaction-edit-phone.png"],
					after: ["transaction-edit-phone.png"],
				},
			],
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
			changes: [{ before: [], after: ["settings-desktop.png"] }],
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

describe("screenshotSection for a page taken in slices (#580)", () => {
	const base = { sha: "abc1234def", raw: "https://raw.example/pr-9/abc1234" };
	// Written in order by scripts/screenshots.mjs; listed out of order to check the sort.
	const files = [
		"design-system-proposals-phone-02.png",
		"design-system-proposals-phone-01.png",
		"design-system-proposals-desktop-01.png",
		"design-system-proposals-desktop-02.png",
		"settings-phone.png",
	];

	it("stacks every part of the page in order, at the same width as a whole page", () => {
		const section = screenshotSection({ ...base, changes: [], files });
		const first = section.indexOf(
			'<img src="https://raw.example/pr-9/abc1234/design-system-proposals-phone-01.png" width="180"',
		);
		const second = section.indexOf(
			'<img src="https://raw.example/pr-9/abc1234/design-system-proposals-phone-02.png" width="180"',
		);
		expect(first).toBeGreaterThan(-1);
		expect(second).toBeGreaterThan(first);
		expect(section).not.toContain("design-system-proposals-phone.png");
	});

	it("labels a changed part with its number and keeps the phone width", () => {
		const section = screenshotSection({
			...base,
			changes: [
				{
					before: ["design-system-proposals-phone-02.png"],
					after: ["design-system-proposals-phone-02.png"],
				},
			],
		});
		expect(section).toContain(
			'| `/design-system/proposals` (phone, part 2) | <img src="https://raw.example/pr-9/abc1234/before/design-system-proposals-phone-02.png" width="180"',
		);
	});
});

describe("screenshotSection when a page's capture changed shape (#580)", () => {
	const base = { sha: "abc1234def", raw: "https://raw.example/pr-9/abc1234" };
	const img = (path: string, alt: string) =>
		`<img src="https://raw.example/pr-9/abc1234/${path}" width="180" alt="${alt}">`;
	// Only the before-and-after part, so the full Screenshots table can't match these rows.
	const changedRows = (changes: { before: string[]; after: string[] }[]) => {
		const section = screenshotSection({ ...base, changes });
		return section.slice(0, section.indexOf("## Screenshots"));
	};

	it("puts a page whole on main and in two parts here in one row, with both parts after", () => {
		const section = changedRows([
			{
				before: ["design-system-proposals-phone.png"],
				after: [
					"design-system-proposals-phone-01.png",
					"design-system-proposals-phone-02.png",
				],
			},
		]);
		expect(section).toContain(
			`| \`/design-system/proposals\` (phone)<br>Taken differently: whole on \`main\`, in 2 parts in this PR. | ${img("before/design-system-proposals-phone.png", "design-system-proposals-phone.png, before")} | ${img("design-system-proposals-phone-01.png", "design-system-proposals-phone-01.png, after")}<br>${img("design-system-proposals-phone-02.png", "design-system-proposals-phone-02.png, after")} |`,
		);
		expect(section).not.toContain("New page");
		expect(section).not.toContain("part 1");
	});

	it("puts a page in two parts on main and whole here in one row, with both parts before", () => {
		const section = changedRows([
			{
				before: [
					"design-system-proposals-phone-01.png",
					"design-system-proposals-phone-02.png",
				],
				after: ["design-system-proposals-phone.png"],
			},
		]);
		expect(section).toContain(
			`| \`/design-system/proposals\` (phone)<br>Taken differently: in 2 parts on \`main\`, whole in this PR. | ${img("before/design-system-proposals-phone-01.png", "design-system-proposals-phone-01.png, before")}<br>${img("before/design-system-proposals-phone-02.png", "design-system-proposals-phone-02.png, before")} | ${img("design-system-proposals-phone.png", "design-system-proposals-phone.png, after")} |`,
		);
	});

	it("shows a new sliced page as one New page row with both parts after", () => {
		const section = changedRows([
			{
				before: [],
				after: [
					"design-system-proposals-phone-01.png",
					"design-system-proposals-phone-02.png",
				],
			},
		]);
		expect(section.split("New page")).toHaveLength(2);
		expect(section).toContain(
			`| \`/design-system/proposals\` (phone) | New page | ${img("design-system-proposals-phone-01.png", "design-system-proposals-phone-01.png, after")}<br>${img("design-system-proposals-phone-02.png", "design-system-proposals-phone-02.png, after")} |`,
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

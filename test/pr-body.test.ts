import { afterEach, describe, expect, it, vi } from "vitest";
import {
	changedShots,
	comparisonProblem,
	looksAlike,
	PAGES,
	pixelsAlike,
	screenshotSection,
	shownFiles,
	withScreenshots,
} from "../scripts/pr-body.mjs";
import { SIDEBAR_ITEMS } from "../src/views/nav";
import { ALPHA, FILTERED, fromBase64, PLAIN } from "./png-fixtures";

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

	it("lists images that differ from the base or are new, and leaves out identical ones", async () => {
		expect(
			await changedShots({
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

	it("puts a page taken whole on main and in slices here in one row with both lists", async () => {
		expect(
			await changedShots({
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

	it("puts a page sliced on main and taken whole here in one row with both lists", async () => {
		expect(
			await changedShots({
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

	it("compares slices part by part when both sides are sliced the same way", async () => {
		expect(
			await changedShots({
				after: [shot("p-phone-01.png", "a"), shot("p-phone-02.png", "c")],
				before: [shot("p-phone-01.png", "a"), shot("p-phone-02.png", "b")],
			}),
		).toEqual([{ before: ["p-phone-02.png"], after: ["p-phone-02.png"] }]);
	});

	it("keeps every slice on both sides when the slice counts differ, both ways", async () => {
		const two = [shot("p-phone-01.png", "a"), shot("p-phone-02.png", "b")];
		const three = [...two, shot("p-phone-03.png", "c")];
		expect(await changedShots({ after: three, before: two })).toEqual([
			{
				before: ["p-phone-01.png", "p-phone-02.png"],
				after: ["p-phone-01.png", "p-phone-02.png", "p-phone-03.png"],
			},
		]);
		expect(await changedShots({ after: two, before: three })).toEqual([
			{
				before: ["p-phone-01.png", "p-phone-02.png", "p-phone-03.png"],
				after: ["p-phone-01.png", "p-phone-02.png"],
			},
		]);
	});

	it("makes a new sliced page one row, its slices in part order whatever order they came in", async () => {
		expect(
			await changedShots({
				after: [shot("p-phone-02.png", "b"), shot("p-phone-01.png", "a")],
				before: [shot("home-phone.png", "x")],
			}),
		).toEqual([{ before: [], after: ["p-phone-01.png", "p-phone-02.png"] }]);
	});

	it("treats a file it can't read as a whole page of its own", async () => {
		expect(
			await changedShots({
				after: [shot("notes.png", "b")],
				before: [shot("notes.png", "a")],
			}),
		).toEqual([{ before: ["notes.png"], after: ["notes.png"] }]);
	});

	it("leaves out a page whose PNGs differ in bytes but not in pixels", async () => {
		expect(
			await changedShots({
				after: [{ file: "home-phone.png", png: fromBase64(FILTERED) }],
				before: [{ file: "home-phone.png", png: fromBase64(PLAIN) }],
			}),
		).toEqual([]);
	});

	it("keeps a page whose PNG changed size or kind", async () => {
		expect(
			await changedShots({
				after: [{ file: "home-phone.png", png: fromBase64(FILTERED) }],
				before: [{ file: "home-phone.png", png: fromBase64(ALPHA) }],
			}),
		).toEqual([{ before: ["home-phone.png"], after: ["home-phone.png"] }]);
	});
});

describe("shownFiles", () => {
	it("is empty when no page changed", () => {
		expect(shownFiles([])).toEqual({ after: [], before: [] });
	});

	it("keeps the after images of every row and the before images of the changed pages", () => {
		expect(
			shownFiles([
				{ before: ["settings-phone.png"], after: ["settings-phone.png"] },
				{ before: [], after: ["feedback-desktop.png"] },
			]),
		).toEqual({
			after: ["settings-phone.png", "feedback-desktop.png"],
			before: ["settings-phone.png"],
		});
	});

	it("keeps every part of a page taken differently, and its one before file", () => {
		expect(
			shownFiles([
				{
					before: ["design-system-proposals-phone.png"],
					after: [
						"design-system-proposals-phone-01.png",
						"design-system-proposals-phone-02.png",
					],
				},
			]),
		).toEqual({
			after: [
				"design-system-proposals-phone-01.png",
				"design-system-proposals-phone-02.png",
			],
			before: ["design-system-proposals-phone.png"],
		});
	});

	it("never lists a file twice, even when two rows give the same one", () => {
		expect(
			shownFiles([
				{ before: ["settings-phone.png"], after: ["settings-phone.png"] },
				{ before: ["settings-phone.png"], after: ["settings-phone.png"] },
			]),
		).toEqual({
			after: ["settings-phone.png"],
			before: ["settings-phone.png"],
		});
	});

	it("stores exactly the images the description links", () => {
		const raw = "https://raw.example/pr-9/abc1234";
		const changes = [
			{ before: ["settings-phone.png"], after: ["settings-phone.png"] },
			{ before: [], after: ["feedback-desktop.png"] },
			{
				before: ["design-system-proposals-phone.png"],
				after: [
					"design-system-proposals-phone-01.png",
					"design-system-proposals-phone-02.png",
				],
			},
		];
		const section = screenshotSection({
			sha: "abc1234def",
			raw,
			changes,
		});
		const linked = [...section.matchAll(/src="([^"]+)"/g)]
			.map((match) => match[1])
			.sort();
		const shown = shownFiles(changes);
		const stored = [
			...shown.after,
			...shown.before.map((file) => `before/${file}`),
		]
			.map((path) => `${raw}/${path}`)
			.sort();
		expect(linked).toEqual(stored);
	});
});

describe("pixelsAlike", () => {
	// An 11×10 picture (110 pixels, enough for the 100 and 101 cases), where channel `channel` of
	// pixel `pixel` is value(pixel, channel).
	const picture = (
		channels: number,
		value: (pixel: number, channel: number) => number,
		width = 11,
		height = 10,
	) => {
		const data = new Uint8Array(width * height * channels);
		for (let i = 0; i < data.length; i++)
			data[i] = value(Math.floor(i / channels), i % channels);
		return { width, height, channels, data };
	};

	it("says identical pictures are alike", () => {
		expect(
			pixelsAlike(
				picture(3, () => 50),
				picture(3, () => 50),
			),
		).toBe(true);
	});

	it("counts one channel of one pixel off by 49 as a change", () => {
		const b = picture(3, (pixel, channel) =>
			pixel === 0 && channel === 0 ? 99 : 50,
		);
		expect(
			pixelsAlike(
				picture(3, () => 50),
				b,
			),
		).toBe(false);
	});

	it("lets one channel of one pixel off by 48 pass", () => {
		const b = picture(3, (pixel, channel) =>
			pixel === 0 && channel === 0 ? 98 : 50,
		);
		expect(
			pixelsAlike(
				picture(3, () => 50),
				b,
			),
		).toBe(true);
	});

	it("lets 100 pixels off by 3 pass, counting each pixel once across its channels", () => {
		// All three channels of each pixel change, so counting bytes would reach 300.
		const b = picture(3, (pixel) => (pixel < 100 ? 53 : 50));
		expect(
			pixelsAlike(
				picture(3, () => 50),
				b,
			),
		).toBe(true);
	});

	it("counts 101 pixels off by 3 as a change, counting each pixel once", () => {
		// As above: counting bytes would reach 303.
		const b = picture(3, (pixel) => (pixel < 101 ? 53 : 50));
		expect(
			pixelsAlike(
				picture(3, () => 50),
				b,
			),
		).toBe(false);
	});

	it("lets every pixel off by 2 pass", () => {
		expect(
			pixelsAlike(
				picture(3, () => 50),
				picture(3, () => 52),
			),
		).toBe(true);
	});

	it("counts a different width, height or channel count as a change", () => {
		const a = picture(3, () => 50);
		expect(
			pixelsAlike(
				a,
				picture(3, () => 50, 12, 10),
			),
		).toBe(false);
		expect(
			pixelsAlike(
				a,
				picture(3, () => 50, 11, 11),
			),
		).toBe(false);
		expect(
			pixelsAlike(
				a,
				picture(4, () => 50),
			),
		).toBe(false);
	});

	it("counts only the alpha channel of one pixel off by 49 as a change", () => {
		const b = picture(4, (pixel, channel) =>
			pixel === 0 && channel === 3 ? 99 : 50,
		);
		expect(
			pixelsAlike(
				picture(4, () => 50),
				b,
			),
		).toBe(false);
	});
});

describe("looksAlike", () => {
	const text = (s: string) => new TextEncoder().encode(s);

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("says equal bytes look alike", async () => {
		expect(await looksAlike(text("same"), text("same"))).toBe(true);
	});

	it("says PNGs that differ only in how they are filtered look alike", async () => {
		expect(await looksAlike(fromBase64(FILTERED), fromBase64(PLAIN))).toBe(
			true,
		);
	});

	it("says PNGs of a different size or kind don't", async () => {
		expect(await looksAlike(fromBase64(FILTERED), fromBase64(ALPHA))).toBe(
			false,
		);
	});

	it("says different bytes that aren't PNGs don't, without a warning", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(await looksAlike(text("a"), text("b"))).toBe(false);
		expect(warn).not.toHaveBeenCalled();
	});

	it("warns with the reason, then says they don't look alike, when a PNG can't be read", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const broken = fromBase64(FILTERED).subarray(0, 50);
		expect(await looksAlike(broken, fromBase64(PLAIN))).toBe(false);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("Truncated PNG chunk."),
		);
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
		expect(section).not.toContain("## Screenshots");
		expect(section.split("<img").length - 1).toBe(2);
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
		expect(section).not.toContain("<img");
		expect(section).not.toContain("## Screenshots");
	});

	it("keeps the markers withScreenshots looks for, and no table of every page", () => {
		const section = screenshotSection({ ...base, changes: [] });
		expect(section.startsWith("<!-- screenshots:start -->")).toBe(true);
		expect(section.endsWith("<!-- screenshots:end -->")).toBe(true);
		expect(section).not.toContain("`/settings/people`");
		expect(section).not.toContain("## Screenshots");
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
	const changedRows = (changes: { before: string[]; after: string[] }[]) =>
		screenshotSection({ ...base, changes });

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
	it("gives the reason, and shows no images", () => {
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
		expect(section).not.toContain("<img");
		expect(section).not.toContain("## Screenshots");
	});
});

describe("PAGES and Apple Card (#766)", () => {
	it("shoots the Accounts upload sheet, which the demo shows with its sample", () => {
		expect(PAGES.map((p) => p.path)).toContain("/accounts/apple-card");
	});
});

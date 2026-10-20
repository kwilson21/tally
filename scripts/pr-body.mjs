// What CI screenshots, and how the images go into a PR description. Pure; used by the scripts next to it.

/** Every page in the app. test/pr-body.test.ts fails if a nav destination is missing. */
export const PAGES = [
	{ name: "home", path: "/" },
	// Groceries' budget sheet over Home (#66), with the nudges and the last-month chip.
	{ name: "budget-edit", path: "/budget/1" },
	// Home in Adjust mode (#94): − and + on every budgeted row.
	{ name: "home-adjust", path: "/?adjust=1" },
	{ name: "transactions", path: "/transactions" },
	// The demo's list as the bank sends it (#197, P44 A): bank text, no categories, no marks.
	{ name: "transactions-raw", path: "/transactions?raw=1" },
	{ name: "transactions-add-cash", path: "/transactions/cash/new" },
	{ name: "transactions-organize", path: "/transactions/organize" },
	{
		name: "transactions-needs-category",
		path: "/transactions?uncategorized=1",
	},
	// 110 is Local Bakery after a reset; test/seed.test.ts keeps that true.
	{ name: "transaction-edit", path: "/transactions/110?uncategorized=1" },
	// 116 is a Craft Supply charge whose merchant has two names Tally guessed, so the sheet offers them (P29 A, P87 B);
	// test/seed.test.ts keeps that true.
	{ name: "transaction-edit-names", path: "/transactions/116?uncategorized=1" },
	// 118 is a CVS charge whose merchant has the bank's own name suggested, so the sheet says "From your bank" (P87 B);
	// test/seed.test.ts keeps that true.
	{
		name: "transaction-edit-names-bank",
		path: "/transactions/118?uncategorized=1",
	},
	// 94 is a Trader Joe's that Jev categorized, so the sheet shows "Picked by Jev"; test/seed.test.ts keeps that true.
	{ name: "transaction-edit-jev", path: "/transactions/94" },
	{ name: "bills", path: "/bills" },
	{ name: "trends", path: "/trends" },
	{ name: "accounts", path: "/accounts" },
	{ name: "documents", path: "/documents" },
	{ name: "settings", path: "/settings" },
	{ name: "settings-categories", path: "/settings/categories" },
	{ name: "settings-rules", path: "/settings/rules" },
	{ name: "settings-household", path: "/settings/household" },
	{ name: "settings-people", path: "/settings/people" },
	{ name: "settings-ai", path: "/settings/ai" },
	{ name: "settings-data", path: "/settings/data" },
	// Gas's row open for editing, as in the round 5 study.
	{ name: "settings-edit", path: "/settings/categories?open=3" },
	// The one review screen for every "Maybe …" (issue #195) that Settings' Band leads to; /settings/names redirects here.
	{ name: "settings-suggestions", path: "/settings/suggestions" },
	{ name: "more", path: "/more" },
	{ name: "how-it-works", path: "/how-it-works" },
	{ name: "feedback", path: "/feedback" },
	// The design system catalog (#76) and the pages it links to; every catalog page goes here.
	{ name: "design-system", path: "/design-system" },
	{ name: "design-system-bottom-sheet", path: "/design-system/bottom-sheet" },
	{ name: "design-system-ledger-sheet", path: "/design-system/ledger-sheet" },
	{ name: "design-system-proposals", path: "/design-system/proposals" },
];

export const VIEWPORTS = [
	{ name: "desktop", width: 1280, height: 800 },
	{ name: "phone", width: 390, height: 844 },
];

/**
 * The file names of one page at one size: `page-viewport.png` when it was taken whole, or
 * `page-viewport-01.png`, `-02`, ... when it was taken in slices (#580).
 * @param {string} page
 * @param {string} viewport
 * @param {number} count
 * @returns {string[]}
 */
export function shotNames(page, viewport, count) {
	if (count === 1) return [`${page}-${viewport}.png`];
	return Array.from(
		{ length: count },
		(_, i) => `${page}-${viewport}-${String(i + 1).padStart(2, "0")}.png`,
	);
}

// A file from shotNames: the page, the viewport, and the slice number when there are several.
const SHOT = new RegExp(
	`^(.+)-(${VIEWPORTS.map((v) => v.name).join("|")})(?:-(\\d+))?\\.png$`,
);

/**
 * What a screenshot file shows: null for a file that isn't one.
 * @param {string} file
 * @returns {{ page: string, viewport: string, part: number | null } | null}
 */
function parseShot(file) {
	const match = SHOT.exec(file);
	if (!match) return null;
	return {
		page: match[1],
		viewport: match[2],
		part: match[3] === undefined ? null : Number(match[3]),
	};
}

const START = "<!-- screenshots:start -->";
const END = "<!-- screenshots:end -->";

/**
 * Puts the screenshot section into a PR description, replacing an earlier one if present.
 * @param {string | null} body
 * @param {string} section
 * @returns {string}
 */
export function withScreenshots(body, section) {
	const text = body ?? "";
	const start = text.indexOf(START);
	const end = text.indexOf(END);
	if (start !== -1 && end > start) {
		return text.slice(0, start) + section + text.slice(end + END.length);
	}
	return text ? `${text}\n\n${section}` : section;
}

/**
 * Groups screenshots by page and size, each group's files in part order. A file that parseShot
 * can't read is a group of its own, taken whole. The map's keys are in the order they first appear.
 * @param {{ file: string, png: Uint8Array }[]} shots
 * @returns {Map<string, { file: string, png: Uint8Array, part: number }[]>}
 */
function groupShots(shots) {
	const groups = new Map();
	for (const { file, png } of shots) {
		const shot = parseShot(file);
		const key = shot ? `${shot.page} ${shot.viewport}` : file;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push({ file, png, part: shot?.part ?? 0 });
	}
	for (const parts of groups.values()) parts.sort((a, b) => a.part - b.part);
	return groups;
}

/**
 * The screenshots that differ from the base branch's, as rows for the before-and-after table.
 * A page with no files on the `before` side is one row with `before: []`, however many slices it
 * has. Otherwise, when both sides have the same files (a whole page on both, or the same slices),
 * each part whose bytes differ is its own row. Any other pairing (whole on one side and in slices
 * on the other, or a different number of slices) is one row with every file of both sides, counted
 * as changed without comparing bytes: the parts wouldn't line up, and no slice is dropped. Pages
 * only `before` has are left out. Rows come in the order their pages first appear in `after`.
 * @param {{ after: { file: string, png: Uint8Array }[], before: { file: string, png: Uint8Array }[] }} shots
 * @returns {{ before: string[], after: string[] }[]}
 */
export function changedShots({ after, before }) {
	const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
	const beforeGroups = groupShots(before);
	const rows = [];
	for (const [key, parts] of groupShots(after)) {
		const afterFiles = parts.map((part) => part.file);
		const old = beforeGroups.get(key);
		if (!old) {
			rows.push({ before: [], after: afterFiles });
			continue;
		}
		const beforeFiles = old.map((part) => part.file);
		const sameFiles =
			beforeFiles.length === afterFiles.length &&
			beforeFiles.every((file, i) => file === afterFiles[i]);
		if (!sameFiles) {
			rows.push({ before: beforeFiles, after: afterFiles });
			continue;
		}
		for (const [i, part] of parts.entries())
			if (!same(part.png, old[i].png))
				rows.push({ before: [old[i].file], after: [part.file] });
	}
	return rows;
}

/**
 * Why this PR's screenshots can't be compared with the base branch's, or null when they can.
 * Each run records the UTC dates it started and finished on; the base's record is missing if its
 * run died. The demo data follows the date, so runs on different days would differ everywhere.
 * @param {{ started: string, finished: string }} after
 * @param {{ started: string, finished: string } | null} before
 * @returns {string | null}
 */
export function comparisonProblem(after, before) {
	if (before === null) return "The screenshots of `main` didn't finish.";
	const days = new Set([
		after.started,
		after.finished,
		before.started,
		before.finished,
	]);
	return days.size > 1
		? "The two sets of screenshots were taken either side of midnight UTC, so the demo data differs. Re-run the Screenshots job to compare."
		: null;
}

/**
 * The PR description's screenshot section: the before-and-after table, one row per changed page
 * (a new page is a "New page" row). `raw` is the URL of this run's folder; "before" images sit in
 * `before/`. `unavailable` is why there's no comparison this time (see comparisonProblem).
 * @param {{ sha: string, raw: string, changes: { before: string[], after: string[] }[], unavailable?: string | null }} options
 * @returns {string}
 */
export function screenshotSection({ sha, raw, changes, unavailable = null }) {
	const [desktop, phone] = VIEWPORTS;
	const img = (path, alt, width) =>
		`<img src="${raw}/${path}" width="${width}" alt="${alt}">`;
	// A page and its size, such as `/settings` (phone). The part number follows only when asked for.
	const label = (file, withPart = false) => {
		const shot = parseShot(file);
		const page = PAGES.find((p) => p.name === shot?.page);
		if (!shot || !page) return file;
		const part = withPart && shot.part !== null ? `, part ${shot.part}` : "";
		return `\`${page.path}\` (${shot.viewport}${part})`;
	};
	const width = (file) =>
		parseShot(file)?.viewport === phone.name ? 180 : 480;
	const beforeCell = (files) =>
		files.length === 0
			? "New page"
			: files
					.map((file) => img(`before/${file}`, `${file}, before`, width(file)))
					.join("<br>");
	const afterCell = (files) =>
		files.map((file) => img(file, `${file}, after`, width(file))).join("<br>");
	const count = (n) => (n === 1 ? "whole" : `in ${n} parts`);
	// One row of the before-and-after table. A page whose two sides are one same-named file is a
	// single part (or a whole page), labelled with its part number. A page taken another way on
	// `main` is labelled with what changed, and a new page with neither.
	const changedRow = ({ before, after }) => {
		const onePart =
			before.length === 1 && after.length === 1 && before[0] === after[0];
		const note =
			before.length > 0 && !onePart
				? `<br>Taken differently: ${count(before.length)} on \`main\`, ${count(after.length)} in this PR.`
				: "";
		return `| ${label(after[0], onePart)}${note} | ${beforeCell(before)} | ${afterCell(after)} |`;
	};
	const beforeAfter = unavailable
		? [`No before-and-after this time: ${unavailable}`]
		: changes.length === 0
			? ["No page looks different from `main`."]
			: [
					"| Page | Before (`main`) | After (this PR) |",
					"|---|---|---|",
					...changes.map(changedRow),
				];

	return [
		START,
		"## Before and after",
		`_Only the pages this PR adds or changes, taken by CI at ${sha.slice(0, 7)} on the seeded demo data. Desktop ${desktop.width}×${desktop.height}, phone ${phone.width}×${phone.height}._`,
		"",
		...beforeAfter,
		END,
	].join("\n");
}

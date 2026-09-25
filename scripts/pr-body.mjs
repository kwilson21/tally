// What CI screenshots, and how the images go into a PR description. Pure; used by the scripts next to it.

/** Every page in the app. test/pr-body.test.ts fails if a nav destination is missing. */
export const PAGES = [
	{ name: "home", path: "/" },
	{ name: "transactions", path: "/transactions" },
	{
		name: "transactions-needs-category",
		path: "/transactions?uncategorized=1",
	},
	// 110 is Local Bakery after a reset; test/seed.test.ts keeps that true.
	{ name: "transaction-edit", path: "/transactions/110?uncategorized=1" },
	// 94 is a Trader Joe's that Jev categorized, so the sheet shows "Picked by Jev"; test/seed.test.ts keeps that true.
	{ name: "transaction-edit-jev", path: "/transactions/94" },
	{ name: "bills", path: "/bills" },
	{ name: "trends", path: "/trends" },
	{ name: "accounts", path: "/accounts" },
	{ name: "documents", path: "/documents" },
	{ name: "settings", path: "/settings" },
	{ name: "more", path: "/more" },
	{ name: "how-it-works", path: "/how-it-works" },
];

export const VIEWPORTS = [
	{ name: "desktop", width: 1280, height: 800 },
	{ name: "phone", width: 390, height: 844 },
];

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
 * The screenshots CI took that differ from the base branch's, or that the base doesn't have.
 * Identical images (byte for byte, same browser and seed) are left out.
 * @param {{ file: string, after: Uint8Array, before: Uint8Array | null }[]} shots
 * @returns {{ file: string, hasBefore: boolean }[]}
 */
export function changedShots(shots) {
	const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
	return shots
		.filter(({ after, before }) => before === null || !same(after, before))
		.map(({ file, before }) => ({ file, hasBefore: before !== null }));
}

/**
 * The PR description's screenshot section: before and after for every changed image, then every
 * page at both sizes. `raw` is the URL of this run's folder; "before" images sit in `before/`.
 * @param {{ sha: string, raw: string, changes: { file: string, hasBefore: boolean }[] }} options
 * @returns {string}
 */
export function screenshotSection({ sha, raw, changes }) {
	const [desktop, phone] = VIEWPORTS;
	const img = (path, alt, width) =>
		`<img src="${raw}/${path}" width="${width}" alt="${alt}">`;
	const label = (file) => {
		for (const page of PAGES)
			for (const viewport of VIEWPORTS)
				if (file === `${page.name}-${viewport.name}.png`)
					return `\`${page.path}\` (${viewport.name})`;
		return file;
	};
	const width = (file) => (file.endsWith(`-${phone.name}.png`) ? 180 : 480);

	const beforeAfter =
		changes.length === 0
			? ["No page looks different from `main`."]
			: [
					"| Page | Before (`main`) | After (this PR) |",
					"|---|---|---|",
					...changes.map(
						({ file, hasBefore }) =>
							`| ${label(file)} | ${hasBefore ? img(`before/${file}`, `${file}, before`, width(file)) : "New page"} | ${img(file, `${file}, after`, width(file))} |`,
					),
				];

	return [
		START,
		"## Before and after",
		`_Every screenshot that differs from \`main\`'s, taken by CI at ${sha.slice(0, 7)} on the seeded demo data._`,
		"",
		...beforeAfter,
		"",
		"## Screenshots",
		`_Every page. Desktop ${desktop.width}×${desktop.height}, phone ${phone.width}×${phone.height}._`,
		"",
		"| Page | Desktop | Phone |",
		"|---|---|---|",
		...PAGES.map(
			(p) =>
				`| \`${p.path}\` | ${img(`${p.name}-${desktop.name}.png`, `${p.name}, ${desktop.name}`, 480)} | ${img(`${p.name}-${phone.name}.png`, `${p.name}, ${phone.name}`, 180)} |`,
		),
		END,
	].join("\n");
}

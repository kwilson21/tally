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

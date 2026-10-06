import { describe, expect, it } from "vitest";
import { COLOR_TOKENS } from "../src/design-system/tokens";
import css from "../src/styles/app.css?raw";

// Every file that writes class names: the views and routes, and the scripts that build elements.
const SOURCES = import.meta.glob(
	["../src/**/*.{ts,tsx}", "../public/js/*.js"],
	{ query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/** The source without comments, so prose like "rounded down" isn't read as a class. */
const stripComments = (text: string) =>
	// A comment starts a line or follows a space or "{"; "/design-system/*" in a string isn't one.
	text
		.replace(/(^|[\s{])\/\*[\s\S]*?\*\/\}?/gm, "$1")
		.replace(/(^|\s)\/\/.*$/gm, "$1");

/** Each class-like word with its variants removed: "has-[:checked]:bg-band" → "bg-band". */
function utilities(text: string): string[] {
	return stripComments(text)
		.split(/[\s"'`{}()<>,;]+/)
		.map((word) => {
			let depth = 0;
			let start = 0;
			for (let i = 0; i < word.length; i++) {
				if (word[i] === "[") depth++;
				else if (word[i] === "]") depth--;
				else if (word[i] === ":" && depth === 0) start = i + 1;
			}
			return word.slice(start).replace(/^!/, "");
		})
		.filter(Boolean);
}

const PALETTE =
	"white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const COLOR_UTILITY = new RegExp(
	`^(bg|text|border(-[trblxyse])?|fill|stroke|ring|outline|divide|decoration|placeholder|caret|accent|from|via|to)-((${PALETTE})(-\\d+)?(/\\d+)?|\\[(#|rgb|hsl|oklch|color|var).*|\\[[a-z]+\\](/\\d+)?)$`,
);
const RADIUS = /^-?rounded(-(t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?(-(.+))?$/;
const TOKEN_RADII = new Set(["control", "sheet", "full", "none"]);

/**
 * Off-token classes that are allowed, each with its reason. Toasts are the one shadow (DESIGN.md).
 * The money input keeps the original app's corners until the owner reviews it in the catalog
 * (the next #76 PR).
 */
const EXCEPTIONS: Record<string, string[]> = {
	"../public/js/toast.js": ["shadow-sm"],
	"../src/views/money-input.tsx": [
		"rounded-lg",
		"rounded-tr-lg",
		"rounded-br-lg",
	],
};

function problems(file: string, text: string): string[] {
	const allowed = EXCEPTIONS[file] ?? [];
	const found: string[] = [];
	for (const u of utilities(text)) {
		if (allowed.includes(u)) continue;
		if (COLOR_UTILITY.test(u)) found.push(`${u}: colors come from tokens`);
		const radius = u.match(RADIUS);
		// "rounded" alone must also be a class here, not part of a word like "roundedUp".
		if (radius && !TOKEN_RADII.has(radius[4] ?? ""))
			found.push(`${u}: radii are rounded-control, -sheet or -full`);
		if (/^(drop-|inset-)?shadow(-|$)/.test(u))
			found.push(`${u}: no shadows except toasts`);
	}
	return found;
}

describe("design tokens (DESIGN.md)", () => {
	it("reads the views, routes and scripts", () => {
		expect(Object.keys(SOURCES)).toContain("../src/views/money-input.tsx");
		expect(Object.keys(SOURCES)).toContain("../public/js/toast.js");
	});

	it("uses only token colors, token radii, and no shadows except toasts", () => {
		const all = Object.entries(SOURCES).flatMap(([file, text]) =>
			problems(file, text).map((p) => `${file}: ${p}`),
		);
		expect(all).toEqual([]);
	});

	it("names no color that isn't a token: text-error, text-alert and from-danger draw nothing (errors are text-over)", () => {
		const tokens = new Set(
			[...css.matchAll(/--color-([\w-]+):/g)].map(([, name]) => name),
		);
		/**
		 * Words after a color prefix that aren't colors: sizes, alignment, wrapping, sides, line
		 * styles, the transparent and current keywords, and CSS property or SVG attribute names
		 * that share a prefix ("stroke-linecap", "border-color") but are never classes.
		 */
		const NOT_COLORS = new Set(
			"transparent current inherit none xs sm base lg xl left center right justify start end wrap nowrap balance pretty ellipsis clip t r b l x y s e solid dashed dotted double wavy hidden collapse separate offset inset align color style width radius input linecap linejoin".split(
				" ",
			),
		);
		const NAMED =
			/^(bg|text|border(-[trblxyse])?|fill|stroke|ring|outline|divide|decoration|placeholder|caret|accent|from|via|to)-([a-z][a-z-]*?)(\/\d+)?$/;
		const offToken = (u: string) => {
			const name = u.match(NAMED)?.[3];
			return name !== undefined && !tokens.has(name) && !NOT_COLORS.has(name);
		};
		expect(
			["text-error", "border-negative", "text-alert", "from-danger"].every(
				offToken,
			),
		).toBe(true);
		expect(
			[
				"text-over",
				"border-over",
				"text-sm",
				"bg-ink/30",
				"text-cat-blue",
			].some(offToken),
		).toBe(false);
		const found = Object.entries(SOURCES).flatMap(([file, text]) =>
			utilities(text)
				.filter(offToken)
				.map((u) => `${file}: ${u}`),
		);
		expect(found).toEqual([]);
	});

	it("catches off-token classes, and leaves words alone", () => {
		expect(
			problems(
				"x.tsx",
				'<p class="bg-white text-stone-700 border-[#ccc] text-[red] bg-[var(--x)] bg-[#ffffff]/30 text-[red]/50 rounded-lg shadow-md drop-shadow-sm hover:rounded-xl">',
			),
		).toHaveLength(11);
		expect(
			problems(
				"x.tsx",
				'// rounded down\nconst a = roundedUp(x);\n<p class="rounded-control lg:rounded-l-sheet has-[:checked]:bg-band bg-ink/30 text-cat-blue text-[1.75rem]">',
			),
		).toEqual([]);
	});

	it("doesn't read a /* inside a string as the start of a comment", () => {
		expect(
			problems(
				"x.tsx",
				'app.use("/design-system/*", f);\n<p class="bg-white">{/* a note */}</p>',
			),
		).toHaveLength(1);
	});

	it("lists every color token in the catalog, with app.css's value", () => {
		const theme = [...css.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6})/gi)].map(
			([, name, hex]) => [name, (hex ?? "").toLowerCase()],
		);
		expect(theme.length).toBeGreaterThan(10);
		expect(COLOR_TOKENS.map((t) => [t.name, t.hex.toLowerCase()])).toEqual(
			theme,
		);
	});
});

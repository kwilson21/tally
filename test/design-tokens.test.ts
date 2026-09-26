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
	text.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

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
	`^(bg|text|border(-[trblxyse])?|fill|stroke|ring|outline|divide|decoration|placeholder|caret|accent|from|via|to)-((${PALETTE})(-\\d+)?(/\\d+)?|\\[(#|rgb|hsl|oklch|color).*)$`,
);
const RADIUS = /^-?rounded(-(t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?(-(.+))?$/;
const TOKEN_RADII = new Set(["control", "sheet", "full", "none"]);

/**
 * Off-token classes that are allowed for now, each with its reason. The money input keeps the
 * original app's corners until the owner reviews it in the catalog (the next #76 PR).
 */
const EXCEPTIONS: Record<string, string[]> = {
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
		if (/^shadow(-|$)/.test(u) && file !== "../public/js/toast.js")
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

	it("catches off-token classes, and leaves words alone", () => {
		expect(
			problems(
				"x.tsx",
				'<p class="bg-white text-stone-700 border-[#ccc] rounded-lg shadow-md hover:rounded-xl">',
			),
		).toHaveLength(6);
		expect(
			problems(
				"x.tsx",
				'// rounded down\nconst a = roundedUp(x);\n<p class="rounded-control lg:rounded-l-sheet has-[:checked]:bg-band bg-ink/30 text-cat-blue">',
			),
		).toEqual([]);
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

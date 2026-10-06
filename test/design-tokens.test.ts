import { describe, expect, it } from "vitest";
import { COLOR_TOKENS, DURATION_TOKENS } from "../src/design-system/tokens";
import css from "../src/styles/app.css?raw";
import { Chip } from "../src/views/chip";

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

/** Each class-like word in the source, as written: "has-[:checked]:bg-band". */
const words = (text: string) =>
	stripComments(text)
		.split(/[\s"'`{}()<>,;]+/)
		.filter(Boolean);

/** A word with its variants removed: "has-[:checked]:bg-band" → "bg-band". */
function strip(word: string): string {
	let depth = 0;
	let start = 0;
	for (let i = 0; i < word.length; i++) {
		if (word[i] === "[") depth++;
		else if (word[i] === "]") depth--;
		else if (word[i] === ":" && depth === 0) start = i + 1;
	}
	return word.slice(start).replace(/^!/, "");
}

/** Each class-like word with its variants removed. */
const utilities = (text: string) => words(text).map(strip).filter(Boolean);

const PALETTE =
	"white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const COLOR_UTILITY = new RegExp(
	`^(bg|text|border(-[trblxyse])?|fill|stroke|ring|outline|divide|decoration|placeholder|caret|accent|from|via|to)-((${PALETTE})(-\\d+)?(/\\d+)?|\\[(#|rgb|hsl|oklch|color|var).*|\\[[a-z]+\\](/\\d+)?)$`,
);
const RADIUS = /^-?rounded(-(t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?(-(.+))?$/;
const TOKEN_RADII = new Set(["control", "sheet", "full", "none"]);

/**
 * Off-token classes that are allowed, each with its reason. Toasts are the one shadow (DESIGN.md).
 * P115 B draws the 8px corners the owner turned down (decision 85), with three overrides on the money
 * box in its drawing; only those exact classes are allowed.
 */
const EXCEPTIONS: Record<string, string[]> = {
	"../public/js/toast.js": ["shadow-sm"],
	"../src/design-system/proposals-polish.tsx": [
		"[&_[data-money]_.rounded-control]:rounded-lg",
		"[&_[data-money]_.rounded-tr-control]:rounded-tr-lg",
		"[&_[data-money]_.rounded-br-control]:rounded-br-lg",
	],
};

/**
 * Files that may name corner-shape, each with its reason. The one place that turns it on for the app is
 * the squircle rule in app.css (decision 76); a file here draws corners itself, on a picture.
 */
const CORNER_SHAPE_EXCEPTIONS: Record<string, string> = {
	"../src/design-system/proposals-corners.tsx":
		"P75 draws round corners, squircles and a mix side by side, so it sets corner-shape on its own pictures",
};

/**
 * Any spelling of the property: corner-shape or a per-corner longhand like corner-top-left-shape, in
 * any case (CSS property names ignore it), or a script name like cornerShape or cornerTopLeftShape.
 */
const CORNER_SHAPE =
	/\bcorner-(?:[a-z]+-)*shape\b|\bcorner(?:[A-Z][a-z]+)*Shape\b/i;

/** The files outside the list above that name corner-shape, with the word they use. */
function cornerShapeProblems(file: string, text: string): string[] {
	if (file in CORNER_SHAPE_EXCEPTIONS) return [];
	const found = stripComments(text).match(CORNER_SHAPE)?.[0];
	return found ? [`${found}: only the squircle rule in app.css sets it`] : [];
}

/** CSS without its comments, so a note about corner-shape isn't read as the property. */
const stripCssComments = (text: string) =>
	text.replace(/\/\*[\s\S]*?\*\//g, "");

type CssRule = { selector: string; body: string; within: string[] };

/** Each rule that holds declarations (not other rules), with the at-rules around it: "@supports (…)". */
function cssRules(text: string): CssRule[] {
	const rules: CssRule[] = [];
	const open: { header: string; start: number; leaf: boolean }[] = [];
	let boundary = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "{") {
			const parent = open[open.length - 1];
			if (parent) parent.leaf = false;
			open.push({
				header: text.slice(boundary, i).replace(/\s+/g, " ").trim(),
				start: i + 1,
				leaf: true,
			});
			boundary = i + 1;
		} else if (c === "}") {
			const block = open.pop();
			if (block?.leaf)
				rules.push({
					selector: block.header,
					body: text.slice(block.start, i).replace(/\s+/g, " ").trim(),
					within: open.map((o) => o.header),
				});
			boundary = i + 1;
		} else if (c === ";") boundary = i + 1;
	}
	return rules;
}

/** The rules in app.css that set corner-shape. */
const cornerRules = cssRules(stripCssComments(css)).filter((r) =>
	CORNER_SHAPE.test(r.body),
);

/**
 * The squircle rule's selectors, read as the two forms it may use: a class (".rounded-t-sheet") and a
 * class attribute that contains a variant's class (`[class*=":rounded-t-sheet"]`, which is how Tailwind
 * writes "lg:rounded-t-sheet": its own class name). Anything else is returned as unreadable.
 */
function squircleSelectors(rule: CssRule | undefined) {
	const classes: string[] = [];
	const variants: string[] = [];
	const unreadable: string[] = [];
	for (const selector of (rule?.selector ?? "")
		.split(",")
		.map((x) => x.trim())) {
		const asClass = selector.match(/^\.([a-z-]+)$/);
		const asVariant = selector.match(/^\[class\*="(:[a-z-]+)"\]$/);
		if (asClass?.[1]) classes.push(asClass[1]);
		else if (asVariant?.[1]) variants.push(asVariant[1]);
		else unreadable.push(selector);
	}
	return { classes, variants, unreadable };
}

/**
 * Whether the rule's selector matches an element with this class attribute: a class selector needs the
 * word as one of the classes, `[class*="x"]` needs "x" anywhere in the attribute (CSS's own meanings).
 */
function reaches(classAttr: string): boolean {
	const { classes, variants } = squircleSelectors(cornerRules[0]);
	return (
		classes.some((c) => classAttr.split(/\s+/).includes(c)) ||
		variants.some((v) => classAttr.includes(v))
	);
}

/** The sides Tailwind writes a radius for: all four corners, a side, a logical side and one corner. */
const SIDES = [
	"",
	"-s",
	"-e",
	"-t",
	"-r",
	"-b",
	"-l",
	"-ss",
	"-se",
	"-ee",
	"-es",
	"-tl",
	"-tr",
	"-br",
	"-bl",
];
const TOKEN_NAMES = ["control", "sheet"];
/**
 * Variants as Tailwind writes them in front of a class, from none to a stack and arbitrary ones. Only
 * variants that keep the radius on the element carrying the class: the selector sets corner-shape on
 * that element, so a variant that rounds a descendant or a pseudo-element is not here (see
 * movesRadiusElsewhere below).
 */
const VARIANTS = [
	"",
	"lg:",
	"hover:",
	"has-[:checked]:",
	"sm:max-lg:",
	"group-has-[:checked]:",
];

/**
 * The variants that put a class's radius on something other than the element carrying it: its children
 * (`*:`, `**:`), one of its pseudo-elements, or whatever an arbitrary variant picks with `&`
 * (`[&_p]:`). corner-shape isn't inherited, so the rule sets it on the element with the class and the
 * child or pseudo-element that gets the radius would stay round.
 */
const PSEUDO_ELEMENT_VARIANTS = new Set([
	"before",
	"after",
	"first-letter",
	"first-line",
	"marker",
	"selection",
	"file",
	"placeholder",
	"backdrop",
	"details-content",
]);

/** A word's variants, split at the colons outside brackets: "lg:has-[:checked]:bg-band" → ["lg", "has-[:checked]"]. */
function variantsOf(word: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < word.length; i++) {
		if (word[i] === "[") depth++;
		else if (word[i] === "]") depth--;
		else if (word[i] === ":" && depth === 0) {
			parts.push(word.slice(start, i));
			start = i + 1;
		}
	}
	return parts;
}

/** The variants in front of this word that move its radius off the element carrying the class. */
function movesRadiusElsewhere(word: string): string[] {
	return variantsOf(word).filter(
		(v) =>
			v === "*" ||
			v === "**" ||
			PSEUDO_ELEMENT_VARIANTS.has(v) ||
			v.includes("&"),
	);
}

/** A radius on one of the two tokens, in any side and with no variants: "rounded-tr-control". */
const TOKEN_RADIUS = /^!?rounded(-[a-z]{1,2})?-(control|sheet)!?$/;

/**
 * Each class with a token radius at its end, variants and all, read from words split only at whitespace
 * and quotes: words() also splits at ">", so "[&>*]:rounded-control" would reach it as "*]:rounded-control"
 * and lose its variant.
 */
const usedTokenClasses = (text: string): string[] =>
	stripComments(text)
		.split(/[\s"'`]+/)
		.filter((word) =>
			/(^|:)!?rounded(-[a-z]{1,2})?-(control|sheet)!?$/.test(word),
		);

/**
 * The quoted strings in the source (a class attribute, a template literal) that hold a pill and a
 * token radius with a variant on either: "rounded-full lg:rounded-l-sheet" is a pill on a phone, but
 * the rule matches the element at every width, so it would be a squircle there.
 */
function pillsMadeSquircle(text: string): string[] {
	return (
		stripComments(text).match(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g) ?? []
	).filter((literal) => {
		const ws = literal.slice(1, -1).split(/\s+/);
		const pills = ws.filter((w) => strip(w) === "rounded-full");
		const tokens = ws.filter((w) => TOKEN_RADIUS.test(strip(w)));
		return (
			pills.length > 0 &&
			tokens.length > 0 &&
			[...pills, ...tokens].some((w) => variantsOf(w).length > 0)
		);
	});
}

function problems(file: string, text: string): string[] {
	const allowed = EXCEPTIONS[file] ?? [];
	const found: string[] = [];
	for (const word of words(text)) {
		// An exception names the exact class, variant and all, so the same corner elsewhere still fails.
		if (allowed.includes(word)) continue;
		const u = strip(word);
		if (!u) continue;
		if (COLOR_UTILITY.test(u)) found.push(`${u}: colors come from tokens`);
		const radius = u.match(RADIUS);
		// "rounded" alone must also be a class here, not part of a word like "roundedUp".
		if (radius && !TOKEN_RADII.has(radius[4] ?? ""))
			found.push(`${u}: radii are rounded-control, -sheet or -full`);
		if (/^(drop-|inset-|text-)?shadow(-|$)/.test(u))
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

	describe("squircle corners (decision 76, P75 A)", () => {
		const rule = cornerRules[0];

		it("has one rule in app.css that sets corner-shape: squircle, inside @supports so older browsers keep round corners", () => {
			expect(cornerRules).toHaveLength(1);
			expect(rule?.body.replace(/;$/, "")).toBe("corner-shape: squircle");
			expect(rule?.within).toContain("@supports (corner-shape: squircle)");
			// Nothing else in app.css names the property: its one declaration and the @supports test that guards it.
			const named = stripCssComments(css).match(/corner-(?:[a-z]+-)*shape/g);
			expect(named).toHaveLength(2);
		});

		it("sits in the components layer, so a utility class (the P75 drawing's round Today pictures) can override it", () => {
			// Unlayered CSS beats every layer, utilities included; components sits below utilities.
			expect(rule?.within.join(" ")).toContain("@layer components");
		});

		it("names only the two radius tokens, as a class or as a variant's class", () => {
			const { classes, variants, unreadable } = squircleSelectors(rule);
			expect(unreadable).toEqual([]);
			const token = /^:?rounded(-[a-z]{1,2})?-(control|sheet)$/;
			expect([...classes, ...variants].filter((c) => !token.test(c))).toEqual(
				[],
			);
			expect(classes.length).toBeGreaterThan(0);
			expect(variants.length).toBeGreaterThan(0);
		});

		it("reaches every class the two tokens produce, with any variant in front that keeps the radius on the element", () => {
			const missed: string[] = [];
			for (const name of TOKEN_NAMES)
				for (const side of SIDES)
					for (const variant of VARIANTS) {
						const cls = `${variant}rounded${side}-${name}`;
						if (!reaches(cls)) missed.push(cls);
						// Next to other classes, as in a real class attribute.
						if (!reaches(`flex ${cls} px-4`)) missed.push(`flex ${cls} px-4`);
					}
			expect(missed).toEqual([]);
		});

		it("reaches every rounded-control and rounded-sheet class used in src/ and public/js/", () => {
			const used = new Set<string>();
			for (const text of Object.values(SOURCES))
				for (const word of words(text))
					if (/(^|:)!?rounded(-[a-z]{1,2})?-(control|sheet)!?$/.test(word))
						used.add(word);
			// The scan sees the plain, side and variant forms the app uses.
			for (const name of [
				"rounded-control",
				"rounded-sheet",
				"rounded-t-sheet",
				"rounded-tr-control",
				"rounded-br-control",
				"rounded-l-sheet",
				"lg:rounded-l-sheet",
			])
				expect([...used]).toContain(name);
			expect([...used].filter((cls) => !reaches(cls))).toEqual([]);
		});

		it("has every rounded-control and rounded-sheet class used in src/ on the element that gets the radius", () => {
			// The rule sets corner-shape on the element with the class, not on its children or
			// pseudo-elements; put the radius class on the element itself.
			const used = new Set(Object.values(SOURCES).flatMap(usedTokenClasses));
			expect(used.size).toBeGreaterThan(0);
			expect([...used]).toContain("lg:rounded-l-sheet");
			expect(
				[...used]
					.filter((cls) => movesRadiusElsewhere(cls).length > 0)
					.map(
						(cls) =>
							`${cls}: the squircle rule sets corner-shape on the element with the class, not on descendants or pseudo-elements; put the radius class on the element itself`,
					),
			).toEqual([]);
		});

		it("catches a variant that moves the radius off the element, and leaves the ones that don't", () => {
			for (const cls of [
				"[&_input]:rounded-control",
				"[&_p]:rounded-control",
				"[&>*]:rounded-t-sheet",
				"*:rounded-control",
				"**:rounded-t-sheet",
				"before:rounded-control",
				"after:rounded-control",
				"file:rounded-control",
				"placeholder:rounded-control",
				"marker:rounded-control",
				"selection:rounded-control",
				"backdrop:rounded-t-sheet",
				"details-content:rounded-control",
				"lg:before:rounded-control",
				"hover:*:rounded-control",
			])
				expect([cls, movesRadiusElsewhere(cls).length > 0]).toEqual([
					cls,
					true,
				]);
			for (const cls of [
				"rounded-control",
				"lg:rounded-l-sheet",
				"hover:rounded-control",
				"has-[:checked]:rounded-control",
				"has-[input:focus-visible]:rounded-control",
				"group-has-[:checked]:rounded-control",
				"sm:max-lg:rounded-control",
				// A different variant that only looks like a pseudo-element one.
				"placeholder-shown:rounded-control",
			])
				expect([cls, movesRadiusElsewhere(cls)]).toEqual([cls, []]);
			// Read from source, where an arbitrary variant keeps its ">" and its brackets.
			const found = usedTokenClasses(
				'<div class="flex [&>*]:rounded-control px-2"><p class={`flex [&_p]:rounded-t-sheet`}>',
			);
			expect(found).toEqual(["[&>*]:rounded-control", "[&_p]:rounded-t-sheet"]);
			expect(found.every((cls) => movesRadiusElsewhere(cls).length > 0)).toBe(
				true,
			);
		});

		it("never pairs rounded-full with a token radius at another width or state, which would make a pill a squircle", () => {
			// The selector matches the element whatever the width: "rounded-full lg:rounded-l-sheet" would
			// be a squircle on a phone, and "rounded-control lg:rounded-full" no longer a pill on desktop.
			const found = Object.entries(SOURCES).flatMap(([file, text]) =>
				pillsMadeSquircle(text).map(
					(literal) =>
						`${file}: ${literal}: the squircle rule matches at every width and state, so a pill paired with a token radius in a variant is a squircle; use one or the other`,
				),
			);
			expect(found).toEqual([]);
		});

		it("catches a pill paired with a variant of a token radius, and leaves other strings alone", () => {
			for (const text of [
				'<span class="rounded-full lg:rounded-l-sheet px-2">',
				'<span class="rounded-full hover:rounded-control">',
				'<span class="rounded-control lg:rounded-full">',
				"<span class={`flex rounded-full sm:rounded-t-sheet px-2`}>",
			])
				expect(pillsMadeSquircle(text)).toHaveLength(1);
			for (const text of [
				'<span class="rounded-full px-2">',
				'<span class="lg:rounded-l-sheet bg-band">',
				'<span class="rounded-control hover:bg-band">',
				// A pill and a token radius in separate strings are two elements.
				'<span class="rounded-full"><b class="lg:rounded-control">',
				// Prose that names both is no class attribute: it has no variant on either.
				'"rounded-control for boxes, rounded-full for pills"',
			])
				expect(pillsMadeSquircle(text)).toEqual([]);
		});

		it("leaves rounded-full and every other class alone, so chips and round ticks stay pills", () => {
			for (const cls of [
				"rounded-full",
				"lg:rounded-full",
				"rounded-lg",
				"has-[:checked]:bg-band",
				"not-rounded-control",
				"rounded-controls",
				"[&_.rounded-control]:[corner-shape:round]",
				"[&_.rounded-t-sheet]:[corner-shape:squircle]",
				"[&_[data-money]_.rounded-control]:rounded-lg",
			])
				expect([cls, reaches(cls)]).toEqual([cls, false]);
			// Every rounded-full in the code, in any variant, is one the rule doesn't reach.
			const full = new Set<string>();
			for (const text of Object.values(SOURCES))
				for (const word of words(text))
					if (strip(word) === "rounded-full") full.add(word);
			expect(full.size).toBeGreaterThan(0);
			expect([...full].filter(reaches)).toEqual([]);
		});

		it("leaves Chip a pill: it still renders rounded-full and nothing the rule reaches", () => {
			const html = String(
				Chip({ type: "radio", name: "category", value: "1", children: "Gas" }),
			);
			const label = html.match(/<label class="([^"]*)"/)?.[1] ?? "";
			expect(label.split(/\s+/)).toContain("rounded-full");
			expect(reaches(label)).toBe(false);
		});

		it("fails if corner-shape is set anywhere in src/ or public/js/ but the P75 drawing", () => {
			const all = Object.entries(SOURCES).flatMap(([file, text]) =>
				cornerShapeProblems(file, text).map((p) => `${file}: ${p}`),
			);
			expect(all).toEqual([]);
			// Each exception has a reason and still uses the property, so a stale one is removed.
			for (const [file, reason] of Object.entries(CORNER_SHAPE_EXCEPTIONS)) {
				expect(reason.length).toBeGreaterThan(20);
				expect(stripComments(SOURCES[file] ?? "")).toMatch(CORNER_SHAPE);
			}
		});

		it("catches corner-shape in any spelling, and leaves comments and the drawing alone", () => {
			for (const text of [
				'<p class="[corner-shape:squircle]">',
				'<p class="hover:[corner-shape:round]">',
				"el.style.cornerShape = 'squircle';",
				'<p class="[corner-top-left-shape:squircle]">',
				// A per-corner name in script, and CSS, whose property names ignore case.
				"el.style.cornerTopLeftShape = 'squircle';",
				"el.style.cornerStartEndShape = 'squircle';",
				'el.style.setProperty("CORNER-SHAPE", "squircle");',
				'<p class="[Corner-Bottom-Right-Shape:squircle]">',
			])
				expect([text, cornerShapeProblems("x.tsx", text)]).toEqual([
					text,
					[expect.any(String)],
				]);
			expect(
				cornerShapeProblems(
					"x.tsx",
					"// corner-shape: squircle, in prose\n<p>",
				),
			).toEqual([]);
			expect(
				cornerShapeProblems(
					"../src/design-system/proposals-corners.tsx",
					'<p class="[corner-shape:round]">',
				),
			).toEqual([]);
		});
	});

	it("names no color that isn't a token: text-error, text-alert and from-danger draw nothing (errors are text-over)", () => {
		const tokens = new Set(
			[...css.matchAll(/--color-([\w-]+):/g)].map(([, name]) => name),
		);
		/**
		 * Words after a color prefix that aren't colors: sizes, alignment, wrapping, sides, line
		 * styles, background size, position, repeat and attachment, the transparent, current and
		 * auto keywords, and CSS property or SVG attribute names that share a prefix
		 * ("stroke-linecap", "border-color") but are never classes.
		 */
		const NOT_COLORS = new Set(
			"transparent current inherit none auto xs sm base lg xl left center right justify start end top bottom left-top left-bottom right-top right-bottom top-left top-right bottom-left bottom-right wrap nowrap balance pretty ellipsis clip t r b l x y s e solid dashed dotted double wavy hidden collapse separate offset inset cover contain fixed local scroll no-repeat clone slice from-font align color style width radius input linecap linejoin".split(
				" ",
			),
		);
		/**
		 * Families of utilities that aren't colors, each only after its own prefix:
		 * "bg-blend-multiply", "bg-repeat-x", "border-spacing-2", "divide-x-reverse".
		 */
		const NOT_COLOR_FAMILIES: Record<string, RegExp> = {
			bg: /^(blend|clip|origin|linear|radial|conic|gradient|repeat)(-|$)/,
			border: /^spacing(-|$)/,
			divide: /^(x|y)(-|$)/,
		};
		/** Prefixes whose next word is a color of its own: "ring-offset-paper", "text-shadow-sm". */
		const COLOR_AFTER: Record<string, string> = {
			ring: "offset-",
			outline: "offset-",
			text: "shadow-",
		};
		const SHADOW_SIZES = new Set(["xs", "sm", "md", "lg", "none"]);
		const NAMED =
			/^(bg|text|border(-[trblxyse])?|fill|stroke|ring|outline|divide|decoration|placeholder|caret|accent|from|via|to)-([a-z][a-z-]*?)(\/\d+)?$/;
		const offToken = (u: string) => {
			const match = u.match(NAMED);
			if (!match?.[1] || !match[3]) return false;
			const prefix = match[1].startsWith("border") ? "border" : match[1];
			const inner = COLOR_AFTER[prefix];
			const name =
				inner && match[3].startsWith(inner)
					? match[3].slice(inner.length)
					: match[3];
			if (NOT_COLOR_FAMILIES[prefix]?.test(name)) return false;
			// A text shadow's size: "text-shadow-md" (only there; "bg-md" is no color).
			if (inner === "shadow-" && name !== match[3] && SHADOW_SIZES.has(name))
				return false;
			return !tokens.has(name) && !NOT_COLORS.has(name);
		};
		expect(
			[
				"text-error",
				"border-negative",
				"text-alert",
				"from-danger",
				// A family's word is only skipped after its own prefix, and what follows it is still a color.
				"from-shadow-error",
				"border-repeat-x",
				"text-shadow-error",
				"ring-offset-error",
				"bg-md",
				"from-md",
			].filter((u) => !offToken(u)),
		).toEqual([]);
		expect(
			[
				"text-over",
				"border-over",
				"text-sm",
				"bg-ink/30",
				"text-cat-blue",
				// Tailwind's other background, border and decoration utilities aren't colours.
				"bg-cover",
				"bg-contain",
				"bg-repeat",
				"bg-no-repeat",
				"bg-repeat-x",
				"bg-center",
				"bg-left-top",
				"bg-fixed",
				"bg-clip-text",
				"bg-origin-border",
				"bg-blend-multiply",
				"bg-linear-to-r",
				"bg-radial",
				"text-shadow-sm",
				"border-spacing-x-px",
				"ring-inset",
				"outline-hidden",
				"divide-x-reverse",
				"decoration-wavy",
				"decoration-from-font",
				"accent-auto",
				"ring-offset-paper",
				"text-shadow-md",
			].filter(offToken),
		).toEqual([]);
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
				'<p class="bg-white text-stone-700 border-[#ccc] text-[red] bg-[var(--x)] bg-[#ffffff]/30 text-[red]/50 rounded-lg shadow-md drop-shadow-sm text-shadow-sm hover:rounded-xl">',
			),
		).toHaveLength(12);
		expect(
			problems(
				"x.tsx",
				'// rounded down\nconst a = roundedUp(x);\n<p class="rounded-control lg:rounded-l-sheet has-[:checked]:bg-band bg-ink/30 text-cat-blue text-[1.75rem]">',
			),
		).toEqual([]);
	});

	it("allows an exception only as the exact class it names, variant and all", () => {
		const file = "../src/design-system/proposals-polish.tsx";
		// P115 B's override is allowed; the same corner anywhere else in the file is not.
		expect(
			problems(
				file,
				'<div class="[&_[data-money]_.rounded-control]:rounded-lg">',
			),
		).toEqual([]);
		expect(problems(file, '<div class="rounded-lg">')).toHaveLength(1);
		expect(problems(file, '<div class="sm:rounded-lg">')).toHaveLength(1);
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

	it("lists every duration token in the catalog, with app.css's value", () => {
		const theme = [...css.matchAll(/--duration-([\w-]+):\s*([\d.]+m?s)/g)].map(
			([, name, value]) => [name, value],
		);
		expect(theme.length).toBeGreaterThan(5);
		expect(DURATION_TOKENS.map((t) => [t.name, t.value])).toEqual(theme);
	});
});

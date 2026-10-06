/** @jsxImportSource hono/jsx */
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import design from "../DESIGN.md?raw";
import toastSource from "../public/js/toast.js?raw";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { DURATION_TOKENS } from "../src/design-system/tokens";
import css from "../src/styles/app.css?raw";
import { BottomSheet } from "../src/views/bottom-sheet";
import { Switch } from "../src/views/switch";

// P74 A and P85 A (decisions 76, 79, 80): quiet motion in CSS only. Every duration is a token in
// app.css, every move has its reduced-motion version, and the page and its components only name
// classes, never a length. app.css is read as text, as test/design-tokens.test.ts reads it.

const SOURCES = import.meta.glob(["../src/**/*.{ts,tsx}"], {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

type Rule = {
	/** The at-rules around it, outermost first: "@media (prefers-reduced-motion: reduce)". */
	path: string[];
	/** A selector, an at-rule's name, or a keyframe's stop ("3.75%"). */
	selector: string;
	decls: Map<string, string>;
};

/** Every block with declarations in it, with the at-rules it sits in. No nested rules are used. */
function parse(text: string, path: string[] = []): Rule[] {
	const rules: Rule[] = [];
	let i = 0;
	let start = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === ";") {
			start = i + 1;
			i++;
		} else if (ch === "{") {
			let depth = 1;
			let j = i + 1;
			while (depth > 0 && j < text.length) {
				if (text[j] === "{") depth++;
				else if (text[j] === "}") depth--;
				j++;
			}
			// A selector the formatter broke over two lines is the same selector.
			const prelude = text.slice(start, i).trim().replace(/\s+/g, " ");
			const inner = text.slice(i + 1, j - 1);
			if (inner.includes("{")) rules.push(...parse(inner, [...path, prelude]));
			else {
				const decls = new Map<string, string>();
				for (const part of inner.split(";")) {
					const colon = part.indexOf(":");
					if (colon < 0) continue;
					decls.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
				}
				rules.push({ path, selector: prelude, decls });
			}
			i = j;
			start = j;
		} else i++;
	}
	return rules;
}

const rules = parse(css.replace(/\/\*[\s\S]*?\*\//g, ""));
const REDUCE = /^@media[^{]*prefers-reduced-motion:\s*reduce/;
const NO_PREFERENCE = /^@media[^{]*prefers-reduced-motion:\s*no-preference/;
const inReduce = (r: Rule) => r.path.some((p) => REDUCE.test(p));
const inKeyframes = (r: Rule) => r.path.some((p) => p.startsWith("@keyframes"));
const inTheme = (r: Rule) => r.selector.startsWith("@theme");

const selectorsOf = (r: Rule) => r.selector.split(",").map((s) => s.trim());
const rule = (selector: string, within?: (r: Rule) => boolean) =>
	rules.filter(
		(r) =>
			selectorsOf(r).includes(selector) &&
			!inKeyframes(r) &&
			(within ? within(r) : !inReduce(r)),
	);
/** A declaration of a selector, from whichever of its rules sets it (outside reduce). */
const decl = (selector: string, prop: string) =>
	rule(selector)
		.map((r) => r.decls.get(prop))
		.find((value) => value !== undefined);
const keyframes = (name: string) =>
	rules.filter((r) => r.path.includes(`@keyframes ${name}`));

/** "150ms" or "4s", in milliseconds. */
function ms(time: string | undefined): number {
	const match = time?.match(/^(\d*\.?\d+)(ms|s)$/);
	if (!match?.[1]) throw new Error(`not a time: ${time}`);
	return Number(match[1]) * (match[2] === "s" ? 1000 : 1);
}
const token = (name: string) => {
	const theme = rules.find(inTheme);
	return theme?.decls.get(`--duration-${name}`);
};

/** A rule that starts an animation or a transition (not one that only sets its length). */
function startsMotion(r: Rule): "animation" | "transition" | null {
	if (inKeyframes(r) || inTheme(r) || r.selector.startsWith("@")) return null;
	const on = (prop: string) => {
		const value = r.decls.get(prop);
		return value !== undefined && !/^none\b/.test(value);
	};
	if (on("animation") || on("animation-name")) return "animation";
	if (on("transition") || on("transition-property")) return "transition";
	return null;
}

describe("the duration tokens", () => {
	it("app.css defines 150 ms for a confirmation and 200 ms for something rising", () => {
		expect(token("confirm")).toBe("150ms");
		expect(token("rising")).toBe("200ms");
	});

	it("moves the older motions onto tokens of their own, with the lengths they had", () => {
		expect(token("slow")).toBe("600ms");
		expect(token("shake")).toBe("300ms");
		expect(token("spin")).toBe("700ms");
	});

	it("takes the bar fill, the field shake and the busy ring's lengths from them", () => {
		expect(rule(".bar-fill")[0]?.decls.get("animation")).toContain(
			"var(--duration-slow)",
		);
		expect(rule(".field-shake")[0]?.decls.get("animation")).toContain(
			"var(--duration-shake)",
		);
		expect(rule(".button-spinner")[0]?.decls.get("animation")).toContain(
			"var(--duration-spin)",
		);
	});

	it("writes no length into a rule: every animation and transition time is a token", () => {
		const TIMING =
			/^(animation|animation-duration|animation-delay|transition|transition-duration|transition-delay)$/;
		const literal: string[] = [];
		for (const r of rules) {
			if (inKeyframes(r) || inTheme(r)) continue;
			for (const [prop, value] of r.decls) {
				if (!TIMING.test(prop)) continue;
				const bare = value.replace(/var\([^)]*\)/g, "");
				if (/(^|[\s(*/+-])-?\d*\.?\d+m?s\b/.test(bare))
					literal.push(`${r.selector} { ${prop}: ${value} }`);
			}
		}
		expect(literal).toEqual([]);
	});

	it("leaves no Tailwind duration or delay class in a component", () => {
		const found = Object.entries(SOURCES).flatMap(([file, text]) =>
			(
				text
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.replace(/(^|\s)\/\/.*$/gm, "$1")
					.match(/(^|[\s"'`:])(duration|delay)-(\d+|\[)[^\s"'`]*/gm) ?? []
			).map((u) => `${file}: ${u.trim()}`),
		);
		expect(found).toEqual([]);
	});
});

describe("reduced motion", () => {
	it("shows every move's end state: each rule that starts an animation or a transition is stilled by a later reduce rule that sets it to none", () => {
		// Equal specificity, so the later rule wins: a reduce override has to come after its move.
		const missing: string[] = [];
		rules.forEach((r, i) => {
			if (inReduce(r)) return;
			const kind = startsMotion(r);
			if (!kind) return;
			for (const selector of selectorsOf(r)) {
				const stilled = rules.some(
					(o, j) =>
						j > i &&
						inReduce(o) &&
						selectorsOf(o).includes(selector) &&
						o.decls.get(kind) === "none",
				);
				if (!stilled) missing.push(`${selector} (${kind})`);
			}
		});
		expect(missing).toEqual([]);
	});

	it("names the moves this issue adds, so the check above can't pass by finding none", () => {
		const moving = new Set(
			rules.filter((r) => !inReduce(r) && startsMotion(r)).flatMap(selectorsOf),
		);
		for (const selector of [
			".fade-in",
			".sheet-rise",
			".sheet-slide",
			".sheet-panel",
			"#toasts > *",
			".toast-motion",
			".switch-track",
			".switch-knob",
			".bar-fill",
			".field-shake",
			".button-spinner",
		])
			expect(moving, selector).toContain(selector);
	});

	it("stills the desktop panel's slide, and the sheet's rise at every width", () => {
		const reduce = (selector: string) =>
			rules.filter((r) => inReduce(r) && selectorsOf(r).includes(selector))[0];
		expect(reduce(".sheet-slide")?.decls.get("animation")).toBe("none");
		expect(reduce(".sheet-rise")?.decls.get("animation")).toBe("none");
		// BottomSheet's own class rises on a phone and slides at desktop width (Tailwind's lg).
		expect(reduce(".sheet-panel")?.decls.get("animation")).toBe("none");
		const desktop = rules.find(
			(r) =>
				selectorsOf(r).includes(".sheet-panel") &&
				r.path.some((p) => /^@media[^{]*min-width:\s*64rem/.test(p)),
		);
		expect(desktop?.decls.get("animation-name")).toBe("sheet-slide");
	});
});

describe("pages", () => {
	it("cross-fades them with the browser's View Transitions, only when motion is welcome", () => {
		const viewTransition = rules.filter((r) =>
			r.selector.startsWith("@view-transition"),
		);
		expect(viewTransition).toHaveLength(1);
		expect(viewTransition[0]?.decls.get("navigation")).toBe("auto");
		expect(viewTransition[0]?.path.some((p) => NO_PREFERENCE.test(p))).toBe(
			true,
		);
	});

	it("sets the cross-fade's length to the confirmation token (the browser's own is 250 ms)", () => {
		const group = rules.find(
			(r) =>
				selectorsOf(r).includes("::view-transition-group(root)") &&
				!inReduce(r),
		);
		expect(group?.decls.get("animation-duration")).toBe(
			"var(--duration-confirm)",
		);
		expect(group?.path.some((p) => NO_PREFERENCE.test(p))).toBe(true);
	});

	it("keeps htmx's transitions setting off, so a filter or an Adjust tap never fades the page", async () => {
		const res = await exports.default.fetch("http://tally.test/");
		const html = await res.text();
		const config = html.match(
			/<meta name="htmx-config" content="([^"]*)"/,
		)?.[1];
		expect(config).toBeDefined();
		const settings = JSON.parse(
			(config ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
		);
		expect(settings.transitions ?? false).toBe(false);
		expect(html).not.toMatch(/transition:\s*true/);
		for (const [file, text] of Object.entries(SOURCES))
			expect(text, file).not.toMatch(/hx-swap[^\n]*transition:\s*true/);
	});
});

describe("toasts", () => {
	const DISPLAY_MS = Number(toastSource.match(/DISPLAY_MS\s*=\s*(\d+)/)?.[1]);

	it("lives as long as toast.js keeps it: the animation is as long as the stay, 4 seconds", () => {
		expect(DISPLAY_MS).toBe(4000);
		expect(ms(token("toast"))).toBe(DISPLAY_MS);
	});

	it("is styled by CSS alone, on what #toasts holds, and toast.js is not asked to change", () => {
		const toast = rule("#toasts > *")[0];
		expect(toast?.decls.get("animation")).toMatch(
			/^toast var\(--duration-toast\) ease-out both$/,
		);
		// The same animation for a drawing of a toast, which sits outside #toasts.
		expect(selectorsOf(toast as Rule)).toContain(".toast-motion");
		expect(toastSource).not.toMatch(/animation|transition|style\./);
	});

	it("fades in and rises 8 px in 150 ms, holds, then fades out", () => {
		const stops = new Map(keyframes("toast").map((r) => [r.selector, r.decls]));
		const confirm = ms(token("confirm"));
		const inEnds = `${(confirm * 100) / DISPLAY_MS}%`;
		// The fade-out starts 300 ms before the end and is over 150 ms before it (see the next test).
		const outStarts = `${100 - (2 * confirm * 100) / DISPLAY_MS}%`;
		const outEnds = `${100 - (confirm * 100) / DISPLAY_MS}%`;
		expect(stops.get("0%")?.get("opacity")).toBe("0");
		expect(stops.get("0%")?.get("transform")).toBe("translateY(8px)");
		expect(stops.get(inEnds)?.get("opacity")).toBe("1");
		expect(stops.get(inEnds)?.get("transform")).toBe("none");
		expect(stops.get(outStarts)?.get("opacity")).toBe("1");
		expect(stops.get(outEnds)?.get("opacity")).toBe("0");
		expect(stops.get("100%")?.get("opacity")).toBe("0");
	});

	it("is already invisible when toast.js takes it out: the fade-out ends well before the 4 seconds, and the fill holds it at 0", () => {
		// toast.js starts its timer when it appends the toast, but the animation starts a frame or more
		// later, so a fade-out timed to end exactly at DISPLAY_MS is cut off: the toast pops out
		// part-way through it. The slack covers a few slow frames.
		const stops = keyframes("toast").map((r) => ({
			at: (Number.parseFloat(r.selector) * DISPLAY_MS) / 100,
			opacity: r.decls.get("opacity"),
		}));
		const fadeOutFrom = stops.filter((stop) => stop.opacity === "1").at(-1);
		const gone = stops.find(
			(stop) => stop.opacity === "0" && stop.at > (fadeOutFrom?.at ?? 0),
		);
		expect((gone?.at ?? 0) - (fadeOutFrom?.at ?? 0)).toBeCloseTo(
			ms(token("confirm")),
		);
		expect(DISPLAY_MS - (gone?.at ?? DISPLAY_MS)).toBeGreaterThanOrEqual(100);
		// `both` holds the last stop (opacity 0) from there until the toast is removed.
		expect(rule("#toasts > *")[0]?.decls.get("animation")).toMatch(/\bboth$/);
	});
});

describe("the sheet and the switch", () => {
	it("rises in 200 ms ease-out, and the backdrop fades in", () => {
		expect(rule(".sheet-rise")[0]?.decls.get("animation")).toBe(
			"sheet-rise var(--duration-rising) ease-out",
		);
		expect(rule(".fade-in")[0]?.decls.get("animation")).toBe(
			"fade-in var(--duration-rising) ease-out",
		);
		expect(keyframes("sheet-rise")[0]?.decls.get("transform")).toBe(
			"translateY(100%)",
		);
		expect(keyframes("fade-in")[0]?.decls.get("opacity")).toBe("0");
	});

	it("slides in from the right edge in 200 ms ease-out on desktop", () => {
		expect(rule(".sheet-slide")[0]?.decls.get("animation")).toBe(
			"sheet-slide var(--duration-rising) ease-out",
		);
		expect(keyframes("sheet-slide")[0]?.decls.get("transform")).toBe(
			"translateX(100%)",
		);
	});

	it("draws BottomSheet from classes alone: the backdrop fades in, the panel rises or slides", () => {
		const out = String(
			BottomSheet({ labelledBy: "t", closeHref: "/", children: "x" }),
		);
		expect(out).toMatch(/<a [^>]*class="[^"]*\bfade-in\b[^"]*"/);
		expect(out).toMatch(/<section [^>]*class="[^"]*\bsheet-panel\b[^"]*"/);
		expect(out).not.toMatch(/\sstyle=|<script/);
	});

	it("draws a sheet that is already open with neither class, and nothing else changes", () => {
		const props = { labelledBy: "t", closeHref: "/", children: "x" };
		const playing = String(BottomSheet(props));
		const still = String(BottomSheet({ ...props, still: true }));
		expect(still).not.toMatch(/\bfade-in\b|\bsheet-panel\b/);
		expect(still).toContain('role="dialog"');
		// The same sheet in the same place: only the two motion classes are gone.
		expect(still).toBe(
			playing.replace("fade-in ", "").replace("sheet-panel ", ""),
		);
	});

	it("slides the knob and swaps the tones in 150 ms ease-out, from classes in app.css", () => {
		for (const part of [".switch-track", ".switch-knob"]) {
			expect(decl(part, "transition-duration"), part).toBe(
				"var(--duration-confirm)",
			);
			expect(decl(part, "transition-timing-function"), part).toBe("ease-out");
		}
		expect(decl(".switch-track", "transition-property")).toBe(
			"background-color",
		);
		expect(decl(".switch-knob", "transition-property")).toMatch(
			/translate[\s\S]*background-color/,
		);
	});

	it("puts those classes on the Switch's track and knob, with no length in the component", () => {
		const out = String(
			Switch({ id: "s", name: "s", label: "Income", checked: true }),
		);
		expect(out).toMatch(/class="[^"]*\bswitch-track\b/);
		expect(out).toMatch(/class="[^"]*\bswitch-knob\b/);
		expect(out).not.toMatch(/duration-|motion-reduce:transition/);
	});
});

describe("a sheet that is already open stays still", () => {
	// The sheet's arrival (fade-in on the backdrop, sheet-panel on the sheet) is a class on the element,
	// so any swap that draws the open sheet again would play it again: a field's error, the delete
	// question and Add a part would each look like the sheet closing and opening, and the rise would
	// drown the field's own shake. Opening it plays; drawing it again does not.
	const BASE = "http://tally.test";
	beforeEach(() => resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE)));

	async function send(
		path: string,
		fields?: Record<string, string>,
		headers: Record<string, string> = {},
	) {
		const res = await exports.default.fetch(BASE + path, {
			method: fields ? "POST" : "GET",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				...(fields
					? { "content-type": "application/x-www-form-urlencoded" }
					: {}),
				...headers,
			},
			body: fields ? new URLSearchParams(fields) : undefined,
		});
		return { res, html: await res.text() };
	}
	/** Whether the page has a sheet, and which of its two arrival classes it carries. */
	function sheetIn(html: string) {
		const sheet = html.match(/<section [^>]*role="dialog"[^>]*>/)?.[0];
		const backdrop = html.match(
			/<a [^>]*aria-label="Close"[^>]*bg-ink\/30[^>]*>/,
		)?.[0];
		return {
			open: sheet !== undefined && backdrop !== undefined,
			panel: /\bsheet-panel\b/.test(sheet ?? ""),
			fade: /\bfade-in\b/.test(backdrop ?? ""),
		};
	}
	const PLAYS = { open: true, panel: true, fade: true };
	const STILL = { open: true, panel: false, fade: false };

	const firstTransaction = async () =>
		(
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE parent_id IS NULL AND is_split = 0 AND flag_income = 0 AND amount_cents > 0 LIMIT 1",
			).first<{ id: number }>()
		)?.id as number;
	const addCash = async () => {
		await send("/transactions/cash", {
			date: todayIn(DEFAULT_TIME_ZONE),
			amount: "20.45",
			merchant: "Quiet market",
			category: "1",
			back: "/transactions",
		});
		return (
			await env.DB.prepare(
				"SELECT t.id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type='cash' AND t.raw_name='Quiet market'",
			).first<{ id: number }>()
		)?.id as number;
	};

	it("opens Home's budget sheet with the motion, and draws it still after a refused amount", async () => {
		expect(sheetIn((await send("/budget/1")).html)).toEqual(PLAYS);
		const refused = await send("/budget/1", { budget: "abc" });
		expect(refused.res.status).toBe(422);
		expect(sheetIn(refused.html)).toEqual(STILL);
	});

	it("opens Add cash with the motion, and draws it still after a field's error", async () => {
		expect(sheetIn((await send("/transactions/cash/new")).html)).toEqual(PLAYS);
		const refused = await send("/transactions/cash", {
			date: todayIn(DEFAULT_TIME_ZONE),
			amount: "",
			merchant: "",
			category: "1",
		});
		expect(refused.res.status).toBe(422);
		expect(sheetIn(refused.html)).toEqual(STILL);
	});

	it("opens the edit panel with the motion, and draws it still after a field's error", async () => {
		const id = await firstTransaction();
		expect(sheetIn((await send(`/transactions/${id}`)).html)).toEqual(PLAYS);
		const refused = await send(`/transactions/${id}`, {
			merchant: "x".repeat(200),
			back: "/transactions",
		});
		expect(refused.res.status).toBe(422);
		expect(sheetIn(refused.html)).toEqual(STILL);
	});

	it("draws the edit panel still for the delete question, and again when Keep it brings the panel back", async () => {
		const id = await addCash();
		const question = await send(`/transactions/${id}/delete`, {
			back: "/transactions",
		});
		expect(question.html).toContain("Delete Quiet market, $20.45?");
		expect(sheetIn(question.html)).toEqual(STILL);
		// Keep it is a GET of the panel's own address, from the page that already shows it.
		const keep = await send(`/transactions/${id}`, undefined, {
			"HX-Current-URL": `${BASE}/transactions/${id}?month=all`,
		});
		expect(sheetIn(keep.html)).toEqual(STILL);
		// A tap on the row, from the list, is the panel opening.
		const open = await send(`/transactions/${id}`, undefined, {
			"HX-Current-URL": `${BASE}/transactions`,
		});
		expect(sheetIn(open.html)).toEqual(PLAYS);
		// Without the header (a link, a reload) the panel arrives like any page.
		const reload = await exports.default.fetch(`${BASE}/transactions/${id}`);
		expect(sheetIn(await reload.text())).toEqual(PLAYS);
	});

	it("opens the split sheet with the motion, and draws it still for Add a part and for an error", async () => {
		const id = await firstTransaction();
		expect(sheetIn((await send(`/transactions/${id}/split`)).html)).toEqual(
			PLAYS,
		);
		const parts = {
			back: "/transactions",
			part_category: "1",
			part_amount: "1.00",
		};
		const added = await send(`/transactions/${id}/split`, {
			...parts,
			add: "1",
		});
		expect(added.res.status).toBe(200);
		expect(sheetIn(added.html)).toEqual(STILL);
		const refused = await send(`/transactions/${id}/split`, parts);
		expect(refused.res.status).toBe(422);
		expect(sheetIn(refused.html)).toEqual(STILL);
	});

	it("opens a bill's sheet with the motion, and draws it still after a field's error", async () => {
		expect(sheetIn((await send("/bills/new")).html)).toEqual(PLAYS);
		const refused = await send("/bills", {
			name: "",
			amount: "",
			due_day: "",
			frequency: "monthly",
		});
		expect(refused.html).toContain("Enter a name.");
		expect(sheetIn(refused.html)).toEqual(STILL);
	});

	it("opens Set category with the motion, and draws it still when its Save is refused", async () => {
		const id = await firstTransaction();
		const open = await send("/transactions/select/category", {
			ids: String(id),
			back: "/transactions",
		});
		expect(sheetIn(open.html)).toEqual(PLAYS);
		const refused = await send("/transactions/select/category/save", {
			ids: String(id),
			back: "/transactions",
		});
		expect(refused.res.status).toBe(422);
		expect(sheetIn(refused.html)).toEqual(STILL);
	});
});

describe("the proposals page's drawings", () => {
	it("leaves no .proposal- rule for a move that shipped: the sheet, the panel, the toast and the switch use the real classes", () => {
		const classes = new Set(
			rules
				.filter((r) => !inKeyframes(r))
				.flatMap(selectorsOf)
				.flatMap((s) => [...s.matchAll(/\.(proposal-[a-z0-9-]+)/g)])
				.map((m) => m[1]),
		);
		// What's left is the loop that draws the unpicked B's morph and sliding pages (and C's cuts).
		expect([...classes].sort()).toEqual(
			[
				"proposal-200",
				"proposal-cut",
				"proposal-loop",
				"proposal-morph",
				"proposal-slide-in",
				"proposal-slide-out",
			].sort(),
		);
		for (const gone of [
			"proposal-fade",
			"proposal-rise",
			"proposal-toast",
			"proposal-slide-right",
			"proposal-knob",
			"proposal-track",
			"proposal-on",
			"proposal-off",
		])
			expect(classes.has(gone), gone).toBe(false);
	});

	it("draws the real classes in the pictures, not copies of them", () => {
		for (const file of [
			"../src/design-system/proposals-motion.tsx",
			"../src/design-system/proposals-details.tsx",
		]) {
			const text = SOURCES[file] ?? "";
			for (const gone of [
				"proposal-fade",
				"proposal-rise",
				"proposal-toast",
				"proposal-slide-right",
				"proposal-knob",
				"proposal-track",
				"proposal-on",
				"proposal-off",
			])
				expect(text.includes(gone), `${file} ${gone}`).toBe(false);
		}
		const motion = SOURCES["../src/design-system/proposals-motion.tsx"] ?? "";
		for (const real of ["sheet-rise", "fade-in", "toast-motion"])
			expect(motion.includes(real), real).toBe(true);
		expect(
			(SOURCES["../src/design-system/proposals-details.tsx"] ?? "").includes(
				"sheet-slide",
			),
		).toBe(true);
	});

	it("keeps them moving: the loop replays the real classes, and rests on the end state under reduced motion", () => {
		const replay = rules.find(
			(r) =>
				r.selector.startsWith(".proposal-loop :is(") &&
				r.decls.get("animation-iteration-count") === "infinite",
		);
		expect(replay).toBeDefined();
		expect(replay?.selector).toContain(".sheet-rise");
		expect(replay?.selector).toContain(".sheet-slide");
		expect(replay?.selector).toContain(".fade-in");
		expect(
			rules.some(
				(r) =>
					inReduce(r) &&
					selectorsOf(r).includes(".proposal-loop") &&
					r.decls.get("animation") === "none",
			),
		).toBe(true);
	});

	it("keeps the switch moving too: it is drawn Off, and the loop slides the real knob and track from the On look", async () => {
		// The switch's own move is a transition, which a tap starts and a loop cannot, so the loop
		// replays the same two classes as an animation that runs from On to the Off they rest on.
		const replay = rules.find((r) =>
			r.selector.startsWith(".proposal-loop :is("),
		);
		for (const part of [".switch-knob", ".switch-track"]) {
			expect(replay?.selector, part).toContain(part);
			const named = rules.find(
				(r) =>
					!inReduce(r) &&
					r.selector === `.proposal-loop ${part}` &&
					r.decls.has("animation-name"),
			);
			const from = keyframes(named?.decls.get("animation-name") ?? "")[0];
			expect(from?.selector, part).toBe("from");
			expect(
				rules.some(
					(r) =>
						inReduce(r) &&
						selectorsOf(r).includes(`.proposal-loop ${part}`) &&
						r.decls.get("animation") === "none",
				),
				`${part} under reduced motion`,
			).toBe(true);
		}
		expect(
			keyframes(
				rules
					.find((r) => r.selector === ".proposal-loop .switch-knob")
					?.decls.get("animation-name") ?? "",
			)[0]?.decls.get("translate"),
		).toBe("1.375rem");
		// Off at rest, so what the loop settles on (and a still capture shows) is the move's end.
		const res = await exports.default.fetch(
			"http://tally.test/design-system/proposals",
		);
		const html = await res.text();
		for (const look of ["quiet", "more", "none"]) {
			const input = html.match(
				new RegExp(`<input [^>]*id="p74-${look}-switch"[^>]*>`),
			)?.[0];
			expect(input, look).toBeDefined();
			expect(input, look).not.toMatch(/\schecked\b/);
		}
	});
});

describe("the catalog and DESIGN.md", () => {
	/** A specimen's section, up to the next one. */
	const section = (html: string, id: string) => {
		const start = html.indexOf(`<section id="${id}"`);
		expect(start, id).toBeGreaterThan(-1);
		const next = html.indexOf("<section ", start + 1);
		return html.slice(start, next < 0 ? undefined : next);
	};
	const text = (html: string) =>
		html.replace(/<[^>]*>/g, " ").replace(/&#39;|&apos;/g, "'");

	it("shows the duration tokens, and each motion in its component's use spec", async () => {
		const res = await exports.default.fetch("http://tally.test/design-system");
		const html = await res.text();
		const motion = text(section(html, "motion"));
		for (const t of DURATION_TOKENS)
			expect(motion).toContain(`duration-${t.name}`);
		// The Switch, the sheet and the toast: each use spec's Motion row, with its length.
		expect(text(section(html, "switch"))).toMatch(
			/Motion\s+The knob slides in 150 ms, ease-out, and the track and knob swap tones/,
		);
		const sheet = text(section(html, "bottom-sheet"));
		expect(sheet).toMatch(/Motion\s+It arrives in 200 ms, ease-out/);
		expect(sheet).toContain("slides in from the right edge");
		expect(sheet).toContain("backdrop fades in");
		expect(sheet).toContain(
			"Reduced motion shows the sheet and backdrop at once",
		);
		// It plays when it opens, not when a swap draws the open sheet again.
		expect(sheet).toContain("It plays only when it opens");
		const toast = text(section(html, "toast"));
		expect(toast).toMatch(/Motion\s+It fades in and rises 8 px in 150 ms/);
		expect(toast).toContain("DISPLAY_MS");
		expect(toast).toContain("invisible 150 ms before the script takes it out");
		expect(toast).toContain("Reduced motion shows it at once");
		// Pages: Layout's specimen.
		const layout = text(section(html, "layout"));
		expect(layout).toContain("cross-fade in 150 ms");
		expect(layout).toContain("@view-transition { navigation: auto; }");
		expect(layout).toContain("Chrome and Edge 126 and later and Safari 18.2");
		expect(layout).toContain("Firefox doesn't yet");
	});

	it("writes the motion tokens and each move into DESIGN.md", () => {
		for (const t of DURATION_TOKENS)
			expect(design).toContain(`--duration-${t.name}\` `);
		expect(design).toMatch(
			/\| BottomSheet \|[^\n]*200 ms[^\n]*backdrop fades in/,
		);
		expect(design).toMatch(/\| Layout \|[^\n]*@view-transition/);
		expect(design).toMatch(/\| Switch \|[^\n]*knob slides in 150 ms/);
		expect(design).toMatch(/\| BottomSheet \|[^\n]*only when it opens/);
		// "150 to 200 ms" is the quiet moves' length: the bar fill (600 ms) and the shake (300 ms) are not in it.
		expect(design).toMatch(
			/\| Motion \|[^|\n]*shakes once[^|\n]*each in 150 to 200 ms/,
		);
		expect(design).toMatch(/- Motion:[^\n]*decision 76[^\n]*[Dd]ecision 80/);
		expect(design).toMatch(/- Motion:[^\n]*toast[^\n]*DISPLAY_MS/);
	});
});

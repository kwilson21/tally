import { env, exports } from "cloudflare:workers";
import htmxSource from "htmx.org/dist/htmx.js?raw";
import { describe, expect, it } from "vitest";
import decisions from "../docs/decisions.md?raw";
import spec from "../docs/superpowers/specs/2026-09-22-tally-design.md?raw";
import resetSource from "../src/demo/reset.ts?raw";
import { buildSeed } from "../src/demo/seed";
import { DECIDED } from "../src/design-system/proposals";
import { endBarRatio } from "../src/design-system/proposals-phase5-picks";
import { designSystem } from "../src/routes/design-system";
import css from "../src/styles/app.css?raw";
import { SIDEBAR_ITEMS, TAB_ITEMS } from "../src/views/nav";

const get = async (path: string) => {
	const res = await exports.default.fetch(`http://tally.test${path}`);
	return { res, html: await res.text() };
};
const notDemo = { ...env, DEMO: "false" } as unknown as Env;
// A picture of a screen, as the proposals draw it (labelled, inert).
const PICTURE = /role="img" aria-label="[^"]*, on (a phone|desktop)"/g;

/** A proposal's section, up to the next section (sections don't nest in the drawings). */
const block = (html: string, id: string) => {
	const start = html.indexOf(`<section id="${id}"`);
	expect(start, id).toBeGreaterThan(-1);
	const next = html.indexOf("<section ", start + 1);
	return html.slice(start, next < 0 ? undefined : next);
};

/** One option of a block: its heading, up to the next heading. Names are as the HTML spells them. */
const optionOf = (chunk: string, name: string) => {
	const heads = [...chunk.matchAll(/<h4 /g)].map((m) => m.index ?? 0);
	const at = heads.find((i) => chunk.slice(i, i + 400).includes(`>${name}`));
	expect(at, name).toBeDefined();
	const end = heads.find((i) => i > (at ?? 0));
	return chunk.slice(at, end);
};

/** A block's options in drawing order, each with its name and whether its heading carries the Picked pill. */
const optionPicks = (chunk: string) =>
	[...chunk.matchAll(/<h4 [^>]*>([\s\S]*?)<\/h4>/g)].map((m) => {
		const heading = m[1] ?? "";
		return {
			name: heading.split("<")[0] ?? "",
			picked: heading.includes(">Picked<"),
		};
	});

// Elements HTML never closes, so they don't open a level in actions() below.
const VOID = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"source",
	"track",
	"wbr",
]);

/** The attributes of an opening tag by lowercased name, "" for a bare one. */
function attributes(tag: string): Map<string, string> {
	const body = tag.replace(/^<[a-z][a-z0-9-]*/i, "").replace(/\/?>$/, "");
	const attrs = new Map<string, string>();
	// A quoted value is consumed by its own attribute, so a word inside it is never read as a name.
	for (const m of body.matchAll(
		/\s+([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g,
	))
		attrs.set((m[1] ?? "").toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
	return attrs;
}

/** htmx's #prefixes: a name, and the same name with the prefix in place of hx-. */
const spellings = (name: string, prefix: string) => [
	name,
	name.replaceAll("hx-", prefix),
];

/**
 * htmx 4's request attributes and its prefix, read from the installed htmx so an upgrade can't leave this list
 * behind. #actionSelector (htmx.js:152) names the attributes htmx sets up, and config.prefix (htmx.js:187) is the
 * spelling each one also answers to. A changed shape throws here, loudly, instead of returning an empty list.
 */
function readHtmx(source: string) {
	const selector = source.match(
		/#actionSelector = this\.#prefixSelector\('([^']+)'\)/,
	)?.[1];
	const prefix = source.match(/prefix: "([^"]+)"/)?.[1];
	if (!selector || !prefix)
		throw new Error(
			"htmx.js changed shape: update readHtmx() in test/design-system-proposals.test.ts (#448)",
		);
	const names = [...selector.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1] ?? "");
	return {
		prefix,
		request: names.flatMap((name) => spellings(name, prefix)),
	};
}
const HTMX = readHtmx(htmxSource);

/**
 * Every element on the page that can post a change or swap a target: a form, an element with a request
 * attribute htmx 4 sets up (HTMX.request), hx-boost (which boosts a link or form into a request), a formaction,
 * and a button or input that submits (type submit or image, or one that names another form). `inert` says
 * whether it sits inside an inert element, itself included. It reads attribute names through attributes(), so
 * text inside quotes never counts. Scripts and styles are skipped, and every tag must close in order, so a
 * wrong nesting fails.
 */
function actions(html: string) {
	const open: { tag: string; inert: boolean }[] = [];
	const found: { raw: string; inert: boolean }[] = [];
	const markup = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
	for (const match of markup.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
		const raw = match[0];
		const tag = (match[1] ?? "").toLowerCase();
		if (raw.startsWith("</")) {
			expect(open.pop()?.tag, raw).toBe(tag);
			continue;
		}
		const attrs = attributes(raw);
		const inert = attrs.has("inert");
		const submits =
			attrs.get("type") === "submit" ||
			attrs.get("type") === "image" ||
			attrs.has("form");
		const acts =
			tag === "form" ||
			[...attrs.keys()].some(
				(name) =>
					HTMX.request.includes(name) ||
					name === "formaction" ||
					spellings("hx-boost", HTMX.prefix).some((p) => name.startsWith(p)),
			) ||
			((tag === "button" || tag === "input") && submits);
		if (acts) found.push({ raw, inert: inert || open.some((o) => o.inert) });
		if (!raw.endsWith("/>") && !VOID.has(tag)) open.push({ tag, inert });
	}
	expect(open).toEqual([]);
	return found;
}

/**
 * The opening tags that htmx can fire without a press: any hx-trigger or hx-on attribute, bare, with a ":..."
 * suffix, or in htmx's prefixed spelling. inert doesn't stop them (load, every N, revealed and from: fire on
 * their own, and hx-on runs code on htmx's events), so the route test requires none. Scripts and styles are
 * skipped, as in actions().
 */
function firesByItself(html: string): string[] {
	const markup = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
	const names = ["hx-trigger", "hx-on"].flatMap((name) =>
		spellings(name, HTMX.prefix),
	);
	return [...markup.matchAll(/<[a-z][a-z0-9-]*\b[^>]*>/gi)]
		.map((m) => m[0])
		.filter((raw) =>
			[...attributes(raw).keys()].some((name) =>
				names.some((p) => name.startsWith(p)),
			),
		);
}

/**
 * Every element a keyboard can reach (a link with an href, a button, a form control, a summary, anything with a
 * tabindex) that sits inside a picture (role="img") and outside any inert element. A picture is one labelled image,
 * so nothing inside it may take focus. Walks the tags as actions() does, so a wrong nesting fails.
 */
function reachableInPictures(html: string): string[] {
	const open: { tag: string; inert: boolean; picture: boolean }[] = [];
	const found: string[] = [];
	const markup = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
	for (const match of markup.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
		const raw = match[0];
		const tag = (match[1] ?? "").toLowerCase();
		if (raw.startsWith("</")) {
			expect(open.pop()?.tag, raw).toBe(tag);
			continue;
		}
		const attrs = attributes(raw);
		const inert = attrs.has("inert") || open.some((o) => o.inert);
		const picture = attrs.get("role") === "img" || open.some((o) => o.picture);
		const reachable =
			(tag === "a" && attrs.has("href")) ||
			["button", "input", "select", "textarea", "summary"].includes(tag) ||
			attrs.has("tabindex");
		if (reachable && picture && !inert) found.push(raw);
		if (!raw.endsWith("/>") && !VOID.has(tag))
			open.push({
				tag,
				inert: attrs.has("inert"),
				picture: attrs.get("role") === "img",
			});
	}
	expect(open).toEqual([]);
	return found;
}

describe("actions()", () => {
	it("doesn't count the word inert inside a quoted value as an inert attribute", () => {
		const found = actions(
			'<form aria-label="An inert preview" hx-post="/example"></form>',
		);
		expect(found.length).toBe(1);
		expect(found[0]?.inert).toBe(false);
	});

	it("doesn't count a class that is named inert as an inert attribute", () => {
		const found = actions('<form class="inert" hx-post="/x"></form>');
		expect(found.length).toBe(1);
		expect(found[0]?.inert).toBe(false);
	});

	it("doesn't count inert as one word among several in a quoted value", () => {
		const found = actions(
			'<form class="card inert panel" hx-post="/x"></form>',
		);
		expect(found.length).toBe(1);
		expect(found[0]?.inert).toBe(false);
	});

	it("reads a bare inert attribute", () => {
		const found = actions('<form inert hx-post="/x"></form>');
		expect(found.length).toBe(1);
		expect(found[0]?.inert).toBe(true);
	});

	it('reads inert="", the form Hono renders for a boolean inert prop', () => {
		const found = actions('<form inert="" hx-post="/x"></form>');
		expect(found.length).toBe(1);
		expect(found[0]?.inert).toBe(true);
	});

	it("counts a wrapper's inert for every action inside it", () => {
		const found = actions(
			'<div inert=""><form hx-post="/x"><button type="submit">Go</button></form></div>',
		);
		expect(found.map((a) => a.inert)).toEqual([true, true]);
	});

	it("finds a plain live control with an hx attribute and leaves it live", () => {
		const found = actions('<div><a hx-get="/y">x</a></div>');
		expect(found.length).toBe(1);
		expect(found[0]?.inert).toBe(false);
	});

	it("finds an hx-action button, a request attribute htmx 4 sets up, and leaves it live", () => {
		const found = actions(
			'<button type="button" hx-action="/x" hx-method="POST">Go</button>',
		);
		expect(found.length).toBe(1);
		expect(found[0]?.inert).toBe(false);
	});

	it("finds an hx-query element, a request attribute htmx 4 sets up, and leaves it live", () => {
		const found = actions('<div hx-query="/x"></div>');
		expect(found.length).toBe(1);
		expect(found[0]?.inert).toBe(false);
	});

	it("reads an hx-action button and an hx-query element inside an inert wrapper as inert", () => {
		const found = actions(
			'<div inert=""><button type="button" hx-action="/x" hx-method="POST">Go</button><div hx-query="/x"></div></div>',
		);
		expect(found.map((a) => a.inert)).toEqual([true, true]);
	});

	it("finds the data-hx- prefixed request attributes, which htmx 4 reads too, and reads them inert inside a wrapper", () => {
		for (const html of [
			'<a data-hx-post="/x">x</a>',
			'<button type="button" data-hx-action="/x">x</button>',
		]) {
			const found = actions(html);
			expect(found.length, html).toBe(1);
			expect(found[0]?.inert, html).toBe(false);
			const wrapped = actions(`<div inert="">${html}</div>`);
			expect(
				wrapped.map((a) => a.inert),
				html,
			).toEqual([true]);
		}
	});

	it("finds hx-boost, which boosts a link or form into a request, bare, inherited and prefixed", () => {
		const boosted = actions('<a hx-boost="true" href="/x">x</a>');
		expect(boosted.length).toBe(1);
		expect(boosted[0]?.inert).toBe(false);
		const inherited = actions(
			'<div hx-boost:inherited="true"><a href="/x">x</a></div>',
		);
		expect(inherited.length).toBe(1);
		expect(inherited[0]?.raw).toContain("hx-boost:inherited");
		expect(inherited[0]?.inert).toBe(false);
		expect(actions('<div data-hx-boost="true"></div>').length).toBe(1);
	});

	it("doesn't count hx-trigger or hx-method alone, since htmx 4 makes no request from either", () => {
		expect(actions('<div hx-trigger="click"></div>')).toEqual([]);
		expect(actions('<div hx-method="POST"></div>')).toEqual([]);
	});

	it("lists every opening tag that can fire without a press, inert or not, and no plain request", () => {
		expect(
			firesByItself(
				'<div inert=""><div hx-get="/x" hx-trigger="load"></div></div>',
			),
		).toHaveLength(1);
		expect(
			firesByItself(
				'<div hx-trigger:inherited="every 1s"><a hx-get="/y">y</a></div>',
			),
		).toHaveLength(1);
		expect(
			firesByItself('<div data-hx-trigger="revealed"></div>'),
		).toHaveLength(1);
		expect(
			firesByItself('<button type="button" hx-on:click="x()">x</button>'),
		).toHaveLength(1);
		expect(
			firesByItself('<div data-hx-on::after:init="x()"></div>'),
		).toHaveLength(1);
		expect(firesByItself('<div hx-get="/x"></div>')).toEqual([]);
	});

	it("reads the request names and the prefix from the installed htmx, and fails loudly if its source changes shape", () => {
		expect(HTMX.request).toEqual(
			expect.arrayContaining([
				"hx-get",
				"hx-post",
				"hx-action",
				"hx-query",
				"data-hx-get",
				"data-hx-action",
			]),
		);
		expect(HTMX.prefix).toBe("data-hx-");
	});
});

describe("GET /design-system/proposals", () => {
	it("draws P63's Accounts top with a net-worth line that ends on the headline above it", async () => {
		const { html } = await get("/design-system/proposals");
		const start = html.indexOf('id="p63-account-filter"');
		expect(start).toBeGreaterThan(-1);
		expect(html.slice(start)).toContain("$23,400");
		expect(html.slice(start)).toContain("and is $23,400 today.");
	});

	it("shows P23–P129 with one recommended option each (P91–P109 and P117 are picks drawn as decided), marks the owner's picks from P34 on, and lists every decided proposal", async () => {
		const { res, html } = await get("/design-system/proposals");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Proposals · Design system · Tally</title>");
		expect(html).not.toContain("No open proposals.");
		expect(html).not.toContain('id="p22-counts"');
		const ids = [...html.matchAll(/<section id="(p\d+[a-z0-9-]*)"/g)].map(
			(m) => m[1] ?? "",
		);
		// Every proposal from P23 to P129, and P134 and P135, is drawn, and each id is used once.
		const numbers = new Set(ids.map((id) => Number(id.match(/^p(\d+)/)?.[1])));
		for (let n = 23; n <= 129; n++) expect(numbers.has(n)).toBe(true);
		expect(numbers.has(134)).toBe(true);
		expect(numbers.has(135)).toBe(true);
		expect(new Set(ids).size).toBe(ids.length);
		// P31 (empty and early states) is signed off as drawn, so it has no options to weigh. So is
		// every proposal from P91 to P109 (decision 82): the owner picked each from pictures, so the page
		// draws the pick and nothing to choose between. Every other proposal marks exactly one
		// Recommended, with its reason.
		for (const id of ids) {
			const n = Number(id.match(/^p(\d+)/)?.[1]);
			const asDrawn = id === "p31-empty" || (n >= 91 && n <= 109) || n === 117;
			const start = html.indexOf(`<section id="${id}"`);
			// Up to the next proposal (a picture can hold sections of its own).
			const next = html.indexOf('<section id="p', start + 1);
			const section = html.slice(start, next === -1 ? undefined : next);
			const recommended = section.match(/>Recommended</g)?.length ?? 0;
			expect([id, recommended]).toEqual([id, asDrawn ? 0 : 1]);
			// P118 and P119 give each option a reason (Why) after its trade-off, not only the recommended one.
			// P125 gives each of its five options a reason too (its E is the one recommended), and P128 each of its three.
			const eachOption =
				id === "p118-rows" ||
				id === "p119-saved" ||
				id === "p125-first-week" ||
				id === "p128-keys" ||
				id === "p129-money" ||
				id === "p130-why" ||
				id === "p131-bill-page" ||
				id === "p132-month-result" ||
				id === "p133-month-dots" ||
				id === "p134-settings" ||
				id === "p135-suggestions" ||
				id === "p136-bills-totals";
			const reasons = section.match(/text-muted">Why: /g)?.length ?? 0;
			expect([id, reasons]).toEqual([
				id,
				eachOption ? (section.match(/Trade-off: /g)?.length ?? 0) : recommended,
			]);
			// P34 on mark the owner's pick (decisions 72–86), and P118 to P125 mark the owner's picks (decisions 111 and 114).
			// P60 and P111 took two picks. P118, P120 and P121 mark a pick and its desktop drawing, which is the same option.
			const picked = section.match(/>Picked</g)?.length ?? 0;
			const twoPicks = [
				"p60-bills-total",
				"p111-delete-cash",
				"p118-rows",
				"p120-panel",
				"p121-header",
			];
			// P126 (decision 115) and P127 (decision 116) are the owner's picks too, each marked Picked on its A. P128 is decision 118, P129 decision 117, P130 to P133 decision 121, and P136 option A decision 122.
			// P134 and P135 are the second audit's picks (#606, #607), each marking its option A (decision 120).
			const expected = n < 34 ? 0 : twoPicks.includes(id) ? 2 : 1;
			expect([id, picked]).toEqual([id, expected]);
			// Every option is a picture of a screen: labelled, and nothing inside to Tab to. Each option counts its own
			// pictures: exactly one for the proposals drawn before P120, and at least one from P120 on, which draw a
			// screen per step or per state (decision 47), P120 and P121 with two or three. P119's options are rows of
			// stills, checked in its own test, so they count none here. Counted per option, so one option can't lose
			// its picture while another gains one, and every picture in the proposal must sit inside an option
			// (P128's one shared picture, before its options, is the exception and is counted below).
			const drawn = section
				.split("<h4 ")
				.slice(1)
				.map((option) => option.match(PICTURE)?.length ?? 0);
			// P129's pictures are rows of states, three to a row, so they sit under no one option's heading; its own test counts them.
			expect([
				id,
				id === "p129-money" ||
					drawn.every((count) =>
						id === "p119-saved"
							? count === 0
							: n >= 120
								? count >= 1
								: count === 1,
					),
			]).toEqual([id, true]);
			// P128's one open More is shared, so it sits before the first option and is counted in none of them.
			const shared = id === "p128-keys" ? 1 : 0;
			expect([id, section.match(PICTURE)?.length ?? 0]).toEqual([
				id,
				drawn.reduce((sum, count) => sum + count, 0) + shared,
			]);
		}
		// P119's options are rows of stills (checked in its own test), so they draw no picture above.
		expect((block(html, "p119-saved").match(/<h4 /g) ?? []).length).toBe(3);
		// …and each picture box has something drawn in it, not an empty frame. The boxes don't add up to the
		// labelled pictures (P119's stills have boxes and no label; P120 and P121 put two or three labelled
		// screens in one box), so each proposal's own test above counts its pictures.
		expect(html).not.toMatch(/<div data-screen="picture">\s*<\/div>/);
		expect(DECIDED.length).toBe(91);
		for (const d of DECIDED) {
			expect(html).toContain(d.title.replaceAll("'", "&#39;"));
			expect(html).toContain(d.outcome.replaceAll("'", "&#39;"));
			if (d.issue) expect(html).toContain(`/issues/${d.issue}"`);
		}
	});

	it("lists P118 to P124 as decided, each with its issue and decision 111", () => {
		const shipped: [string, number][] = [
			["P118 ·", 497],
			["P119 ·", 71],
			["P120 ·", 498],
			["P121 ·", 84],
			["P122 ·", 499],
			["P123 ·", 530],
			["P124 ·", 501],
		];
		for (const [prefix, issue] of shipped) {
			const entry = DECIDED.find((d) => d.title.startsWith(prefix));
			expect(entry, prefix).toBeDefined();
			expect(entry?.issue, prefix).toBe(issue);
			expect(entry?.outcome, prefix).toContain("decision 111");
		}
		const firstVisit = DECIDED.find((d) => d.title.startsWith("P124 ·"));
		expect(firstVisit?.outcome).toContain("for the demo only");
		expect(firstVisit?.outcome).toContain(
			"The family's first week is P125 E (#95)",
		);
	});

	it("lists P125 as decided with issue 95, decision 114 and option E, and the demo keeping P124 A", () => {
		const entry = DECIDED.find((d) => d.title.startsWith("P125 ·"));
		expect(entry?.title).toBe("P125 · A new family's first week");
		expect(entry?.issue).toBe(95);
		expect(entry?.outcome).toContain(
			"Option E: until setup is done, Home names the notebook's five strokes",
		);
		expect(entry?.outcome).toContain(
			"link your bank, your pay, your bills, your budgets, and Tally's first night on its own",
		);
		expect(entry?.outcome).toContain("rounded up to the next $10");
		expect(entry?.outcome).toContain("the demo keeps P124 A (decision 114).");
		// P125 sits after P124 (issue 501) and before P126, so the list stays in proposal order.
		expect(DECIDED.at(-12)).toBe(entry);
	});

	it("lists P126 as decided with issue 202, decisions 115 and 116 and option A, between P125 and P127", () => {
		const entry = DECIDED.find((d) => d.title.startsWith("P126 ·"));
		expect(entry?.title).toBe("P126 · The Budget diagram with Planned");
		expect(entry?.issue).toBe(202);
		expect(entry?.outcome).toContain("Option A: the boxes keep today's size");
		expect(entry?.outcome).toContain("decisions 115 and 116");
		expect(DECIDED.at(-11)).toBe(entry);
	});

	it("lists P127 as decided with issue 500, decision 116 and option A, between P126 and P128", () => {
		const entry = DECIDED.find((d) => d.title.startsWith("P127 ·"));
		expect(entry?.title).toBe("P127 · Safe to spend on a small phone");
		expect(entry?.issue).toBe(500);
		expect(entry?.outcome).toContain(
			"Option A: no drawing below 390 px for amounts of 7 characters or fewer",
		);
		expect(entry?.outcome).toContain("640 px for 8 or more characters");
		expect(entry?.outcome).toContain(
			"640 px for 8 or more characters, and the minus stays on its number (decision 116).",
		);
		expect(entry?.outcome).not.toContain("so the minus");
		expect(entry?.outcome).toContain("(decision 116).");
		expect(DECIDED.at(-10)).toBe(entry);
	});

	it("lists P128 as decided with issue 72, decision 118 and option C, before P129", () => {
		const entry = DECIDED.find((d) => d.title.startsWith("P128 ·"));
		expect(entry?.title).toBe("P128 · The keyboard shortcuts list");
		expect(entry?.issue).toBe(72);
		expect(entry?.outcome).toContain("Option C: ? opens the list as a sheet");
		expect(entry?.outcome).toContain("(decision 118).");
		expect(DECIDED.at(-9)).toBe(entry);
	});

	it("lists P129 as decided with issue 80, decision 117 and option A, after P128 and before P130", () => {
		const entry = DECIDED.find((d) => d.title.startsWith("P129 ·"));
		expect(entry?.title).toBe("P129 · The money input, state by state");
		expect(entry?.issue).toBe(80);
		expect(entry?.outcome).toContain(
			"Option A: a muted 0.00 when empty, a check on the chip that matches the box, the steps off while the text can't be read, and five keyboard and screen-reader fixes;",
		);
		expect(entry?.outcome).toContain(
			"the centred layout stays (decision 117).",
		);
		expect(DECIDED.at(-8)).toBe(entry);
	});

	it("keeps P125 to P136 in proposal order, P136 last, so a later decision can't move them", () => {
		const order = [
			"P125 ·",
			"P126 ·",
			"P127 ·",
			"P128 ·",
			"P129 ·",
			"P130 ·",
			"P131 ·",
			"P132 ·",
			"P133 ·",
			"P134 ·",
			"P135 ·",
			"P136 ·",
		].map((prefix) => DECIDED.findIndex((d) => d.title.startsWith(prefix)));
		for (const [i, index] of order.entries()) {
			expect(index, String(i)).toBeGreaterThan(-1);
			if (i > 0) expect(index, String(i)).toBeGreaterThan(order[i - 1] ?? -1);
		}
	});

	it("lists P134 and P135 as decided with issues 606 and 607, decision 120 and option A", () => {
		const settings = DECIDED.find((d) => d.title === "P134 · Settings");
		expect(settings?.issue).toBe(606);
		expect(settings?.outcome).toContain(
			"Option A: Settings becomes a short contents page",
		);
		expect(settings?.outcome).toContain("(decision 120).");
		const suggestions = DECIDED.find(
			(d) => d.title === "P135 · Category suggestions",
		);
		expect(suggestions?.issue).toBe(607);
		expect(suggestions?.outcome).toContain(
			"Create Pet Care or No, where No retires the suggestion and asks “Don't suggest Pet Care again?”;",
		);
		expect(suggestions?.outcome).toContain("(decision 120).");
	});

	it("lists P136 as decided with issue 602, decision 122 and option A, last in the list", () => {
		const entry = DECIDED.find((d) => d.title.startsWith("P136 ·"));
		expect(entry?.title).toBe("P136 · What Bills' section totals count");
		expect(entry?.issue).toBe(602);
		expect(entry?.outcome).toContain("Option A: each status heading's total");
		expect(entry?.outcome).toContain("(decision 122).");
		expect(entry?.outcome).toContain(
			"“Includes Daycare's Fridays on Oct 2 and 9”",
		);
		expect(entry?.outcome).toContain(
			"up to two bills by name, then “and N more”",
		);
		expect(DECIDED.at(-1)).toBe(entry);
	});

	it("draws decision 89 in P117 and links the replaced P90 rule to it", async () => {
		const { html } = await get("/design-system/proposals");
		const start = html.indexOf('<section id="p117-');
		expect(start).toBeGreaterThan(-1);
		const next = html.indexOf('<section id="p', start + 1);
		const p117 = html.slice(start, next === -1 ? undefined : next);
		const option = (name: string) => {
			const heads = [...p117.matchAll(/<h4 /g)].map((m) => m.index ?? 0);
			const at = heads.find((i) => p117.slice(i, i + 400).includes(`>${name}`));
			expect(at, name).toBeDefined();
			const end = heads.find((i) => i > (at ?? 0));
			return p117.slice(at, end);
		};
		const picture = (chunk: string) => {
			const at = chunk.indexOf('data-screen="picture"');
			expect(at).toBeGreaterThan(-1);
			return chunk.slice(at);
		};
		const oneThing = picture(option("Option A · One thing"));
		expect(oneThing).toContain("$82.17");
		expect(oneThing).toContain("Maybe Groceries");
		expect(oneThing).not.toContain("Split this one?");
		const mixed = picture(option("Option A, next · Mixed trip"));
		expect(mixed).toContain("Costco trips go in Groceries and Household.");
		expect(mixed).toContain("Split this one?");
		const split = picture(option("Option A, next · The split"));
		expect(split).toContain("$214.36 left to assign");
		expect(split).toContain(
			"Tally&#39;s guess: Groceries and Household from this trip&#39;s details",
		);
		expect(split).toContain("border-dashed border-ink");
		expect(split).toContain('name="part_amount" type="text" value=""');
		const p90Start = html.indexOf('<section id="p90-');
		const p90End = html.indexOf('<section id="p', p90Start + 1);
		expect(html.slice(p90Start, p90End)).toContain(
			'href="#p117-when-split-this-one"',
		);
		const p90 = DECIDED.find((entry) => entry.title.startsWith("P90 ·"));
		expect(p90?.outcome).not.toContain("from the last 3 months");
		expect(p90?.outcome).not.toContain("on every trip there");
		expect(p90?.outcome).not.toContain("most-used categories fill in");
		expect(p90?.outcome).toMatch(/P117|decision 89/);
		const p117Decision = DECIDED.find((entry) =>
			entry.title.startsWith("P117 ·"),
		);
		expect(p117Decision?.issue).toBe(233);
		expect(html).not.toContain("Its issue is written when it's built.");
	});

	it("uses unique IDs throughout the proposals page", async () => {
		const { html } = await get("/design-system/proposals");
		const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(
			(match) => match[1] ?? "",
		);
		const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
		expect(duplicates).toEqual([
			"p27-file",
			"p27-file-hint",
			"p27-note",
			"select-1-name",
			"select-2-name",
			"select-3-name",
		]);
		expect(duplicates).not.toContain("p90-suggested-split-line");
		expect(duplicates).not.toContain("p90-filled-split-line-kept");
		expect(duplicates).not.toContain("p117-split-line");
		const idsByValue = new Map<string, number>();
		for (const id of ids) idsByValue.set(id, (idsByValue.get(id) ?? 0) + 1);
		const knownOtherPageDuplicates = new Set(duplicates);
		for (const [, labelFor] of html.matchAll(/\sfor="([^"]+)"/g)) {
			const id = labelFor ?? "";
			if (knownOtherPageDuplicates.has(id)) continue;
			expect(idsByValue.get(id)).toBe(1);
		}
	});

	it("draws a $0 budget and a far-over category without breaking the bars", async () => {
		const { html } = await get("/design-system/proposals");
		expect(html).not.toMatch(/NaN|Infinity/);
		// The $0-budget category is in the chart's text alternative, and its bar is drawn as over.
		expect(html).toContain("Gifts $45 of $0");
		expect(html).toContain("+$45");
		expect(html).toContain("+$650");
	});

	it("keeps a finished month's bar height finite and capped", () => {
		const cap = 1.25;
		expect(endBarRatio(4500, 0)).toEqual({ ratio: cap, capped: true });
		expect(endBarRatio(0, 0)).toEqual({ ratio: 0, capped: false });
		expect(endBarRatio(-2000, 25000)).toEqual({ ratio: 0, capped: false });
		expect(endBarRatio(90000, 25000)).toEqual({ ratio: cap, capped: true });
		const over = endBarRatio(28600, 25000);
		expect(over.capped).toBe(false);
		expect(over.ratio).toBeCloseTo(1.144, 6);
		expect(endBarRatio(19200, 20000).ratio).toBeCloseTo(0.96, 6);
	});

	it("draws the owner's four polish picks (P110–P113, decision 84) as the app now words them", async () => {
		const { html } = await get("/design-system/proposals");
		const section = (id: string) => {
			const start = html.indexOf(`<section id="${id}"`);
			expect(start).toBeGreaterThan(-1);
			const next = html.indexOf('<section id="p', start + 1);
			return html.slice(start, next === -1 ? undefined : next);
		};
		// One option's heading and picture, up to the next option's heading.
		const option = (sectionHtml: string, name: string) => {
			const heads = [...sectionHtml.matchAll(/<h4 /g)].map((m) => m.index ?? 0);
			const at = heads.find((i) =>
				sectionHtml.slice(i, i + 400).includes(`>${name}`),
			);
			expect(at, name).toBeDefined();
			const next = heads.find((i) => i > (at ?? 0));
			return sectionHtml.slice(at, next);
		};
		const picked = (chunk: string) => chunk.includes(">Picked<");

		// P110: More without Documents is picked; today's More lists it and leads to a page that isn't built.
		const p110 = section("p110-documents-menu");
		const p110a = option(p110, "Option A · ");
		expect(picked(p110a)).toBe(true);
		expect(p110a).toContain(">Accounts<");
		expect(p110a).toContain(">How Tally works<");
		expect(p110a).not.toContain(">Documents<");
		const p110b = option(p110, "Option B · ");
		expect(picked(p110b)).toBe(false);
		expect(p110b).toContain(">Documents<");
		expect(option(p110, "Option B, next · ")).toContain(
			"This part of Tally isn&#39;t built yet.",
		);
		expect(p110).toContain("decision 84");

		// P111: B (the question) and D (the toast's Undo) are picked; the others aren't.
		const p111 = section("p111-delete-cash");
		const question = "Delete Farmers market, $20.00? This can&#39;t be undone.";
		const today = option(p111, "Today · ");
		expect(picked(today)).toBe(false);
		expect(today).toContain("Delete this cash entry?");
		expect(today).toContain(">Save<");
		const p111a = option(p111, "Option A · ");
		expect(picked(p111a)).toBe(false);
		expect(p111a).toContain("Delete this cash entry?");
		const p111b = option(p111, "Option B · ");
		expect(picked(p111b)).toBe(true);
		expect(p111b).toContain(question);
		expect(p111b).toContain(">Delete<");
		expect(p111b).toContain(">Keep it<");
		// The question takes the place of Cancel and Save.
		expect(p111b).not.toContain(">Save<");
		expect(p111b).not.toContain(">Cancel<");
		const p111c = option(p111, "Option C · ");
		expect(picked(p111c)).toBe(false);
		expect(p111c).toContain("Delete Farmers market, $20.00?");
		const p111d = option(p111, "Option D · ");
		expect(picked(p111d)).toBe(true);
		expect(p111d).toContain("Deleted Farmers market, $20.00.");
		expect(p111d).toContain(">Undo<");
		const p111e = option(p111, "Option E · ");
		expect(picked(p111e)).toBe(false);
		expect(p111e).toContain("bg-over");
		expect(p111).toContain("its own issue");

		// P112: with the off line first (picked), it sits right under the title, before the privacy text;
		// today's page puts it after.
		const p112 = section("p112-demo-feedback");
		const off =
			"Feedback is off in the demo. Sign in to your Tally to send it.";
		const privacy = "Before a new report is sent";
		const p112a = option(p112, "Option A · ");
		expect(picked(p112a)).toBe(true);
		expect(p112a.indexOf(off)).toBeGreaterThan(-1);
		expect(p112a.indexOf(off)).toBeLessThan(p112a.indexOf(privacy));
		const p112b = option(p112, "Option B · ");
		expect(picked(p112b)).toBe(false);
		expect(p112b.indexOf(off)).toBeGreaterThan(p112b.indexOf(privacy));

		// P113: the link under the status sentence (picked) goes to Bills' section; today's has none.
		const p113 = section("p113-bills-how-link");
		const p113a = option(p113, "Option A · ");
		expect(picked(p113a)).toBe(true);
		expect(p113a).toContain('href="/how-it-works#bills"');
		expect(p113a).toContain('aria-label="How this works: bills"');
		const p113b = option(p113, "Option B · ");
		expect(picked(p113b)).toBe(false);
		// Its headings' Why? links (decision 99, #341) go to the same section; only the HowLink is left out here.
		expect(p113b).not.toContain('aria-label="How this works: bills"');
	});

	it("draws the owner's picks on Q60–Q62 (P114–P116, decision 85) as the app will have them", async () => {
		const { html } = await get("/design-system/proposals");
		const section = (id: string) => {
			const start = html.indexOf(`<section id="${id}"`);
			expect(start).toBeGreaterThan(-1);
			const next = html.indexOf('<section id="p', start + 1);
			return html.slice(start, next === -1 ? undefined : next);
		};
		const option = (sectionHtml: string, name: string) => {
			const heads = [...sectionHtml.matchAll(/<h4 /g)].map((m) => m.index ?? 0);
			const at = heads.find((i) =>
				sectionHtml.slice(i, i + 400).includes(`>${name}`),
			);
			expect(at, name).toBeDefined();
			const next = heads.find((i) => i > (at ?? 0));
			return sectionHtml.slice(at, next);
		};
		const picked = (chunk: string) => chunk.includes(">Picked<");
		const recommended = (chunk: string) => chunk.includes(">Recommended<");
		// An option's picture alone. The heading and note above it quote the very words asserted
		// below, so asserting on the whole option would pass with the picture changed or emptied.
		const picture = (chunk: string) => {
			const at = chunk.indexOf('data-screen="picture"');
			expect(at).toBeGreaterThan(-1);
			return chunk.slice(at);
		};
		const cant = "This can&#39;t be undone.";

		// P114: once Undo ships, the sheet asks only the question; Delete and Keep it are its answers.
		const p114 = section("p114-delete-wording");
		const p114a = option(p114, "Option A · Just the question");
		expect(picked(p114a) && recommended(p114a)).toBe(true);
		const p114aPicture = picture(p114a);
		expect(p114aPicture).toContain(">Delete Farmers market, $20.00?</p>");
		expect(p114aPicture).not.toContain(cant);
		expect(p114aPicture).not.toContain("undo it");
		expect(p114aPicture).toContain(">Delete<");
		expect(p114aPicture).toContain(">Keep it<");
		const p114b = option(p114, "Option B · ");
		expect(picked(p114b)).toBe(false);
		expect(picture(p114b)).toContain(
			`>Delete Farmers market, $20.00? ${cant}</p>`,
		);
		const p114c = option(p114, "Option C · ");
		expect(picked(p114c)).toBe(false);
		expect(picture(p114c)).toContain(
			">Delete Farmers market, $20.00? You can undo it for 10 seconds.</p>",
		);
		expect(picture(p114c)).not.toContain(cant);
		expect(p114).toContain("decision 85");

		// P115: the money box in the 12px control corner (picked); B keeps the 8px it had. Date and
		// Where are in both pictures and use rounded-control, so the money box is found by its own
		// markup: its box by its fixed size, its cent arrows by their outer corners.
		const p115 = section("p115-money-corners");
		const box = (pic: string) =>
			pic.match(/<div class="([^"]*min-h-\[90px\][^"]*)"/)?.[1] ?? "";
		const p115a = option(p115, "Option A · ");
		expect(picked(p115a) && recommended(p115a)).toBe(true);
		const p115aPicture = picture(p115a);
		expect(p115aPicture).toContain("data-money");
		expect(box(p115aPicture)).toContain("rounded-control");
		expect(p115aPicture).toContain("rounded-tr-control");
		expect(p115aPicture).toContain("rounded-br-control");
		expect(p115aPicture).not.toContain("rounded-lg");
		expect(p115aPicture).not.toContain("rounded-tr-lg");
		const p115b = option(p115, "Option B · ");
		expect(picked(p115b)).toBe(false);
		const p115bPicture = picture(p115b);
		expect(p115bPicture).toContain("data-money");
		// B's wrapper turns all three of the money box's corners back to 8px, and only those.
		for (const [control, eight] of [
			["rounded-control", "rounded-lg"],
			["rounded-tr-control", "rounded-tr-lg"],
			["rounded-br-control", "rounded-br-lg"],
		] as const)
			expect(p115bPicture).toContain(
				`[&amp;_[data-money]_.${control}]:${eight}`,
			);
		expect(p115).toContain("decision 85");
		// The two pictures draw the same form twice: no id may repeat, or a label would point at the
		// other picture's field.
		const p115Ids = [...p115.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
		expect(p115Ids.length).toBeGreaterThan(2);
		expect(new Set(p115Ids).size).toBe(p115Ids.length);
		for (const pic of [p115aPicture, p115bPicture])
			for (const [, target] of pic.matchAll(/<label for="([^"]+)"/g))
				expect(pic).toContain(` id="${target}"`);

		// P116: the budget sheet with a second chip, the 3-month average (picked), or Last month alone.
		const p116 = section("p116-budget-average");
		const p116a = option(p116, "Option A · ");
		expect(picked(p116a)).toBe(false);
		const p116aPicture = picture(p116a);
		expect(p116aPicture).toContain("Last month: $");
		expect(p116aPicture).not.toContain("3-month average");
		const p116b = option(p116, "Option B · ");
		expect(picked(p116b) && recommended(p116b)).toBe(true);
		const p116bPicture = picture(p116b);
		expect(p116bPicture).toContain("Last month: $");
		expect(p116bPicture).toContain("3-month average: $650.00");
		// Like the real chips, the average hides without JavaScript (money.js runs the chips).
		expect(p116bPicture).toMatch(
			/<div data-money-js[^>]*>\s*<button[^>]*>3-month average: \$650\.00/,
		);
		expect(p116).toContain("decision 85");
	});

	it("says Resend sends the reconnect email first, with Cloudflare's own as the fallback and nothing to confirm (decision 86)", async () => {
		const { html } = await get("/design-system/proposals");
		const section = (id: string) => {
			const start = html.indexOf(`<section id="${id}"`);
			expect(start).toBeGreaterThan(-1);
			const next = html.indexOf('<section id="p', start + 1);
			return html.slice(start, next === -1 ? undefined : next);
		};
		// P107: the old rule, that each address must be verified in Cloudflare Email Routing, is gone.
		const p107 = section("p107-email-settings");
		expect(p107).not.toContain("Email Routing");
		expect(p107).not.toContain("verified in Cloudflare");
		expect(p107).toContain("nothing to confirm");
		expect(p107).toContain("decision 86");
		// P109: Resend is first, through plain fetch, with Cloudflare's email as the fallback.
		const p109 = section("p109-email");
		expect(p109).toContain("Resend");
		expect(p109).toContain("plain fetch");
		expect(p109).toContain("fallback");
		expect(p109).toContain("decision 86");
		// P56 (the older picture) no longer says Cloudflare's email is first.
		const p56 = section("p56-reconnect-email");
		expect(p56).not.toContain("with Resend as a fallback");
		expect(p56).toContain("decision 86");
		// The decided list says it too.
		const decided = DECIDED.find((d) => d.title.startsWith("P107–P109"));
		expect(decided?.outcome).toContain("Resend");
		expect(decided?.outcome).toContain("decision 86");
	});

	it("draws P75's Today pictures round, so the comparison still shows once the squircle rule ships", async () => {
		const { html } = await get("/design-system/proposals");
		const start = html.indexOf('<section id="p75-corners"');
		expect(start).toBeGreaterThan(-1);
		const next = html.indexOf('<section id="p', start + 1);
		const p75 = html.slice(start, next === -1 ? undefined : next);
		// corner-shape isn't inherited, so every part inside a Today picture is forced round, and the
		// rule in app.css (which sits below Tailwind's utilities) can't turn any of them back on.
		const round = "[&amp;_*]:[corner-shape:round]";
		const squircle = "[corner-shape:squircle]";
		// From a marker to the next one: an option's heading, or a close-up's label.
		const between = (from: string, to: string | undefined) => {
			const at = p75.indexOf(from);
			expect(at, from).toBeGreaterThan(-1);
			const end = to ? p75.indexOf(to, at + 1) : -1;
			return p75.slice(at, end === -1 ? undefined : end);
		};
		const todayPicture = between("Today · Round corners", "Option A · ");
		expect(todayPicture).toContain(round);
		expect(todayPicture).not.toContain(squircle);
		// A turns it on itself: squircles on everything with a token radius.
		const aPicture = between("Option A · Squircles everywhere", "Option B · ");
		expect(aPicture).toContain(squircle);
		expect(aPicture).not.toContain("corner-shape:round");
		// B keeps the field round while the buttons and the sheet are squircles.
		const bPicture = between(
			"Option B · Squircles on",
			"Today and A, side by side",
		);
		expect(bPicture).toContain(round);
		expect(bPicture).toContain(squircle);
		// The close-up's Today is forced round too, and its A is not.
		const todayCloseUp = between(
			'aria-label="Today · Round corners, close up"',
			'aria-label="Option A · Squircles everywhere, close up"',
		);
		expect(todayCloseUp).toContain(round);
		expect(todayCloseUp).not.toContain(squircle);
		const aCloseUp = between(
			'aria-label="Option A · Squircles everywhere, close up"',
			undefined,
		);
		expect(aCloseUp).toContain(squircle);
		expect(aCloseUp).not.toContain("corner-shape:round");
		// The picked line stays in the decided list, and the money box is no longer waiting for #80.
		expect(DECIDED.some((d) => d.title.startsWith("P75 "))).toBe(true);
		expect(p75).not.toContain("when #80 settles");
		expect(p75).toContain("decision 85");
	});

	it("keeps every form, htmx request (as htmx 4 lists them), hx-boost, formaction and submit button inside an inert element, and draws no hx-trigger or hx-on that could fire without a press, so no drawn bill can post an unlink or swap a #page this page lacks (#448)", async () => {
		const { html } = await get("/design-system/proposals");
		const found = actions(html);
		// The bill drawings' Not this one forms (the issue's case) must be among them, so the loop below can't pass by finding none.
		expect(found.some((a) => a.raw.includes("/unlink"))).toBe(true);
		// inert, not hx-ignore: a native form post still runs under hx-ignore, and the catalog CSP's form-action 'none'
		// covers this page too but doesn't stop htmx's own request. Only inert stops both. inert stops a press or a submit,
		// both native and htmx; it doesn't stop a trigger that fires by itself or an hx-on handler, so the page has none of those.
		for (const action of found) expect(action.inert, action.raw).toBe(true);
		expect(firesByItself(html)).toEqual([]);
		// The prefix the test assumes is htmx's own default, so the page's htmx-config meta must not override it.
		const config = [...html.matchAll(/<meta\b[^>]*>/gi)]
			.map((m) => m[0])
			.find((raw) => attributes(raw).get("name") === "htmx-config");
		expect(config).toBeDefined();
		const content = config ? attributes(config).get("content") : undefined;
		expect(content).toBeDefined();
		expect(content).not.toContain("prefix");
		// A button with no type submits a form it sits in, so every button declares one and the walk above sees it.
		const buttons = [...html.matchAll(/<button\b[^>]*>/gi)].map(
			(m) => m[0] ?? "",
		);
		expect(buttons.filter((raw) => !attributes(raw).has("type"))).toEqual([]);
	});

	it("marks the owner's picks for P118 to P125 (decisions 111 and 114): each picked option carries the Picked pill, its desktop drawing too where it has one, and no other option does", async () => {
		const { html } = await get("/design-system/proposals");
		const picks = (id: string) => {
			const start = html.indexOf(`<section id="${id}"`);
			expect(start, id).toBeGreaterThan(-1);
			const next = html.indexOf('<section id="p', start + 1);
			return optionPicks(html.slice(start, next < 0 ? undefined : next))
				.filter((option) => option.picked)
				.map((option) => option.name);
		};
		expect(picks("p118-rows")).toEqual([
			"A · Quiet chevron",
			"Desktop · A · Quiet chevron",
		]);
		expect(picks("p119-saved")).toEqual(["A · Auditor&#39;s tick"]);
		expect(picks("p120-panel")).toEqual([
			"B · Category leads, folds when set",
			"At 1280: B · Category leads, folds when set",
		]);
		expect(picks("p121-header")).toEqual([
			"A · Filters fold away",
			"At 1280: A · Filters fold away",
		]);
		expect(picks("p122-more")).toEqual(["Option A · Contents page"]);
		expect(picks("p123-feedback")).toEqual(["Option A · In the top line"]);
		expect(picks("p124-first-visit")).toEqual(["Option A · The first page"]);
		expect(picks("p125-first-week")).toEqual([
			"Option E · The notebook, one question at a time",
		]);
	});

	describe("P118 and P119 · the polish track, picked (#497, #71, decision 111)", () => {
		it("opens the page with its own section, ahead of the polish pass's picks", async () => {
			const { html } = await get("/design-system/proposals");
			const open = html.indexOf('<section aria-labelledby="polish2-title"');
			expect(open).toBeGreaterThan(-1);
			expect(open).toBeLessThan(
				html.indexOf('<section aria-labelledby="polish-title"'),
			);
			expect(html).toContain('id="polish2-title"');
			expect(html).toContain("Picked: the polish track, rows and saves");
			expect(html).toContain(
				"Drawn Oct 13. The owner&#39;s picks, marked Picked, are decision 111: how a row shows it opens, and how the row you just saved shows it changed.",
			);
		});

		it("draws P118's options: today's rows as the real components, and each option a copy that changes only its own part", async () => {
			const { html } = await get("/design-system/proposals");
			const p118 = block(html, "p118-rows");
			expect(p118).toContain("P118 · How a row shows it opens");
			expect(p118).not.toContain("how loud Needs category is");
			expect(p118).toContain("rows open their sheet (decisions 38, 80)");
			expect(p118).toContain(
				"In both options, the filled pill becomes quiet words beside the bank text.",
			);
			// Today: the real TransactionRow as the app draws it now (A is built: the arrow, Needs category in words) and ProgressRow (its brick bar).
			const today = optionOf(p118, "Today (current)");
			expect(today).toContain('data-transaction="2005"');
			expect(today).not.toContain("bg-band px-2 text-sm text-ink");
			expect(today).toContain("fill-over");
			expect(today).toContain('data-icon="chevron-right"');
			expect(today).not.toContain("bg-press");
			// A: a chevron after each amount, the words in muted, and no press (the press is the pressed group's alone).
			const quiet = optionOf(p118, "A · Quiet chevron");
			expect(quiet).toContain('data-icon="chevron-right"');
			// Needs category is quiet words, never cut off, then one space each side of the dot and the bank text.
			expect(quiet).toContain(
				'<span class="shrink-0 text-muted">Needs category</span>',
			);
			expect(quiet).toContain(" · DD *DOORDASH TACO");
			expect(quiet).not.toContain("bg-band px-2 text-sm text-ink");
			expect(quiet).not.toContain("bg-press");
			expect(quiet).toContain(">Recommended<");
			expect(quiet).toContain(
				"Every row that opens ends in the same small muted arrow Settings already uses.",
			);
			// The budget chevron sits on the name's line, Eating Out included.
			expect(quiet).toContain("self-start mt-1 size-5 shrink-0 -ml-3 -mr-2");
			expect(quiet).not.toContain("self-center");
			expect(p118).not.toContain("Ledger line");
			expect(p118).not.toContain("font-serif italic");
			// B · Say it once: no arrows on rows; the words muted; one plain sentence above each list.
			const say = optionOf(p118, "B · Say it once");
			expect(say).toContain(
				'<p class="pb-2 text-sm text-muted">Choose a transaction to change it.</p>',
			);
			expect(say).toContain(
				'<p class="mt-1 text-sm text-muted">Choose a budget to change it.</p>',
			);
			expect(say).not.toContain('data-icon="chevron-right"');
			expect(say).toContain(
				'<span class="shrink-0 text-muted">Needs category</span>',
			);
			expect(say).not.toContain("bg-press");
			// Each option that changes the row says why, and only A is recommended.
			expect(p118.match(/>Recommended</g)?.length).toBe(1);
			expect(p118.match(/text-muted">Why: /g)?.length).toBe(2);
			// A quiet Home screen label sits in a dashed rule, above the budget part, in each frame.
			expect(p118.match(/border-t border-dashed border-rule/g)?.length).toBe(3);
			expect(p118).toContain('<p class="text-sm text-muted">Home</p>');
		});

		it("draws P118's desktop pair and its pressed group (the press, the tick and Select mode's tick)", async () => {
			const { html } = await get("/design-system/proposals");
			const p118 = block(html, "p118-rows");
			expect(optionOf(p118, "Desktop · Today (current)")).toContain(
				"w-[722px]",
			);
			const desktopA = optionOf(p118, "Desktop · A · Quiet chevron");
			expect(desktopA).toContain('data-icon="chevron-right"');
			expect(desktopA).not.toContain("bg-press");
			expect(optionOf(p118, "Today, pressed")).not.toContain("bg-press");
			expect(optionOf(p118, "A, pressed")).toContain("bg-press");
			// The press tint is drawn only in the pressed group: one held row.
			expect(p118.match(/bg-press/g)?.length).toBe(1);
			const select = optionOf(p118, "Select mode, Local Bakery ticked");
			expect(select).toContain("peer-checked:border-ink");
			expect(select).toContain("checked");
			expect(select).not.toContain('data-icon="chevron-right"');
		});

		it("draws P119's saved-row stills for each option (0 s, 1 s, the end, a replay or a keyboard ring, and the Home still), with the words each toast says", async () => {
			const { html } = await get("/design-system/proposals");
			const p119 = block(html, "p119-saved");
			expect(p119).toContain(
				"P119 · How the row you just saved shows it changed",
			);
			expect(p119).toContain("Saved Local Bakery");
			expect(p119).toContain("Eating Out");
			expect(p119).toContain("$12.00");
			expect(p119).toContain("Saved the Groceries budget");
			expect(p119).toContain("$395 of $650");
			const today = optionOf(p119, "Today (current)");
			expect(today).toContain("outline-accent");
			expect(today).not.toContain("proposal-saved");
			expect(today).not.toContain("bg-press");
			expect(today).not.toContain("self-center");
			// The tick: a filled, tapered mark (no stroke), drawn from the left, short at 0 s, in a box turned −8°.
			const tick = optionOf(p119, "A · Auditor&#39;s tick");
			expect(tick).not.toContain("bg-press");
			expect(tick).not.toContain("self-center");
			expect(tick).toContain("proposal-saved-tick");
			expect(tick).toContain("proposal-saved-chevron");
			expect(tick).toContain("proposal-saved-toast");
			expect(tick).toContain("proposal-saved-loop");
			expect(tick).toContain("[clip-path:inset(0_63%_0_0)]");
			expect(tick).toContain("-rotate-[8deg]");
			expect(tick).toContain(
				'd="M3.59 13.65L8.98 18.66L19.88 5.53L19.12 4.87L8.93 16.27L5.41 11.95Z"',
			);
			expect(tick).not.toContain("stroke-dasharray");
			expect(tick).toContain(">Recommended<");
			expect(tick).toContain(
				"One new drawn mark; the row&#39;s arrow is hidden while the toast is up.",
			);
			expect(tick).toContain(
				"Motion, not illustration: a 150 ms confirmation, so the tally mark still appears once per screen.",
			);
			expect(tick).toContain(
				"The toast and the announcer carry the words, so the mark is never the only sign.",
			);
			expect(tick).toContain(
				"It sits where P118 A&#39;s arrow is, so it pairs with it.",
			);
			expect(tick).toContain(
				"Keyboard: the focus ring as today, plus the tick.",
			);
			expect(tick).toContain(
				"If the row leaves a filtered list: the toast only; focus goes to the result count.",
			);
			expect(tick).toContain("Desktop: the same, beside the open edit panel.");
			// B · Let go: the saved row fills with the press tint, held and then faded, on the quiet rows.
			const letGo = optionOf(p119, "B · Let go");
			expect(letGo).toContain("proposal-saved-press");
			expect(letGo).toContain("bg-press");
			expect(letGo).toContain(
				"The row stays pressed for a moment after the sheet closes, then fades.",
			);
			expect(letGo).toContain("A new 1.3-second hold.");
			expect(letGo).toContain(
				"Keyboard: the focus ring as today, plus the press.",
			);
			expect(letGo).toContain('data-icon="chevron-right"');
			expect(p119).not.toContain("Ruled off");
			expect(p119).not.toContain("proposal-saved-rule");
			expect(p119).not.toContain("proposal-saved-band");
			// Each option is three stills, a fourth (replay or keyboard) and the Home still.
			for (const name of [
				"Today (current)",
				"A · Auditor&#39;s tick",
				"B · Let go",
			])
				expect(
					optionOf(p119, name).match(/role="img" aria-label="/g)?.length,
					name,
				).toBe(5);
			// Each option says why, and only A is recommended.
			expect(p119.match(/>Recommended</g)?.length).toBe(1);
			expect(p119.match(/text-muted">Why: /g)?.length).toBe(2);
			// The demo's Band totals after matching: 10 need a category and $211, not 12 and $228.
			expect(p119).toContain("$211 of this month&#39;s spending");
			expect(p119).toMatch(
				/10(<span class="sr-only"> transactions<\/span>)? need a category/,
			);
			expect(p119).not.toContain("$228");
			expect(p119).not.toContain("12 transactions need a category");
		});

		it("draws the real tab bar in every P119 still, with the toast 12px above it and the crops sized so no drawn row sits under a toast (decision 101)", async () => {
			const { html } = await get("/design-system/proposals");
			const p119 = block(html, "p119-saved");
			// Fifteen stills (three options of four crops, and three Home stills), each with BottomTabs drawn inert.
			expect(p119.match(/<nav /g)?.length).toBe(15);
			expect(
				p119.match(
					/<div inert="" class="absolute inset-x-0 bottom-0 \[&amp;_nav\]:static \[&amp;_nav\]:block"><nav /g,
				)?.length,
			).toBe(15);
			// The toast sits 12px (0.75rem) above that bar. Twelve stills have one: nine crops and the three Home stills.
			expect(
				p119.match(/bottom-\[calc\(var\(--tabs-height\)\+0\.75rem\)\]/g)
					?.length,
			).toBe(12);
			expect(p119.match(/role="status"/g)?.length).toBe(12);
			// The 4 s still has no toast: each of the three ends a crop without one.
			const stills = p119.split('role="img" aria-label="').slice(1);
			const ends = stills.filter((s) =>
				(s.split('"')[0] ?? "").endsWith("4 seconds, the toast gone"),
			);
			expect(ends.length).toBe(3);
			for (const end of ends) expect(end).not.toContain('role="status"');
			// The 0 s toast is drawn whole: no fade or nudge on any still.
			expect(p119).not.toContain("translate-y-[2px]");
			expect(p119).not.toContain("opacity-75");
			// The Transactions crop is 438px and the Home crop 608px, so no drawn row sits under a toast.
			expect(p119.match(/h-\[438px\]/g)?.length).toBe(12);
			expect(p119.match(/h-\[608px\]/g)?.length).toBe(3);
		});

		it("draws the demo's water bill as City Water, paid Water bill, so the caption never says the word twice", async () => {
			const { html } = await get("/design-system/proposals");
			expect(html).toContain("City Water");
			expect(html).toContain("Household · paid Water bill");
			expect(html).not.toContain("Water bill bill");
			expect(html).not.toContain("Google youtube");
			expect(block(html, "p121-header")).toContain("City Water");
			expect(block(html, "p121-header")).toContain(
				"Household · paid Water bill",
			);
		});
	});

	it("keeps every link and button inside a picture inside an inert element, so a picture has nothing to Tab to (#95)", async () => {
		const { html } = await get("/design-system/proposals");
		expect(reachableInPictures(html)).toEqual([]);
	});

	it("opens the page with the picked polish choices P122–P124 (issues #499, #95 and #501): each option named and drawn, A recommended and picked, the demo's first visit only", async () => {
		const { html } = await get("/design-system/proposals");
		// The new section comes first, above the Picked polish pass, and says what it is for.
		const first = html.indexOf('<section aria-labelledby="polish4-title"');
		expect(first).toBeGreaterThan(-1);
		expect(first).toBeLessThan(
			html.indexOf('<section aria-labelledby="polish-title"'),
		);
		expect(html).toContain(
			'<h2 id="polish4-title" class="font-serif text-3xl font-semibold">Picked: the polish track, More, Feedback and the first visit</h2>',
		);
		expect(html).toContain(
			"Drawn Oct 13. The owner&#39;s picks, marked Picked, are decision 111: what More shows, where Feedback lives, and what a first visit shows and teaches.",
		);
		// P124 A is the pick for the demo's first visit; the family's first week is P125 E (decision 114).
		expect(html).toContain(
			"P124 A is picked for the demo&#39;s first visit; the family&#39;s first week is P125 E.",
		);
		const section = (id: string) => {
			const start = html.indexOf(`<section id="${id}"`);
			expect(start, id).toBeGreaterThan(-1);
			const next = html.indexOf('<section id="p', start + 1);
			return html.slice(start, next === -1 ? undefined : next);
		};
		const names = (chunk: string) =>
			[...chunk.matchAll(/<h4 [^>]*>([^<]*)/g)].map((m) => m[1] ?? "");
		const pictures = (chunk: string) =>
			chunk.match(/role="img" aria-label="[^"]*, on (a phone|desktop)"/g) ?? [];
		const option = (chunk: string, name: string) => {
			const heads = [...chunk.matchAll(/<h4 /g)].map((m) => m.index ?? 0);
			const at = heads.find((i) =>
				chunk.slice(i, i + 300).includes(`>${name}`),
			);
			expect(at, name).toBeDefined();
			const end = heads.find((i) => i > (at ?? 0));
			return chunk.slice(at, end);
		};

		const more = section("p122-more");
		expect(names(more)).toEqual([
			"Today (current)",
			"Option A · Contents page",
			"Option B · Plain index",
		]);
		expect(option(more, "Option A · Contents page")).toContain(">Recommended<");
		expect(more.match(/>Recommended</g)?.length).toBe(1);
		// Each place with its icon, what it holds, and a count that says when it needs you.
		for (const text of [
			"3 accounts",
			"3 to check",
			"Needs attention",
			"None linked yet",
			"Balances, net worth and your banks",
			"Categories, rules, your household and your data",
			"What each number means, with the Riveras&#39; numbers",
			"Tally demo · resets every night",
			"Trade-off: Two small live counts on More.",
			"Calm and clear; matches the sidebar.",
		])
			expect(more, text).toContain(text);
		expect(pictures(more)).toHaveLength(5);
		// Each option's own pictures: Today one, A three (the Accounts entry with a bank to sign in, and before a bank), B one.
		const drawnBy = (chunk: string, name: string) =>
			pictures(option(chunk, name)).length;
		expect(drawnBy(more, "Today (current)")).toBe(1);
		expect(drawnBy(more, "Option A · Contents page")).toBe(3);
		expect(drawnBy(more, "Option B · Plain index")).toBe(1);
		// Before a bank is linked, Accounts says so in muted words with no alert icon: the alert is Needs attention's alone.
		const bankless = option(more, "Option A · Contents page");
		const beforeBankAt = bankless.indexOf(
			'aria-label="Option A, before a bank is linked, on a phone"',
		);
		expect(beforeBankAt).toBeGreaterThan(-1);
		const beforeBank = bankless.slice(beforeBankAt);
		expect(beforeBank).toContain("None linked yet");
		expect(beforeBank).not.toContain('data-icon="alert"');
		expect(beforeBank).not.toContain("text-over");

		const feedback = section("p123-feedback");
		expect(names(feedback)).toEqual([
			"Today (current)",
			"Option A · In the top line",
			"Option B · In More and the sidebar",
		]);
		expect(option(feedback, "Option A · In the top line")).toContain(
			">Recommended<",
		);
		expect(feedback.match(/>Recommended</g)?.length).toBe(1);
		// Today's pill sits over a number and a button; A's sits in the top line and leaves the page alone.
		expect(option(feedback, "Today (current)")).toContain("Childcare");
		expect(option(feedback, "Today (current)")).toContain('href="/feedback"');
		expect(feedback).toContain(
			"Feedback moves to More and the sidebar, one tap from every page.",
		);
		expect(feedback).toContain("Something confusing, broken or missing");
		expect(feedback).toContain("Off in the demo; you can still see the form");
		expect(feedback).toContain("Tell us what happened");
		expect(feedback).toContain("Keeps decision 59&#39;s");
		expect(pictures(feedback)).toHaveLength(11);
		// Today's Home, Settings and desktop; A's and B's four each (A adds the masthead's Home at the top).
		expect(drawnBy(feedback, "Today (current)")).toBe(3);
		expect(drawnBy(feedback, "Option A · In the top line")).toBe(4);
		expect(drawnBy(feedback, "Option B · In More and the sidebar")).toBe(4);

		const firstVisit = section("p124-first-visit");
		expect(names(firstVisit)).toEqual([
			"Today (current)",
			"Option A · The first page",
			"Option B · One next step",
			"Option C · The page total",
		]);
		expect(option(firstVisit, "Option A · The first page")).toContain(
			">Recommended<",
		);
		expect(firstVisit.match(/>Recommended</g)?.length).toBe(1);
		for (const text of [
			"Today (after #519)",
			"A family with no budgets sees −$2,140 in ink, since #519.",
			"−$2,140",
			"Start here",
			"Three lines of 42 so far",
			"ACME CORP PAYROLL",
			"Without Tally, the paycheck and the transfer would both count as spending.",
			"See every line without Tally",
			"Three things to try",
			"Not worked out yet",
			"This fills in once your budgets are set.",
			"86 need a category",
			"Start from September",
			"These budgets add up to $3,840 a month.",
			"Use these budgets",
			"The Riveras&#39; tally",
			"Named 38 stores",
			"Sorted 196 into categories",
			"Set 3 transfers aside",
			"Found 2 paychecks",
			"Your first page",
			"What&#39;s left of October&#39;s budget after its spending so far, bills due and savings.",
			"Everything resets every night, so try anything.",
			"AI helps with names and categories: Jev picks categories today, and Workers AI suggests merchant names today.",
			"The family&#39;s first Home: the figure in ink (today), a dash (B), a blank ledger line (A) or Your first page (C).",
		])
			expect(firstVisit, text).toContain(text);
		// The seeded October count is 42, as test/demo-raw-view.test.ts pins it and P121's drawing shows it.
		expect(firstVisit).not.toContain("of 47");
		// The family's first page is the only one drawn on a desktop, and only for the recommended option.
		expect(
			pictures(firstVisit).filter((p) => p.includes("on desktop")),
		).toHaveLength(1);
		expect(pictures(firstVisit)).toHaveLength(20);
		expect(drawnBy(firstVisit, "Today (current)")).toBe(4);
		expect(drawnBy(firstVisit, "Option A · The first page")).toBe(7);
		expect(drawnBy(firstVisit, "Option B · One next step")).toBe(4);
		expect(drawnBy(firstVisit, "Option C · The page total")).toBe(5);
		// "See every line without Tally" opens the raw view, as the catalog's ViewLinks and Without Tally do.
		expect(option(firstVisit, "Option A · The first page")).toContain(
			'<a href="/transactions?raw=1" class="inline-flex min-h-11 items-center">See every line without Tally</a>',
		);
		expect(firstVisit).not.toContain(
			'href="/transactions" class="inline-flex min-h-11 items-center">See every line without Tally',
		);

		// Each assertion below is scoped to the picture it is about, from its label to the next figure (whose
		// caption, which may name another picture's words, sits before that figure's picture).
		const picture = (chunk: string, label: string) => {
			const start = chunk.indexOf(`aria-label="${label}"`);
			expect(start, label).toBeGreaterThan(-1);
			const end = chunk.indexOf("<figure", start);
			return chunk.slice(start, end === -1 ? undefined : end);
		};
		// The phone's top line: the wordmark's row, from its class to the row's closing tag.
		const masthead = (screen: string) => {
			const start = screen.indexOf(
				"mb-4 flex items-center justify-between gap-3",
			);
			expect(start).toBeGreaterThan(-1);
			return screen.slice(start, screen.indexOf("</div>", start));
		};
		// The desktop sidebar's second group, under its rule: How Tally works and Feedback.
		const secondGroup = (desk: string) => {
			const start = desk.indexOf(
				"mt-3 flex flex-col gap-1 border-t border-rule pt-3",
			);
			expect(start).toBeGreaterThan(-1);
			return desk.slice(start, desk.indexOf("</ul>", start));
		};

		// P122 · More: the contents page's rows, leader and colophon.
		expect(more).toContain(
			"grid min-h-16 grid-cols-[1.5rem_1fr] items-start gap-x-4 py-3",
		);
		expect(more).toContain("border-dotted border-rule");
		expect(more).toContain(
			"mt-10 flex items-center justify-center gap-2 text-sm text-muted",
		);

		// P123 · Today: the pill is drawn over a row's amount on Home and over Move down in Settings.
		expect(
			picture(feedback, "Today (current), Home scrolled, on a phone"),
		).toContain("bottom-[6.5rem]");
		expect(
			picture(feedback, "Today (current), Home scrolled, on a phone"),
		).toContain("Childcare");
		// Childcare's numbers are what the demo seed had when P123 was drawn: a $1,040 budget, and $480 from the two
		// Fridays of October so far (Oct 2 and 9). Since #631 the seed sets $1,200 (decision 123); the picture keeps
		// what the owner saw.
		expect(
			picture(feedback, "Today (current), Home scrolled, on a phone"),
		).toContain("$480 of $1,040");
		// Settings draws Gas's open row in the app's order (category-row.tsx): the Name field, then Save, Cancel and
		// Archive, then Move up and Move down. The pill sits over Move down, so the picture has to reach it.
		const todaySettings = picture(
			feedback,
			"Today (current), Settings, on a phone",
		);
		expect(todaySettings).toContain("bottom-[6.5rem]");
		expect(todaySettings).toContain("3 suggestions to check");
		expect(todaySettings).toContain("$1,040");
		const marks = [
			">Name</label>",
			">Save<",
			">Cancel<",
			">Archive<",
			">Move up<",
			">Move down<",
		].map((mark) => {
			const at = todaySettings.indexOf(mark);
			expect(at, mark).toBeGreaterThan(-1);
			return at;
		});
		expect(marks).toEqual([...marks].sort((a, b) => a - b));
		expect(option(feedback, "Today (current)")).toContain(
			"In Settings it sits over Move down",
		);
		expect(picture(feedback, "Today (current), on desktop")).toContain(
			"bottom-6 right-6",
		);
		// P123 · Option A: the pill sits in the top line of a screen's first phone, and nothing floats.
		const aTop = picture(feedback, "Option A, Home at the top, on a phone");
		expect(masthead(aTop)).toContain('href="/feedback"');
		expect(masthead(aTop)).toContain('aria-label="Tally home"');
		const aSettings = picture(feedback, "Option A, Settings, on a phone");
		expect(masthead(aSettings)).toContain('href="/feedback"');
		const aScrolled = picture(feedback, "Option A, Home scrolled, on a phone");
		expect(aScrolled).not.toContain('href="/feedback"');
		for (const screen of [aTop, aSettings, aScrolled])
			expect(screen).not.toContain("bottom-[6.5rem]");
		// P123 · Options A and B on desktop: the second sidebar group under a rule, and Home's How this works link.
		for (const label of ["Option A, on desktop", "Option B, on desktop"]) {
			const desk = picture(feedback, label);
			expect(secondGroup(desk)).toContain('href="/how-it-works"');
			expect(secondGroup(desk)).toContain("How Tally works");
			expect(secondGroup(desk)).toContain('href="/feedback"');
			expect(secondGroup(desk)).toContain("Feedback");
			expect(desk).toContain("How this works");
			expect(desk).not.toContain("bottom-6 right-6");
		}
		// P123 · Option B: no pill on any phone; Feedback is a row in More.
		for (const label of [
			"Option B, Home scrolled, on a phone",
			"Option B, Settings, on a phone",
		])
			expect(picture(feedback, label)).not.toContain('href="/feedback"');
		expect(picture(feedback, "Option B, More, on a phone")).toContain(
			'href="/feedback"',
		);

		// P124 · Today's family Home is main after #519: the figure in ink with No budgets set yet., no over-budget words.
		const todayFamily = picture(
			firstVisit,
			"Today (current), the family&#39;s Home, on a phone",
		);
		expect(todayFamily).toContain("−$2,140");
		expect(todayFamily).toContain("No budgets set yet.");
		expect(todayFamily).not.toContain("text-over");
		expect(todayFamily).not.toContain("Over budget");

		// P124 · Option A: Start here is the one ink link, and Home's footnote carries How this works.
		const aFirst = picture(firstVisit, "Option A, Home top, on a phone");
		expect(aFirst).toContain(
			'class="inline-flex min-h-11 items-center font-medium text-ink underline underline-offset-4">Start here</a>',
		);
		expect(aFirst).not.toContain("How this works");
		const aFirstVisit = option(firstVisit, "Option A · The first page");
		expect(aFirstVisit).toContain("w-12 border-t border-muted");
		// The bank's line is struck once, in the story; Tally's row under it does not repeat the bank's text.
		expect(aFirstVisit.split("SQ *LOCAL BAKERY 4432").length - 1).toBe(1);
		expect(aFirstVisit).toContain("Local Bakery");
		expect(aFirstVisit).toContain("Needs category");
		// P124 · Option B: How this works is muted and underlined on both Home pictures, and the sheet names its sample.
		const bOption = option(firstVisit, "Option B · One next step");
		expect(bOption).toContain(
			"inline-flex min-h-11 items-center text-sm text-muted underline underline-offset-4",
		);
		const bFamily = picture(
			firstVisit,
			"Option B, the family&#39;s Home, on a phone",
		);
		expect(bFamily).toContain("No budgets set yet.");
		expect(bFamily).toContain("Start your budgets from September");
		expect(bFamily).toContain("Not set yet");
		expect(bFamily).toContain(
			"inline-flex min-h-11 items-center text-sm text-muted underline underline-offset-4",
		);
		const sheet = picture(firstVisit, "Option B, starting budgets, on a phone");
		// The sheet's closing line states the total; the note that five of the 14 are drawn sits in the caption, outside the sheet.
		expect(sheet).toContain("These budgets add up to $3,840 a month.");
		expect(sheet).not.toContain("Drawn with five of the 14 categories.");
		expect(firstVisit).toContain(
			'<figcaption class="text-sm text-muted">Start from September: the sheet the step opens. Drawn with five of the 14 categories.</figcaption>',
		);
		// Money reads as the rest of the page does: "$1,600", not "$1600", in each row's last-month line.
		expect(sheet).toContain("Last month $1,600 · starts at $1,600");
		expect(sheet).not.toMatch(/\$\d{4}\b/);
		// P124 · Option C: How this works is a pencil note, on Home's top and at its foot.
		const cOption = option(firstVisit, "Option C · The page total");
		expect(cOption).toContain("border-l border-muted pl-3 text-sm text-muted");
		expect(cOption).toContain(
			'class="text-muted underline underline-offset-4">How this works</a>',
		);
		// The demo's Band totals after matching: 10 need a category and $211 (decision 82 keeps 12 and $228 on the older proposals).
		for (const part of [feedback, firstVisit]) {
			expect(part).toContain("10 need a category");
			expect(part).toContain("$211 of this month&#39;s spending");
			expect(part).not.toContain("12 need a category");
			expect(part).not.toContain("$228");
		}
		expect(
			picture(firstVisit, "Today (current), Home top, on a phone"),
		).toContain("10 need a category");
		expect(
			picture(firstVisit, "Today (current), Home top, on a phone"),
		).toContain("$211 of this month&#39;s spending");
		// P124 A's story names the paycheck as the seed does, not by its bank text.
		expect(
			picture(firstVisit, "Option A, How Tally works, the story, on a phone"),
		).toContain("Paycheck, Acme Corp");
		expect(
			picture(firstVisit, "Option A, How Tally works, the story, on a phone"),
		).toContain("Demo data. Nothing here is real.");
		// The page keeps its How Tally works heading above Start here, as the route has it (test/how-it-works-route.test.ts:99).
		const story = picture(
			firstVisit,
			"Option A, How Tally works, the story, on a phone",
		);
		expect(story).toMatch(/<h1[^>]*>How Tally works<\/h1>/);
		expect(story.indexOf("How Tally works</h1>")).toBeLessThan(
			story.indexOf(">Start here</h2>"),
		);
		// The lower shots are drawn as scrolled: no banner and no wordmark, since they are not the top of the page.
		for (const label of [
			"Option A, How Tally works, the total, on a phone",
			"Option C, How it&#39;s built, last, on a phone",
		]) {
			const screen = picture(firstVisit, label);
			expect(screen, label).not.toContain("Demo data. Nothing here is real.");
			expect(screen, label).not.toContain('aria-label="Tally home"');
		}
	});

	it("is linked from the catalog", async () => {
		const { html } = await get("/design-system");
		expect(html).toContain('href="/design-system/proposals"');
	});

	it("doesn't exist in production", async () => {
		const res = await designSystem.request(
			"/design-system/proposals",
			{},
			notDemo,
		);
		expect(res.status).toBe(404);
	});
});

describe("P126 · the Budget diagram with Planned (#202, decision 101)", () => {
	const drawn = async () => (await get("/design-system/proposals")).html;
	const section = (html: string) => block(html, "p126-planned-diagram");
	// Each option's chunk, from its heading to the next (the first chunk is the note above the first option).
	const options = (chunk: string) => chunk.split("<h4 ").slice(1);
	// The opening tags of the SVGs in a chunk, so a test can tell the lines apart by their widths.
	const svgs = (chunk: string) =>
		[...chunk.matchAll(/<svg\b[^>]*>/g)].map((m) => m[0]);
	const count = (chunk: string, text: string) => chunk.split(text).length - 1;

	it("sits among the Picked sections, newest decision first: after P127 (decision 116) and before the polish pass's picks (decision 114)", async () => {
		const html = await drawn();
		const start = html.indexOf('<section aria-labelledby="p126-title"');
		expect(start).toBeGreaterThan(-1);
		expect(start).toBeGreaterThan(
			html.indexOf('<section aria-labelledby="p127-title"'),
		);
		expect(start).toBeLessThan(
			html.indexOf('<section aria-labelledby="polish5-title"'),
		);
		expect(html).toContain(
			'<h2 id="p126-title" class="font-serif text-3xl font-semibold">Picked: the Budget diagram with Planned</h2>',
		);
		expect(html).not.toContain("Open: the Budget diagram with Planned");
		expect(html).toContain(
			"Drawn Oct 14 for #202. The owner&#39;s pick, marked Picked, is decision 115: A, the boxes at today&#39;s size and the row wrapping where it doesn&#39;t fit. Decision 116 extends the wrap to every width.",
		);
	});

	it("draws the Fixed note, and three options: today's four boxes, PR #545's five, and option A", async () => {
		const chunk = section(await drawn());
		expect(chunk).toContain(
			"Already fixed by the spec: </span>the diagram is drawn by code from the same numbers as the section&#39;s worked example; its title and description read the whole sum aloud; Safe to spend is the last box, green when it&#39;s zero or more and terracotta when it&#39;s over.",
		);
		expect(options(chunk).length).toBe(3);
		expect(options(chunk)[0]).toContain(
			"Reference · Main until #600: four boxes",
		);
		expect(options(chunk)[1]).toContain(
			"Reference · PR #545 as built: five boxes in one row",
		);
		expect(options(chunk)[2]).toContain(
			"Option A · Today&#39;s box size, wrapping after Bills due",
		);
	});

	it("draws the four boxes as main drew them until #600, at 1280 and at 390, and no Planned box", async () => {
		const html = await drawn();
		const [today = ""] = options(section(html));
		expect(today).toContain(
			'aria-label="Reference · Main until #600: four boxes, on desktop"',
		);
		expect(today).toContain(
			'aria-label="Reference · Main until #600: four boxes, on a phone"',
		);
		// Each drawing is drawn once per width, with its own title and description ids.
		expect(count(today, '<title id="p126-today-1280-title">')).toBe(1);
		expect(count(today, '<title id="p126-today-390-title">')).toBe(1);
		expect(html).not.toContain('id="budget-diagram-title"');
		expect(today).toContain(
			"The $3,940.00 budget minus $2,535.00 spent minus $1,062.49 for bills due leaves $342.51 safe to spend.",
		);
		expect(today).not.toContain("planned expenses");
		expect(count(today, 'viewBox="0 0 440 68"')).toBe(2);
	});

	it("draws PR #545's five boxes as that branch does: one row 550 wide, each box 92 wide", async () => {
		const [, branch = ""] = options(section(await drawn()));
		expect(count(branch, 'viewBox="0 0 550 68"')).toBe(2);
		expect(count(branch, 'width="92" height="60"')).toBe(10);
		// Each drawing's <desc> and its frame's hidden sum read the sentence: two of each, one per width.
		expect(count(branch, "leaves $72.51 safe to spend.")).toBe(4);
		expect(branch).toContain(
			"minus $270.00 for planned expenses leaves $72.51",
		);
		for (const label of [
			"Budget",
			"Spent",
			"Bills due",
			"Planned",
			"Safe to spend",
		])
			expect(branch).toContain(`>${label}</text>`);
	});

	it("draws option A at today's box size, recommended and picked, with decision 116's wrap at every width in its note", async () => {
		const chunk = section(await drawn());
		const [, , a = ""] = options(chunk);
		expect(a).toContain(">Recommended<");
		expect(a).toContain(
			"Option A · Today&#39;s box size, wrapping after Bills due<span",
		);
		expect(a).toContain(
			"Planned is a fifth box at today&#39;s size. Where the row doesn&#39;t fit, it wraps after Bills due, and decision 116 extends the wrap to the four-box diagram too, with or without Planned.",
		);
		expect(a).toContain(
			"Trade-off: a two-part diagram: the boxes split into two groups that wrap, instead of one SVG that scales; no new token, no JavaScript.",
		);
		expect(a).toContain(
			"Why: the labels stay the size they are today on every screen, and the sum still reads left to right.",
		);
		// Each line is its own SVG at natural size: 323 wide (Budget, Spent, Bills due), 230 wide (Planned and Safe to spend).
		// The Picked pill's check icon is an svg too, so the lines are the ones that overflow visibly.
		const tags = svgs(a).filter((tag) => tag.includes('overflow="visible"'));
		expect(tags.length).toBe(6);
		for (const tag of tags) {
			expect(tag).toContain('aria-hidden="true"');
			expect(tag).toContain('overflow="visible"');
		}
		expect(tags.filter((tag) => tag.includes(' width="323"')).length).toBe(3);
		expect(tags.filter((tag) => tag.includes(' width="230"')).length).toBe(2);
		expect(tags.filter((tag) => tag.includes(' width="345"')).length).toBe(1);
		// Every box is main's four-box size, 93 by 60, with main's type sizes (13, 15 and 18).
		expect(count(a, 'width="93" height="60"')).toBe(16);
		for (const size of ['font-size="13"', 'font-size="15"', 'font-size="18"'])
			expect(a).toContain(size);
		// The owner's pick carries the Picked pill, and it is the only one on the diagram.
		expect(a).toContain(">Picked<");
		expect(count(chunk, ">Picked<")).toBe(1);
	});

	it("labels option A's row of boxes as one picture, its title and description saying the sum", async () => {
		const [, , a = ""] = options(section(await drawn()));
		expect(count(a, 'role="img" aria-labelledby="p126-a-1280-title"')).toBe(1);
		expect(count(a, 'aria-describedby="p126-a-1280-desc"')).toBe(1);
		expect(a).toContain(
			'<span id="p126-a-1280-title" class="sr-only">How safe to spend is worked out</span>',
		);
		expect(a).toContain(
			'<span id="p126-a-1280-desc" class="sr-only">The $3,940.00 budget minus $2,535.00 spent minus $1,062.49 for bills due minus $270.00 for planned expenses leaves $72.51 safe to spend.</span>',
		);
		expect(count(a, ">How safe to spend is worked out</span>")).toBe(3);
	});

	it("draws the six-box picture on a phone, its second line 345 wide and leaving $22.51 safe to spend", async () => {
		const [, , a = ""] = options(section(await drawn()));
		expect(a).toContain("With a savings goal too: six boxes, the same rule");
		expect(a).toContain(
			'aria-label="Option A with a savings goal, on a phone"',
		);
		expect(a).toContain(
			"The $3,940.00 budget minus $2,535.00 spent minus $1,062.49 for bills due minus $270.00 for planned expenses minus $50.00 for the savings goal leaves $22.51 safe to spend.",
		);
		expect(a).toContain(">Savings goal</text>");
	});

	it("draws each option's pictures inside its own box: two for each reference and three for option A", async () => {
		const chunk = section(await drawn());
		expect(chunk.match(PICTURE)?.length ?? 0).toBe(7);
		expect(
			(chunk.match(PICTURE) ?? []).filter((p) => p.endsWith('on desktop"'))
				.length,
		).toBe(3);
		expect(
			options(chunk).map((option) => option.match(PICTURE)?.length ?? 0),
		).toEqual([2, 2, 3]);
		expect(count(chunk, 'data-screen="picture"')).toBe(3);
		// Each picture is the Budget section as How Tally works draws it: its heading, then the diagram.
		expect(
			count(
				chunk,
				'<h2 class="font-serif text-3xl font-semibold">Budget and safe to spend</h2>',
			),
		).toBe(7);
	});

	it("gives each picture's outer role=img the whole sum, in a hidden span its aria-describedby names", async () => {
		const html = await drawn();
		const today =
			"The $3,940.00 budget minus $2,535.00 spent minus $1,062.49 for bills due leaves $342.51 safe to spend.";
		const safe =
			"The $3,940.00 budget minus $2,535.00 spent minus $1,062.49 for bills due minus $270.00 for planned expenses leaves $72.51 safe to spend.";
		const six =
			"The $3,940.00 budget minus $2,535.00 spent minus $1,062.49 for bills due minus $270.00 for planned expenses minus $50.00 for the savings goal leaves $22.51 safe to spend.";
		const pictures: [label: string, frame: string, sum: string][] = [
			[
				"Reference · Main until #600: four boxes, on desktop",
				"p126-today-1280-frame",
				today,
			],
			[
				"Reference · Main until #600: four boxes, on a phone",
				"p126-today-390-frame",
				today,
			],
			[
				"Reference · PR #545 as built: five boxes in one row, on desktop",
				"p126-545-1280-frame",
				safe,
			],
			[
				"Reference · PR #545 as built: five boxes in one row, on a phone",
				"p126-545-390-frame",
				safe,
			],
			[
				"Option A · Today&#39;s box size, wrapping after Bills due, on desktop",
				"p126-a-1280-frame",
				safe,
			],
			[
				"Option A · Today&#39;s box size, wrapping after Bills due, on a phone",
				"p126-a-390-frame",
				safe,
			],
			["Option A with a savings goal, on a phone", "p126-a-six-frame", six],
		];
		// Each picture's labelled frame, then the hidden sum it describes itself with, then its inert drawing.
		for (const [label, frame, sum] of pictures) {
			const at = html.indexOf(
				`role="img" aria-label="${label}" aria-describedby="${frame}-sum"`,
			);
			expect(at, frame).toBeGreaterThan(-1);
			const inert = html.indexOf("<div inert", at);
			expect(inert, frame).toBeGreaterThan(at);
			expect(html.slice(at, inert), frame).toContain(
				`<span id="${frame}-sum" hidden="">${sum}</span>`,
			);
		}
		// Seven pictures, seven distinct sums: each frame's description names its own element.
		const described = [
			...html.matchAll(/aria-describedby="(p126-[^"]+-sum)"/g),
		].map((m) => m[1]);
		expect(described).toHaveLength(7);
		expect(new Set(described).size).toBe(7);
		expect(described).toEqual(pictures.map(([, frame]) => `${frame}-sum`));
	});
});

// P120 and P121 (#84 and #498): the edit panel's layouts and the Transactions header's filters, drawn for the owner's pick.
describe("GET /design-system/proposals, polish round B (P120 and P121)", () => {
	const section = (html: string, id: string) => {
		const start = html.indexOf(`<section id="${id}"`);
		expect(start, id).toBeGreaterThan(-1);
		const next = html.indexOf('<section id="p', start + 1);
		return html.slice(start, next === -1 ? undefined : next);
	};
	// One option's heading and everything drawn under it, up to the next option's heading.
	const option = (sectionHtml: string, name: string) => {
		const heads = [...sectionHtml.matchAll(/<h4 /g)].map((m) => m.index ?? 0);
		const at = heads.find((i) =>
			sectionHtml.slice(i, i + 400).includes(`>${name}`),
		);
		expect(at, name).toBeDefined();
		const next = heads.find((i) => i > (at ?? 0));
		return sectionHtml.slice(at, next);
	};
	// Each picture under an option, from its label on, up to the next picture's label.
	const pictures = (chunk: string) =>
		chunk.split('role="img" aria-label="').slice(1);

	it("opens the page with its section first, titled and dated as the brief asks", async () => {
		const { html } = await get("/design-system/proposals");
		const first = html.indexOf('<section aria-labelledby="polish3-title"');
		expect(first).toBeGreaterThan(-1);
		expect(first).toBeLessThan(
			html.indexOf('<section aria-labelledby="polish-title"'),
		);
		expect(html).toContain('<h2 id="polish3-title"');
		expect(html).toContain(
			"Picked: the polish track, the edit panel and the list&#39;s top",
		);
		expect(html).toContain(
			"Drawn Oct 13. The owner&#39;s picks, marked Picked, are decision 111: what the edit panel leads with, and how much of Transactions&#39; first screen goes to filters.",
		);
	});

	it("draws P120's four panel options with B recommended, and two pictures for each of A, C and Today", async () => {
		const { html } = await get("/design-system/proposals");
		const s = section(html, "p120-panel");
		for (const name of [
			"Today (current)",
			"A · Category first",
			"B · Category leads, folds when set",
			"C · Ruled ledger",
		]) {
			expect(option(s, name), name).toContain(`>${name}`);
		}
		expect(s.match(/>Recommended</g)?.length ?? 0).toBe(1);
		expect(option(s, "B · Category leads, folds when set")).toContain(
			">Recommended<",
		);
		expect(pictures(option(s, "Today (current)"))).toHaveLength(2);
		expect(pictures(option(s, "A · Category first"))).toHaveLength(2);
		expect(pictures(option(s, "C · Ruled ledger"))).toHaveLength(2);
		expect(s).toContain('aria-label="At 1280: Today (current), on desktop"');
		expect(s).toContain(
			'aria-label="At 1280: B · Category leads, folds when set, on desktop"',
		);
	});

	it("spaces P120's desktop B like its phone picture, so the bank's text and Category don't touch", async () => {
		const { html } = await get("/design-system/proposals");
		const desk = option(
			section(html, "p120-panel"),
			"At 1280: B · Category leads, folds when set",
		);
		expect(desk).toContain('<div class="flex shrink-0 flex-col gap-5">');
		expect(desk.indexOf("SQ *LOCAL BAKERY 4432")).toBeLessThan(
			desk.indexOf(">Category</legend>"),
		);
	});

	it("draws Exclude from budget as a switch and the rule as a plain unticked row in A, B and C", async () => {
		const { html } = await get("/design-system/proposals");
		const s = section(html, "p120-panel");
		for (const name of [
			"A · Category first",
			"B · Category leads, folds when set",
			"C · Ruled ledger",
		]) {
			const chunk = option(s, name);
			expect(chunk, name).toContain('role="switch"');
			expect(chunk, name).toContain("Exclude from budget");
			expect(chunk, name).toContain(
				"It won&#39;t count in Spent or any budget.",
			);
			expect(chunk, name).toContain(
				"Use this category for Local Bakery from now on",
			);
			expect(chunk, name).toContain(
				"Leave it unticked to change just this one.",
			);
		}
	});

	it("draws Today's panel with the explanation and How this works on its first screen, and no category choices", async () => {
		const { html } = await get("/design-system/proposals");
		const today = option(section(html, "p120-panel"), "Today (current)");
		expect(today).toContain("From Northline Card Services.");
		expect(today).toContain("How this works");
		expect(today).toContain(">Split</");
		expect(today).not.toContain(">Category</legend>");
		expect(today).not.toContain("Count as income");
	});

	it("puts the explanation under the switches in A, B and C, and keeps New category last in the grid", async () => {
		const { html } = await get("/design-system/proposals");
		const s = section(html, "p120-panel");
		for (const name of [
			"A · Category first",
			"B · Category leads, folds when set",
			"C · Ruled ledger",
		]) {
			for (const picture of pictures(option(s, name))) {
				expect(
					picture.indexOf("From Northline Card Services."),
					name,
				).toBeGreaterThan(picture.indexOf("Count as income"));
			}
		}
		const first = pictures(option(s, "A · Category first"))[0] ?? "";
		expect(first).toContain("grid grid-cols-2");
		expect(first.indexOf("New category")).toBeGreaterThan(
			first.indexOf("Rent</label>"),
		);
	});

	it("folds B's Trader Joe's category into one row, and draws a third picture of it opened", async () => {
		const { html } = await get("/design-system/proposals");
		const b = option(
			section(html, "p120-panel"),
			"B · Category leads, folds when set",
		);
		const all = pictures(b);
		expect(all).toHaveLength(3);
		expect(all[1]).toContain("Picked by Tally · 92% sure");
		expect(all[1]).not.toContain(
			'<details class="group border-b border-rule" open=""',
		);
		expect(all[2]).toContain(
			'<details class="group border-b border-rule" open=""',
		);
		expect(all[2]).toContain("Picked by Tally · 92% sure");
	});

	it("draws C's Local Bakery category open and Trader Joe's closed with its source", async () => {
		const { html } = await get("/design-system/proposals");
		const [lb = "", tj = ""] = pictures(
			option(section(html, "p120-panel"), "C · Ruled ledger"),
		);
		expect(lb).toContain('<details class="group border-b border-rule" open=""');
		expect(tj).not.toContain(
			'<details class="group border-b border-rule" open=""',
		);
		expect(tj).toContain("Picked by Tally · 92% sure");
	});

	it("draws P121's three header options with A recommended, its Filters as a closed pill, and B's filters in one strip", async () => {
		const { html } = await get("/design-system/proposals");
		const s = section(html, "p121-header");
		for (const name of [
			"Today (current)",
			"A · Filters fold away",
			"B · One filter strip",
		]) {
			expect(option(s, name), name).toContain(`>${name}`);
		}
		expect(s.match(/>Recommended</g)?.length ?? 0).toBe(1);
		expect(option(s, "A · Filters fold away")).toContain(">Recommended<");
		const [closed = "", open = ""] = pictures(
			option(s, "A · Filters fold away"),
		);
		expect(closed).toContain("Filters</summary>");
		expect(closed).not.toContain('<details class="group open:w-full" open=""');
		expect(open).toContain('<details class="group open:w-full" open=""');
		expect(open).toContain("All accounts");
		const b = option(s, "B · One filter strip");
		expect(b).toContain("flex gap-2 overflow-x-auto px-5 py-1");
		expect(b.indexOf("Needs category (")).toBeLessThan(b.indexOf("October"));
	});

	it("draws B's phone strip scrolled a little, so All categories shows cut off under the paper fade", async () => {
		const { html } = await get("/design-system/proposals");
		const b = option(section(html, "p121-header"), "B · One filter strip");
		// The first pill starts past the strip's left edge; the third pill follows October and sits under the
		// fade that closes the strip on the right.
		expect(b).toContain('<span class="shrink-0 -ml-8">');
		expect(b.indexOf("October")).toBeLessThan(b.indexOf("All categories"));
		expect(b.indexOf("All categories")).toBeLessThan(
			b.indexOf("pointer-events-none absolute inset-y-0 right-0 w-16"),
		);
	});

	it("says in P121's sentence that A also shows its Filters pill open", async () => {
		const { html } = await get("/design-system/proposals");
		expect(section(html, "p121-header")).toContain(
			"A also shows its Filters pill open.",
		);
	});

	it("notes under P121's Fixed line that decision 111 moved How this works to the page foot, before the first option", async () => {
		const { html } = await get("/design-system/proposals");
		const s = section(html, "p121-header");
		const note =
			'<span class="font-medium">Replaced by decision 111: </span>Since P124 A (decision 111), How this works sits at the foot of the page, not beside Add cash; Add cash keeps its own line.';
		expect(s).toContain(note);
		expect(s.indexOf(note)).toBeLessThan(s.indexOf(">Today (current)"));
		expect(s).not.toContain("further down");
		expect(s).not.toContain("decision 82");
	});

	it("keeps P46's Replaced note on decision 82 with its pointer further down", async () => {
		const { html } = await get("/design-system/proposals");
		const s = section(html, "p46-past-months");
		expect(s).toContain(
			'<span class="font-medium">Replaced by decision 82: </span>',
		);
		expect(s).toContain("See P91 to P93, further down.");
	});

	it("lists the sidebar and the tabs in the pictures from nav.tsx's own items, in order", async () => {
		const { html } = await get("/design-system/proposals");
		const s = section(html, "p121-header");
		const inOrder = (chunk: string, labels: string[]) => {
			let at = -1;
			for (const label of labels) {
				const next = chunk.indexOf(`${label}</span>`, at + 1);
				expect(next, label).toBeGreaterThan(at);
				at = next;
			}
		};
		inOrder(
			option(s, "At 1280: Today (current)"),
			SIDEBAR_ITEMS.map((item) => item.label),
		);
		inOrder(
			pictures(option(s, "Today (current)"))[0] ?? "",
			TAB_ITEMS.map((item) => item.label),
		);
	});

	it("draws each P121 phone with the demo banner and the tab bar, and a desktop picture for each option", async () => {
		const { html } = await get("/design-system/proposals");
		const s = section(html, "p121-header");
		// The cut-short picture of A's open Filters has no tab bar (it stops above it), so it's not one of these.
		const phones = pictures(s).filter(
			(p) => p.includes(", on a phone") && !p.includes("pill open"),
		);
		expect(phones).toHaveLength(3);
		for (const picture of phones) {
			expect(picture).toContain("Demo data. Nothing here is real.");
			expect(picture).toContain(">Transactions</span>");
		}
		expect(s).toContain('aria-label="At 1280: Today (current), on desktop"');
		expect(s).toContain(
			'aria-label="At 1280: A · Filters fold away, on desktop"',
		);
		expect(s).toContain(
			'aria-label="At 1280: B · One filter strip, on desktop"',
		);
	});
});

// P125 (#95): a family's first week, five ways, drawn for the owner's pick and picked as E (decision 114). Proposal only: nothing in the app changes.
describe("GET /design-system/proposals, polish round D (P125, a new family's first week)", () => {
	// The P125 section, up to the next top-level section (its pictures can hold sections of their own).
	const section = (html: string) => {
		const start = html.indexOf('<section id="p125-first-week"');
		expect(start).toBeGreaterThan(-1);
		const end = html.indexOf('<section aria-labelledby="polish4-title"', start);
		expect(end).toBeGreaterThan(start);
		return html.slice(start, end);
	};
	// One option's heading and everything drawn under it, up to the next option's heading.
	const option = (chunk: string, name: string) => {
		const heads = [...chunk.matchAll(/<h4 /g)].map((m) => m.index ?? 0);
		const at = heads.find((i) => chunk.slice(i, i + 400).includes(`>${name}`));
		expect(at, name).toBeDefined();
		const next = heads.find((i) => i > (at ?? 0));
		return chunk.slice(at, next);
	};
	// Each labelled picture in a chunk, from its label on.
	const pictures = (chunk: string) =>
		chunk.split('role="img" aria-label="').slice(1);
	// Option A's lines 2 to 4 each name their own keyframes through a step class, so each turns found at its own point in the loop.
	const STEP_CLASSES = [
		"proposal-first-later",
		"proposal-first-last",
		"proposal-first-second-round",
	];
	const OPTIONS = [
		"Option A · The Opening Entry",
		"Option B · Pencil, then ink",
		"Option C · The notebook fills in",
		"Option D · Kitchen-table sitting",
		"Option E · The notebook, one question at a time",
	];

	it("opens the page with its own section, after P126 and before the polish pass's picks, titled and dated as the brief asks", async () => {
		const { html } = await get("/design-system/proposals");
		const open = html.indexOf('<section aria-labelledby="polish5-title"');
		expect(open).toBeGreaterThan(-1);
		expect(open).toBeLessThan(
			html.indexOf('<section aria-labelledby="polish4-title"'),
		);
		expect(html).toContain(
			'<h2 id="polish5-title" class="font-serif text-3xl font-semibold">Picked: the polish track, a new family&#39;s first week</h2>',
		);
		expect(html).toContain(
			"Drawn Oct 14. The owner&#39;s pick, marked Picked, is decision 114: E, the notebook filled in one question at a time.",
		);
		expect(html).toContain('<section id="p125-first-week"');
		expect(html).toContain(
			'<h3 id="p125-first-week-title" class="text-xl font-semibold">P125 · A new family&#39;s first week</h3>',
		);
	});

	it("draws five options: E recommended and picked (decision 114), each with its cost and its reason, all in the family's app", async () => {
		const { html } = await get("/design-system/proposals");
		const chunk = section(html);
		const names = [...chunk.matchAll(/<h4 [^>]*>([^<]*)/g)].map(
			(m) => m[1] ?? "",
		);
		expect(names).toEqual(OPTIONS);
		expect(chunk.match(/>Recommended</g)?.length).toBe(1);
		expect(option(chunk, OPTIONS[4] ?? "")).toContain(">Recommended<");
		expect(chunk.match(/>Picked</g)?.length).toBe(1);
		expect(option(chunk, OPTIONS[4] ?? "")).toContain(">Picked<");
		expect(chunk.match(/Trade-off: /g)?.length).toBe(5);
		expect(chunk.match(/text-muted">Why: /g)?.length).toBe(5);
		// The family's first week has no demo banner: none of these pictures draws one.
		expect(chunk).not.toContain("Demo data. Nothing here is real.");
		expect(chunk).toContain(
			'<span class="font-medium">Already fixed by the spec: </span>Tally only suggests and a person decides (decision 101): nothing is saved until someone says yes;',
		);
	});

	it("draws each stage as a phone picture with a caption in words, and each option's replay as one more", async () => {
		const { html } = await get("/design-system/proposals");
		const chunk = section(html);
		expect(chunk).not.toContain("on desktop");
		const stages = [11, 6, 7, 5, 9];
		OPTIONS.forEach((name, i) => {
			// Each picture's label, up to its closing quote: the words after it belong to other pictures too.
			const labels = pictures(option(chunk, name)).map((p) =>
				p.slice(0, p.indexOf('"')),
			);
			const phones = labels.filter((label) => label.endsWith(", on a phone"));
			expect(phones, name).toHaveLength(stages[i] ?? 0);
			// Each option's replay is labelled as one, and loops (a proposals-only class in app.css).
			expect(
				phones.filter((label) => label.toLowerCase().includes("replay")),
				name,
			).toHaveLength(1);
		});
		expect(
			chunk.match(
				/Replay, (every (5|6) seconds|a few minutes shortened to 8 seconds)/g,
			)?.length,
		).toBe(5);
		// Every phone is 390 by 844 inside its 1px border: 392 by 846 drawn, as the Phone frame in proposals-polish-4 draws it.
		expect(chunk.match(/h-\[846px\] w-\[392px\]/g)?.length).toBe(38);
	});

	it("loops each replay on its own clock: 8 s for A, 5 s for B, 6 s for C and D, all set from the rising token", async () => {
		const { html } = await get("/design-system/proposals");
		const chunk = section(html);
		// --duration-rising is 200 ms: a loop of 30 steps is 6 s and of 25 steps is 5 s.
		const rising = Number(/--duration-rising: (\d+)ms/.exec(css)?.[1]);
		expect(rising).toBe(200);
		OPTIONS.forEach((name, i) => {
			const classes = [
				...new Set(option(chunk, name).match(/proposal-first-[a-z-]+/g) ?? []),
			].filter((cls) => !STEP_CLASSES.includes(cls));
			expect(classes.length, name).toBeGreaterThan(0);
			for (const cls of classes) {
				const loop = new RegExp(
					`\\.${cls}\\s*\\{\\s*--loop: calc\\(var\\(--duration-rising\\) \\* (\\d+)\\);`,
				).exec(css);
				expect(loop, cls).not.toBeNull();
				expect((rising * Number(loop?.[1])) / 1000, cls).toBe(
					i === 0 ? 8 : i === 1 ? 5 : 6,
				);
			}
		});
	});

	it("keeps one sample household in every option: $1,411 safe to spend, and the same 86 that need a category", async () => {
		const { html } = await get("/design-system/proposals");
		const chunk = section(html);
		for (const name of OPTIONS) {
			expect(option(chunk, name), name).toContain("$1,411");
		}
		expect(chunk).toContain("86 need a category");
		expect(chunk).toContain("$186 of this month&#39;s spending");
		expect(chunk).toContain("$4,050");
		expect(chunk).toContain("$2,486");
		expect(chunk).toContain("Harbor Property");
		expect(chunk).toContain("Acme Corp");
	});

	it("draws the rest of the brief's sample household as its figures, in the same words", async () => {
		const { html } = await get("/design-system/proposals");
		const chunk = section(html);
		for (const figure of [
			"Chase · 412 lines · Jul 16 to Oct 13",
			"Tally sorted 362 overnight",
			"50 of 412 sorted",
			"$4,900 came in and about $4,310 went out",
			"6 moves between your own accounts",
			"38 stores have cleaner names",
			"Aug $610 · Sep $674",
			"Aug $296 · Sep $340",
			"8 that come back every month, about $2,062",
			"about $2,062 a month",
			"Bills still due this week",
			"−$153",
		]) {
			expect(chunk, figure).toContain(figure);
		}
	});

	it("says in words what each pencil state is, for a screen reader, as well as drawing it", async () => {
		const { html } = await get("/design-system/proposals");
		const chunk = section(html);
		expect(chunk).toContain(
			'<span class="sr-only">Not pencilled in yet</span>',
		);
		expect(chunk).toContain("pencilled in, not kept yet");
		expect(chunk).toContain("border-dashed border-muted");
	});

	it("draws the replays from proposal-only keyframes in app.css, each one resting on its end state under reduced motion", async () => {
		const { html } = await get("/design-system/proposals");
		const chunk = section(html);
		const classes = [
			...new Set(chunk.match(/proposal-first-[a-z-]+/g) ?? []),
		].filter((cls) => !STEP_CLASSES.includes(cls));
		expect(classes.length).toBeGreaterThan(0);
		for (const cls of classes) {
			expect(css, cls).toContain(`.${cls}`);
			expect(css, cls).toMatch(new RegExp(`\\.${cls}\\s*\\{[^}]*animation:`));
			expect(css, cls).toMatch(
				new RegExp(
					`@media \\(prefers-reduced-motion: reduce\\)\\s*\\{[\\s\\S]*?\\.${cls}[^{]*\\{\\s*animation: none`,
				),
			);
		}
		// The P125 keyframes are proposal-only and live in their own block.
		expect(css).toContain("Proposals only (P125)");
	});

	it("words the first budget as rounded up to the next $10, and says in words each pencil state (a dashed amount, a dashed tag, a dashed tick)", async () => {
		const { html } = await get("/design-system/proposals");
		const chunk = section(html);
		expect(chunk).not.toContain("raised to the next $10");
		expect(chunk.match(/rounded up to the next \$10/g)?.length).toBe(4);
		// Option B's pencilled budget rows: each row says it is pencilled in, not kept yet.
		expect(
			option(chunk, OPTIONS[1] ?? "").match(/Pencilled in, not kept yet: /g)
				?.length,
		).toBe(2);
		// Option A's line that needs a category is not ticked yet, and option D's suggested amount is not kept yet.
		expect(option(chunk, OPTIONS[0] ?? "")).toContain(
			'<span class="sr-only">Not ticked yet</span>',
		);
		expect(option(chunk, OPTIONS[3] ?? "")).toContain(
			'<span class="sr-only">Suggested, not kept yet</span>',
		);
	});

	// One labelled picture, from its label to the next picture's (the last one runs to the section's end).
	const picture = (chunk: string, label: string) => {
		const at = chunk.indexOf(`role="img" aria-label="${label}, on a phone"`);
		expect(at, label).toBeGreaterThan(-1);
		const next = chunk.indexOf('role="img" aria-label="', at + 1);
		return chunk.slice(at, next === -1 ? undefined : next);
	};
	// Every opening tag in a chunk whose class list has `cls` as one of its classes.
	const tagsWith = (chunk: string, cls: string) =>
		[...chunk.matchAll(/<[a-zA-Z]+\b[^>]*>/g)]
			.map((m) => m[0])
			.filter((tag) =>
				(/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(" ").includes(cls),
			);

	it("carries each option's lines from the brief, word for word, in its pictures", async () => {
		const { html } = await get("/design-system/proposals");
		const chunk = section(html);
		const LINES: Record<string, string[]> = {
			[OPTIONS[0] ?? ""]: [
				"Let Tally read first.",
				"Link your bank and Tally does the dull part: it reads your last 90 days, tidies them up and writes you a first budget. You won&#39;t type a number.",
				"Tally&#39;s part",
				"Find your paycheck",
				"Spot your bills",
				"Leave out your transfers",
				"Name your stores",
				"Sort your spending",
				"Write your first budget",
				"Your part",
				"Link a bank",
				"Tally can only read your bank. It can&#39;t move money.",
				"Found your paycheck",
				"$2,450 every other Friday, from Acme Corp",
				"Your bank wrote ",
				"ACME CORP PAYROLL PPD ID 4432",
				"Acme Corp",
				"Spotted your bills",
				"8 that come back every month, about $2,062",
				"Harbor Property, Geico, Spectrum and 5 more",
				"Left out your transfers",
				"6 moves between your own accounts, so they don&#39;t count as spending",
				"ONLINE TRANSFER TO SAV ...5678",
				"Transfer to Savings",
				"Named your stores",
				"38 stores, from your bank&#39;s text",
				"SQ *BLUE BOTTLE COF 0217",
				"Blue Bottle Coffee",
				"Once all 90 days are in",
				"Reading Chase",
				"142 transactions in so far, from Sep 14 to Oct 13.",
				"You can close Tally. It keeps reading.",
				"Linked Chase",
				"Your last 90 days",
				"All 412 are in, from Jul 16 to Oct 13. Tally sorts the rest tonight, and your first budget will be ready by about 6 a.m.",
				"Nothing for you to do until then.",
				"50 of 412 sorted so far. The rest tonight.",
				"Ready by about 6 a.m.",
				"Plaid&#39;s own screens",
				"Pick your bank and sign in with Plaid. Tally never sees your bank password.",
				"Reading Chase. The first month usually takes under a minute.",
				"In a typical month, $4,900 came in and about $4,310 went out.",
				"From Chase, Jul 16 to Oct 13. Tally sorted 362 overnight.",
				"A first budget",
				"Each line is what that category spent in a typical month, August and September, rounded up to the next $10.",
				"Aug $610 · Sep $674",
				"86 transactions Tally wasn&#39;t sure of · about $320 a month",
				"Bills · 8",
				"about $2,062 a month",
				"Budgets",
				"$4,050 a month",
				"Safe to spend today",
				"$1,411",
				"Start with this budget",
				"Untick any you&#39;d rather leave out. Once set, a budget can be changed on Home but not removed.",
				"Set my own instead",
				"Your first budget, from your own August and September.",
				"86 need a category",
				"$186 of this month&#39;s spending",
			],
			[OPTIONS[1] ?? ""]: [
				"Link your bank, and Tally pencils in your whole budget from your last 90 days.",
				"Tally can only read it. It can&#39;t move money.",
				"Reading Chase. Tally pencils in your budget once it has sorted your 90 days: by about 6 a.m.",
				"Pencilled in from your August and September. Ink it in when it looks right.",
				"Safe to spend · in pencil",
				"Paid $2,450 every other Friday by Acme Corp.",
				"8 charges come back every month, about $2,062.",
				"6 moves between your own accounts are left out; they aren&#39;t spending.",
				"38 stores have cleaner names, dashed until you keep them.",
				"Ink in this budget",
				"12 budgets and 8 bills, all from your history",
				"Ink in this budget",
				"$4,050",
				"a month",
				"What each category spent in a typical month, August and September, rounded up to the next $10.",
				"Budgets · 12 categories",
				"Bills · 8, about $2,062 a month",
				"Safe to spend becomes $1,411. Untick any you&#39;d rather leave out: once set, a budget can be changed but not removed.",
				"Cancel",
				"Ink it in",
				"Inked in. Tap any line to change it.",
			],
			[OPTIONS[2] ?? ""]: [
				"Welcome to Tally",
				"One thing today.",
				"Tally does the reading; you make the calls.",
				"Link your bank",
				"Tally can only read it. It can&#39;t move money.",
				"Spent so far",
				"$2,486",
				"That&#39;s all for today. Tally sorts what it&#39;s sure of by tomorrow, so these will be fewer.",
				"86 need a category",
				"$186 of this month&#39;s spending",
				"Budget 1 of 12",
				"Rent",
				"Last month: $1,600.00",
				"3-month average: $1,600.00",
				"Skip this one",
				"Save and next",
				"Four. Tomorrow Tally keeps count on its own, and that&#39;s the fifth.",
				"Five. Overnight Tally kept count on its own: 3 new transactions, all sorted. You&#39;re set up.",
				"Thursday: the fifth stroke crosses the four, and all five are ink",
				"Five. You&#39;re set up.",
			],
			[OPTIONS[3] ?? ""]: [
				"Tally read your last 90 days from Chase and sorted 362 overnight. It has 14 questions for you, and Safe to spend is written in at the end.",
				"Your pay first, then your bills, then a budget for each category that spent something.",
				"14 questions from Tally",
				"About three minutes. Most are one tap.",
				"Your first page",
				"4 of 14",
				"From Chase · 412 lines · Jul 16 to Oct 13",
				"Moves between your accounts · 6 left out",
				"Paychecks · $4,900 in September",
				"Costco · Groceries",
				"Your bank shows Groceries spent $610 in August and $674 in September.",
				"$650 a month",
				"Make $650 a month your Groceries budget?",
				"Tally&#39;s suggestion: a typical month, rounded up to the next $10. From October on.",
				"Yes, $650 a month",
				"Another amount",
				"Not now",
				"Budgets",
				"$4,050",
				"Spent so far in October",
				"−$2,486",
				"Bills still due this week",
				"−$153",
				"Safe to spend",
				"$1,411",
				"That&#39;s October, in your own numbers. Home keeps it up to date from here.",
				"Go to Home",
			],
		};
		for (const name of OPTIONS) {
			for (const line of LINES[name] ?? []) {
				expect(option(chunk, name), line).toContain(line);
			}
		}
	});

	it("gives each option its idea and its cost line, as the brief words them", async () => {
		const { html } = await get("/design-system/proposals");
		const chunk = section(html);
		const IDEAS: Record<string, [string, string]> = {
			[OPTIONS[0] ?? ""]: [
				"Tally&#39;s part against yours: Tally finds your paycheck, bills and transfers, names your stores and writes a first budget, and you link a bank. Home fills itself in while Tally reads.",
				"a first-budget rule (a spec line), a Home that is the entry until a budget exists, Plaid Link opened on Home (the approved plaid-link.js, loaded there while no bank is linked), and Home checking every 5 seconds while Tally reads (htmx polling, a new pattern here). The status line is the only thing read aloud: once when the first month is in and once when all 90 days are.",
			],
			[OPTIONS[1] ?? ""]: [
				"Tally pencils your whole Home in from your history, dashed like every Tally guess, and one tap inks it in.",
				"a first-budget rule (a spec line) and pencil versions of Home&#39;s number and rows; no new page.",
			],
			[OPTIONS[2] ?? ""]: [
				"Each real step pencils one stroke into Home&#39;s notebook drawing; the morning after the fourth, the fifth crosses them and Home is just Home.",
				"a kept record of the five steps, a budget walk, and checking for the import&#39;s end (htmx polling).",
			],
			[OPTIONS[3] ?? ""]: [
				"Once Tally has sorted the last 90 days from your bank, it asks a few plain questions one at a time; each answer is written as a ledger line, and the sitting ends by ruling off your first Safe to spend.",
				"a question page, a first-budget rule (a spec line) and one kept date for when the sitting ends.",
			],
			[OPTIONS[4] ?? ""]: [
				"C&#39;s notebook shows how far along you are, and D&#39;s plain questions fill it in: your pay, your bills, then your budgets, all from your own last 90 days.",
				"a kept record of the five strokes (one household setting), a question page, and a first-budget rule (a spec line); no polling, since the questions are ready the next morning.",
			],
		};
		for (const name of OPTIONS) {
			const [idea, cost] = IDEAS[name] ?? [];
			expect(option(chunk, name), name).toContain(
				`<p class="text-sm">${idea}</p>`,
			);
			expect(option(chunk, name), name).toContain(`Trade-off: ${cost}`);
		}
	});

	it("rests each replay on its end state in the markup, the frame reduced motion shows, so every loop has one", async () => {
		const { html } = await get("/design-system/proposals");
		const chunk = section(html);
		// For each replay class: the classes its element must carry, and the ones it must not, at the end state.
		const AT_REST: Record<string, { must?: string[]; not?: string[] }> = {
			"proposal-first-status-first": { must: ["opacity-0"] },
			"proposal-first-status-middle": { must: ["opacity-0"] },
			"proposal-first-status-last": { not: ["opacity-0"] },
			"proposal-first-title-first": { must: ["opacity-0"] },
			"proposal-first-title-last": { not: ["opacity-0"] },
			"proposal-first-promise": { must: ["opacity-0"] },
			"proposal-first-label": { not: ["opacity-0"] },
			"proposal-first-fact": { not: ["opacity-0", "translate-y-1"] },
			"proposal-first-strike": { not: ["scale-x-0"] },
			"proposal-first-name": { not: ["opacity-0"] },
			"proposal-first-ink-text": { must: ["text-ink"] },
			"proposal-first-pencil-off": { must: ["opacity-0"] },
			"proposal-first-ink-on": { not: ["opacity-0"] },
			"proposal-first-bar": { must: ["fill-ink"], not: ["scale-x-0"] },
			"proposal-first-stroke": { must: ["stroke-ink"] },
			"proposal-first-cross": { must: ["stroke-ink"] },
			"proposal-first-line": { not: ["opacity-0", "translate-y-1"] },
			"proposal-first-rule": { not: ["scale-x-0"] },
			"proposal-first-amount": { not: ["opacity-0"] },
			// Option E: the answered question rests at 40% in muted words, its button at rest, the Bills line in,
			// the third stroke drawn and inked, and the counter at 3 of 5 (2 of 5 hidden).
			"proposal-first-answer": { must: ["opacity-40", "text-muted"] },
			"proposal-first-press": { must: ["bg-ink", "text-paper"] },
			"proposal-first-bills": { not: ["opacity-0", "translate-y-1"] },
			"proposal-first-draw": { must: ["stroke-ink"] },
			"proposal-first-counter-before": { must: ["opacity-0"] },
			"proposal-first-counter-after": { not: ["opacity-0"] },
		};
		const used = new Set(chunk.match(/proposal-first-[a-z-]+/g) ?? []);
		for (const step of STEP_CLASSES) used.delete(step);
		expect([...used].sort()).toEqual(Object.keys(AT_REST).sort());
		for (const [cls, { must = [], not = [] }] of Object.entries(AT_REST)) {
			const tags = tagsWith(chunk, cls);
			expect(tags.length, cls).toBeGreaterThan(0);
			for (const tag of tags) {
				const classes = (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(" ");
				for (const m of must) expect(classes, `${cls} needs ${m}`).toContain(m);
				for (const n of not)
					expect(classes, `${cls} must not carry ${n}`).not.toContain(n);
			}
		}
	});

	it("says 'pencil' in the label of every picture with a pencil state, and in words beside the pencil figures", async () => {
		const { html } = await get("/design-system/proposals");
		const chunk = section(html);
		for (const label of [
			"Option B, before a bank, with the amount a pencil blank",
			"Option B, that evening, with the amount still a pencil blank",
			"Option B, pencilled in, the amount in pencil",
			"Option B, the ink-in sheet over the pencilled Home",
			"Option B, replay: the pencil inks in",
			"Option C, that evening, one stroke in pencil",
			"Option C, the budget walk, two strokes in pencil",
			"Option C, four strokes in pencil",
			"Option D, next morning, with the amount a pencil blank",
			"Option D, a question page, the suggested amount in pencil",
		]) {
			picture(chunk, label);
		}
		// The strokes say they are pencil in words beside the count, and the picture that inks them says ink.
		expect(
			picture(chunk, "Option C, the budget walk, two strokes in pencil"),
		).toContain(
			'Your first tally · 2 of 5<span class="sr-only">, in pencil</span>',
		);
		expect(picture(chunk, "Option C, four strokes in pencil")).toContain(
			"stroke-muted",
		);
		expect(picture(chunk, "Option C, five strokes in ink")).not.toContain(
			"stroke-muted",
		);
		expect(option(chunk, OPTIONS[3] ?? "")).toContain(
			'<span class="sr-only">Pencil blank, not written in yet</span>',
		);
	});

	it("writes the replay's new answer last in the ledger, under Costco · Groceries", async () => {
		const { html } = await get("/design-system/proposals");
		const replay = picture(
			section(html),
			"Option D, replay: a new answer and the total",
		);
		expect(replay.indexOf("Costco · Groceries")).toBeGreaterThan(-1);
		expect(replay.indexOf("Groceries, from October")).toBeGreaterThan(
			replay.indexOf("Costco · Groceries"),
		);
	});

	it("draws Option A's first picture as Tally's part and yours: six promises with blanks, then Your part, with its one button after it", async () => {
		const { html } = await get("/design-system/proposals");
		const before = picture(section(html), "Option A, before a bank");
		const promises = [
			"Find your paycheck",
			"Spot your bills",
			"Leave out your transfers",
			"Name your stores",
			"Sort your spending",
			"Write your first budget",
		];
		let at = before.indexOf("Tally&#39;s part");
		expect(at).toBeGreaterThan(-1);
		for (const promise of promises) {
			const i = before.indexOf(`>${promise}<`);
			expect(i, promise).toBeGreaterThan(at);
			at = i;
		}
		expect(before.match(/Not done yet/g)?.length).toBe(6);
		// Each promise is one 44 px line (min-h-11, with py-1 and nothing more), and the headline is text-4xl.
		expect(
			before.match(/flex min-h-11 items-center justify-between gap-3 py-1/g)
				?.length,
		).toBe(6);
		expect(before).toContain(
			'<h1 class="font-serif text-4xl font-semibold tracking-tight">Let Tally read first.</h1>',
		);
		const yours = before.indexOf(">Your part<");
		expect(yours).toBeGreaterThan(at);
		expect(before.match(/<button/g)?.length).toBe(1);
		expect(before.indexOf("<button", yours)).toBeGreaterThan(yours);
		expect(before.indexOf("Tally can only read your bank.")).toBeGreaterThan(
			before.indexOf("<button", yours),
		);
	});

	it("writes each found line's fact and draws the bank's own line struck through under it, with Tally's name and the words said aloud", async () => {
		const { html } = await get("/design-system/proposals");
		const evening = picture(section(html), "Option A, that evening");
		for (const [bank, name] of [
			["ACME CORP PAYROLL PPD ID 4432", "Acme Corp"],
			["ONLINE TRANSFER TO SAV ...5678", "Transfer to Savings"],
			["SQ *BLUE BOTTLE COF 0217", "Blue Bottle Coffee"],
		] as const) {
			const at = evening.indexOf(bank);
			expect(at, bank).toBeGreaterThan(-1);
			const strike = evening.indexOf(
				'class="absolute inset-x-0 top-1/2 h-px origin-left bg-muted',
				at,
			);
			expect(strike, bank).toBeGreaterThan(at);
			expect(evening.indexOf(name, strike), name).toBeGreaterThan(strike);
		}
		expect(evening.match(/Your bank wrote /g)?.length).toBe(3);
		expect(evening.match(/; Tally reads it as /g)?.length).toBe(3);
		for (const fact of [
			"$2,450 every other Friday, from Acme Corp",
			"8 that come back every month, about $2,062",
			"6 moves between your own accounts, so they don&#39;t count as spending",
			"38 stores, from your bank&#39;s text",
		]) {
			expect(evening, fact).toContain(fact);
		}
	});

	it("opens Plaid on Home over the dimmed Home, with a plain placeholder for Plaid's screens and no Plaid design in it", async () => {
		const { html } = await get("/design-system/proposals");
		const plaid = picture(
			section(html),
			"Option A, Plaid opened on Home, over the dimmed Home",
		);
		expect(plaid).toContain("Let Tally read first.");
		expect(plaid).toContain("bg-ink/30");
		expect(plaid).toContain("Plaid&#39;s own screens");
		expect(plaid).toContain(
			"Pick your bank and sign in with Plaid. Tally never sees your bank password.",
		);
		// The picture's own label names Plaid too; the words drawn inside it are the two in the sheet.
		expect(
			plaid.replace(/aria-label="[^"]*"/, "").match(/Plaid/g)?.length,
		).toBe(2);
		expect(plaid).toContain(
			"h-40 rounded-control border-2 border-dashed border-muted",
		);
	});

	it("draws a minute later with the first month in: lines 1 to 4 with three found and their proofs, line 2 still waiting, and nothing from line 5 on", async () => {
		const { html } = await get("/design-system/proposals");
		const minute = picture(
			section(html),
			"Option A, a minute later, with the first month in",
		);
		expect(minute).toContain("Reading Chase");
		expect(minute).toContain(
			"142 transactions in so far, from Sep 14 to Oct 13.",
		);
		expect(minute).toContain("You can close Tally. It keeps reading.");
		expect(minute.match(/Your bank wrote /g)?.length).toBe(3);
		expect(minute).toContain("Once all 90 days are in");
		expect(minute.match(/Not done yet/g)?.length).toBe(1);
		// Lines 5 and 6, Your part and Linked Chase wait for the evening's scrolled picture.
		for (const later of [
			"Sort your spending",
			"Write your first budget",
			"Your part",
			"Linked Chase",
			"Once they&#39;re all in",
			"Tomorrow morning",
		]) {
			expect(minute, later).not.toContain(later);
		}
	});

	it("ends the evening with lines 1 to 4 found and nothing after them, then lines 5 and 6 and Your part in a scrolled picture", async () => {
		const { html } = await get("/design-system/proposals");
		const chunk = section(html);
		const evening = picture(chunk, "Option A, that evening");
		for (const words of [
			"Your last 90 days",
			"All 412 are in, from Jul 16 to Oct 13.",
			"Tally sorts the rest tonight, and your first budget will be ready by about 6 a.m.",
			"Nothing for you to do until then.",
		]) {
			expect(evening, words).toContain(words);
		}
		// The evening picture ends after line 4, so it has no line 5, line 6 or Your part.
		for (const later of [
			"Sort your spending",
			"Write your first budget",
			"Your part",
			"Linked Chase",
		]) {
			expect(evening, later).not.toContain(later);
		}
		const rest = picture(
			chunk,
			"Option A, that evening, scrolled: the rest, and your part",
		);
		expect(rest).toContain("Sort your spending");
		expect(rest).toContain("50 of 412 sorted so far. The rest tonight.");
		expect(rest).toContain("Write your first budget");
		expect(rest).toContain("Ready by about 6 a.m.");
		expect(rest).toContain(">Linked Chase<");
	});

	it("replays Option A over 8 seconds: the headline and status swap at 45%, and lines 1 to 4 turn found as the bank's lines arrive", async () => {
		const { html } = await get("/design-system/proposals");
		const replay = picture(
			section(html),
			"Option A, replay: Home fills itself in as the lines arrive",
		);
		expect(replay).toContain("replay");
		// The headline swaps from Reading Chase to Your last 90 days; the status swaps three times, ending on the evening's words.
		for (const words of [
			"Reading Chase",
			"Your last 90 days",
			"Reading Chase. The first month usually takes under a minute.",
			"142 transactions in so far, from Sep 14 to Oct 13.",
			"All 412 are in, from Jul 16 to Oct 13. Tally sorts the rest tonight, and your first budget will be ready by about 6 a.m.",
		]) {
			expect(replay, words).toContain(words);
		}
		expect(replay.match(/proposal-first-title-first/g)?.length).toBe(1);
		expect(replay.match(/proposal-first-title-last/g)?.length).toBe(1);
		// Four lines turn found (1, 3, 4 and then 2), each with its promise leaving; the three struck lines are the three bank lines.
		expect(replay.match(/proposal-first-promise/g)?.length).toBe(4);
		expect(replay.match(/proposal-first-strike/g)?.length).toBe(3);
		// Lines 1 to 4 only: no line 5 or 6, no sub, and no Your part.
		for (const later of [
			"Sort your spending",
			"Write your first budget",
			"50 of 412 sorted so far",
			"Ready by about 6 a.m.",
			"Once all 90 days are in",
			"Your part",
			"Linked Chase",
			"proposal-first-sub",
		]) {
			expect(replay, later).not.toContain(later);
		}
	});

	it("hides each bank line until its line turns found, and gives each line its own keyframes so each turns at its own point in the loop", async () => {
		const { html } = await get("/design-system/proposals");
		const replay = picture(
			section(html),
			"Option A, replay: Home fills itself in as the lines arrive",
		);
		// The bank's own line fades in with the fact, so no promise shows a bank line under it.
		for (const bank of [
			"ACME CORP PAYROLL PPD ID 4432",
			"ONLINE TRANSFER TO SAV ...5678",
			"SQ *BLUE BOTTLE COF 0217",
		]) {
			const at = replay.indexOf(bank);
			expect(at, bank).toBeGreaterThan(-1);
			const open = replay.lastIndexOf("<p ", at);
			expect(replay.slice(open, at), bank).toContain("proposal-first-fact");
		}
		// Lines 2, 3 and 4 name their own keyframes through their step classes, and each name is declared in app.css.
		for (const step of [
			"proposal-first-second-round",
			"proposal-first-later",
			"proposal-first-last",
		]) {
			expect(replay, step).toContain(step);
		}
		const names = [
			...css.matchAll(/--kf-[a-z]+: (replay-first-[a-z0-9-]+);/g),
		].map((m) => m[1] ?? "");
		expect(names).toHaveLength(15);
		for (const name of names) {
			expect(css, name).toContain(`@keyframes ${name} {`);
		}
	});

	it("drops the old drawing's entry labels, headings and struck lines from Option A", async () => {
		const { html } = await get("/design-system/proposals");
		const a = option(section(html), OPTIONS[0] ?? "");
		for (const gone of [
			">Paid<",
			">Comes back every month<",
			">Left out<",
			">Named<",
			">Where it goes<",
			"Tally&#39;s entry",
			"What Tally fills in",
			"Three of your lines",
			"proposal-first-strike-later",
			"proposal-first-strike-last",
			"proposal-first-rows",
			"7 paychecks since Jul 17",
			"31 stores",
		]) {
			expect(a, gone).not.toContain(gone);
		}
	});

	it("adds no client JavaScript: the section has no script", async () => {
		const { html } = await get("/design-system/proposals");
		expect(section(html)).not.toContain("<script");
	});
});

// P125, round E (#95): the stroke list, the fixes to C and D, and option E (proposal only: nothing in the app changes).
describe("GET /design-system/proposals, P125 round E (the stroke list, C and D fixed, option E)", () => {
	const drawn = async () => (await get("/design-system/proposals")).html;
	const section = (html: string) => {
		const start = html.indexOf('<section id="p125-first-week"');
		expect(start).toBeGreaterThan(-1);
		const end = html.indexOf('<section aria-labelledby="polish4-title"', start);
		expect(end).toBeGreaterThan(start);
		return html.slice(start, end);
	};
	// One labelled phone picture: from its label to the next picture's.
	const picture = (chunk: string, label: string) => {
		const at = chunk.indexOf(`role="img" aria-label="${label}, on a phone"`);
		expect(at, label).toBeGreaterThan(-1);
		const next = chunk.indexOf('role="img" aria-label="', at + 1);
		return chunk.slice(at, next === -1 ? undefined : next);
	};
	// One option: from its heading to the next option's heading.
	const option = (chunk: string, name: string) => {
		const heads = [...chunk.matchAll(/<h4 /g)].map((m) => m.index ?? 0);
		const at = heads.find((i) => chunk.slice(i, i + 400).includes(`>${name}`));
		expect(at, name).toBeDefined();
		const next = heads.find((i) => i > (at ?? 0));
		return chunk.slice(at, next);
	};
	// The notebook's own strokes (its tally lines), not the list's glyphs: their coordinates are the notebook's.
	const notebookStrokes = (s: string) =>
		s.match(/<line x1="(41|46|53|60|67)" [^>]*stroke-(ink|muted)/g)?.length ??
		0;
	// The list's glyphs that are not done yet: a dashed stroke.
	const dashedGlyphs = (s: string) =>
		s.match(/stroke-dasharray="3 3"/g)?.length ?? 0;

	it("draws the five strokes as a list under the notebook: each line's glyph, name and note, and a done line says so in words", async () => {
		const chunk = section(await drawn());
		const welcome = picture(chunk, "Option C, welcome");
		expect(welcome).toContain("Your first tally · 0 of 5");
		expect(welcome.match(/<li class="flex min-h-11/g)?.length).toBe(5);
		expect(dashedGlyphs(welcome)).toBe(5);
		expect(welcome).toContain("Link your bank");
		expect(welcome).toContain("Next");
		const evening = picture(
			chunk,
			"Option C, that evening, one stroke in pencil",
		);
		expect(evening).toContain("Your first tally · 1 of 5");
		expect(evening).toContain("Chase, linked");
		expect(evening).toContain('<span class="sr-only">, done</span>');
		expect(evening).toContain("86 to go");
		expect(dashedGlyphs(evening)).toBe(4);
	});

	it("draws C's bills step as its own picture: three strokes, step four Next, and the eight possible bills", async () => {
		const chunk = section(await drawn());
		const bills = picture(
			chunk,
			"Option C, the bills step, three strokes in pencil",
		);
		expect(bills).toContain(
			"Three. Tally found 8 charges that come back every month. Keep the real ones and that&#39;s four.",
		);
		expect(bills).toContain("8 possible bills found");
		expect(bills).toContain("From repeat charges in the last 3 months");
		expect(bills).toContain("Your first tally · 3 of 5");
		expect(bills).toContain("Keep a bill");
		expect(dashedGlyphs(bills)).toBe(2);
		expect(notebookStrokes(bills)).toBe(3);
	});

	it("says Harbor Property and 7 more at four strokes, and ends on Thursday with the fifth stroke done and $1,398", async () => {
		const chunk = section(await drawn());
		const four = picture(chunk, "Option C, four strokes in pencil");
		expect(four).toContain("Harbor Property and 7 more");
		expect(four).toContain(
			"Four. Tomorrow Tally keeps count on its own, and that&#39;s the fifth.",
		);
		expect(four).toContain("Your first tally · 4 of 5");
		const thursday = picture(chunk, "Option C, five strokes in ink");
		expect(thursday).toContain("$1,398");
		expect(thursday).toContain(
			"Five. Overnight Tally kept count on its own: 3 new transactions, all sorted. You&#39;re set up.",
		);
		expect(thursday).toContain("Your first tally · 5 of 5");
		expect(thursday).toContain(
			"From tomorrow this list goes, and Home is just Home.",
		);
		expect(dashedGlyphs(thursday)).toBe(0);
	});

	it("shows Your first tally · 2 of 5 on the Home behind the budget walk", async () => {
		const chunk = section(await drawn());
		const walk = picture(
			chunk,
			"Option C, the budget walk, two strokes in pencil",
		);
		expect(walk).toContain("Your first tally · 2 of 5");
		expect(walk).toContain("Budget 1 of 12");
	});

	it("says where D's Groceries suggestion comes from, and asks a category with no history a question of its own", async () => {
		const chunk = section(await drawn());
		const question = picture(
			chunk,
			"Option D, a question page, the suggested amount in pencil",
		);
		expect(question).toContain(
			"Your bank shows Groceries spent $610 in August and $674 in September.",
		);
		expect(question).toContain("From Chase · 412 lines · Jul 16 to Oct 13");
		expect(question).toContain("Make $650 a month your Groceries budget?");
		expect(question).toContain("Yes, $650 a month");
		expect(question).toContain("Another amount");
		expect(question).toContain("Not now");
		expect(question).toContain("4 of 14");
		expect(question).not.toContain(">Chase · 412 lines");
		const none = picture(
			chunk,
			"Option D, a category with no history, a blank amount",
		);
		expect(none).toContain("13 of 14");
		expect(none).toContain(
			"Your bank shows nothing for Date Night in August or September.",
		);
		expect(none).toContain("Do you want a Date Night budget?");
		expect(none).toContain("Date Night, a month");
		expect(none).toContain("Save this budget");
		expect(none).toContain("No Date Night budget");
		expect(none).not.toContain("Last month: ");
		expect(none).not.toContain("3-month average: ");
		expect(none).not.toContain("Suggested, not kept yet");
		expect(none).not.toContain("$650");
	});

	it("tells D's next morning that the questions come from the last 90 days, and that the pay, the bills and the budgets come next", async () => {
		const chunk = section(await drawn());
		const morning = picture(
			chunk,
			"Option D, next morning, with the amount a pencil blank",
		);
		expect(morning).toContain(
			"Tally read your last 90 days from Chase and sorted 362 overnight. It has 14 questions for you, and Safe to spend is written in at the end.",
		);
		expect(morning).toContain(
			"Your pay first, then your bills, then a budget for each category that spent something.",
		);
	});

	it("draws option E's eight pictures and its replay, each with its words", async () => {
		const chunk = section(await drawn());
		const e = option(chunk, "Option E · The notebook, one question at a time");
		const phones = [
			...e.matchAll(/role="img" aria-label="([^"]*), on a phone"/g),
		].map((m) => m[1] ?? "");
		expect(phones).toHaveLength(9);
		expect(
			phones.filter((p) => p.toLowerCase().includes("replay")),
		).toHaveLength(1);
		const before = picture(
			chunk,
			"Option E, before a bank, five strokes in pencil",
		);
		expect(before).toContain("Five strokes, and you&#39;re set up.");
		expect(before).toContain("Link a bank");
		expect(before).toContain(
			"Tally can only read your bank. It can&#39;t move money.",
		);
		expect(before).toContain("Your first tally · 0 of 5");
		expect(before).toContain("About a minute");
		expect(notebookStrokes(before)).toBe(0);
		const evening = picture(chunk, "Option E, that evening, one stroke in ink");
		expect(evening).toContain(
			"One. Tally&#39;s reading your last 90 days from Chase. Your questions will be ready in the morning.",
		);
		expect(evening).toContain("Nothing for you to do until then.");
		expect(evening.match(/Tomorrow morning/g)?.length).toBe(3);
		expect(notebookStrokes(evening)).toBe(1);
		const morning = picture(
			chunk,
			"Option E, next morning, three things to check",
		);
		expect(morning).toContain(
			"Tally sorted 362 overnight. Three things to check, and Safe to spend is written in at the end.",
		);
		expect(morning).toContain("Three things to check");
		expect(morning).toContain("About three minutes.");
		const pay = picture(chunk, "Option E, your pay, one question");
		expect(pay).toContain(
			"Your bank shows ACME CORP PAYROLL paying $2,450 every other Friday, 7 times since Jul 17.",
		);
		expect(pay).toContain("Is this your pay?");
		expect(pay).toContain("Yes, that&#39;s my pay");
		expect(pay).toContain("No, it&#39;s something else");
		expect(pay).toContain("From Chase · 412 lines · Jul 16 to Oct 13");
		expect(pay).toContain("Moves between your accounts · 6 left out");
		expect(pay).toContain("1 of 5");
		expect(notebookStrokes(pay)).toBe(1);
		const budgets = picture(
			chunk,
			"Option E, your budgets, keep all or one at a time",
		);
		expect(budgets).toContain("Keep all 12 budgets, $4,050 a month?");
		expect(budgets).toContain("Keep all 12");
		expect(budgets).toContain("One at a time");
		expect(budgets).toContain(
			"Once set, a budget can be changed on Home but not removed.",
		);
		expect(budgets).toContain("Pay · Acme Corp, $2,450 every other Friday");
		expect(budgets).toContain("Bills · 8 kept, about $2,062 a month");
		expect(budgets).toContain("7 more · $1,120 a month");
		expect(budgets).toContain("Aug $610 · Sep $674");
		for (const tag of ["$650", "$320", "$180", "$1,600"]) {
			expect(budgets, tag).toContain(tag);
		}
		expect(budgets).toContain("3 of 5");
		expect(notebookStrokes(budgets)).toBe(3);
		const one = picture(chunk, "Option E, one at a time, Groceries");
		expect(one).toContain("Budgets · 1 of 12");
		expect(one).toContain("Skip this one");
		expect(one).toContain("Make $650 a month your Groceries budget?");
		expect(one).toContain("Yes, $650 a month");
		expect(notebookStrokes(one)).toBe(3);
		const total = picture(chunk, "Option E, ruled off, four strokes");
		expect(total).toContain(
			"Four. Tomorrow Tally keeps count on its own, and that&#39;s the fifth.",
		);
		expect(total).toContain("$1,411");
		expect(total).toContain("Go to Home");
		expect(total).toContain("−$2,486");
		expect(notebookStrokes(total)).toBe(4);
		const thursday = picture(chunk, "Option E, Thursday, five strokes in ink");
		expect(thursday).toContain("$1,398");
		expect(thursday).toContain("Your first tally · 5 of 5");
		expect(thursday).toContain(
			"From tomorrow this list goes, and Home is just Home.",
		);
		expect(notebookStrokes(thursday)).toBe(5);
		const replay = picture(
			chunk,
			"Option E, replay: the bills question is answered, its line writes in, and its stroke inks in the notebook",
		);
		// The replay is one phone: the notebook at size-20 beside the headline, its counter going from 2 of 5 to 3 of 5.
		expect(replay).toContain("Your first page");
		expect(replay).toContain("size-20");
		expect(replay).not.toContain("size-12");
		expect(replay).toContain("2 of 5");
		expect(replay).toContain("3 of 5");
		expect(notebookStrokes(replay)).toBe(3);
		// The ledger: Pay is there, and the Bills line writes in after it.
		expect(replay).toContain("Pay · Acme Corp, $2,450 every other Friday");
		expect(replay).toContain("Bills · 8 kept, about $2,062 a month");
		// The bills question as it was answered: the muted sentence, its heading, the primary button and the quiet one.
		expect(replay).toContain(
			"Your bank shows 8 charges that come back every month, about $2,062 in all: Harbor Property $1,600, Geico $142, Spectrum $70 and 5 more.",
		);
		expect(replay).toContain("Keep these 8 as bills?");
		expect(replay).toContain("Keep these 8");
		expect(replay).toContain("Choose which");
		// Each moving part is a replay class of its own, and the answer's stroke is drawn, not a stroke-after delay.
		for (const cls of [
			"proposal-first-answer",
			"proposal-first-press",
			"proposal-first-bills",
			"proposal-first-draw",
			"proposal-first-counter-before",
			"proposal-first-counter-after",
		]) {
			expect(replay, cls).toContain(cls);
		}
		expect(replay).not.toContain("proposal-first-stroke-after");
		expect(replay).not.toContain("proposal-first-cross");
	});

	it("captions Option E's replay in words, every 6 seconds, as the brief words it", async () => {
		const chunk = section(await drawn());
		expect(chunk).toContain(
			"Replay, every 6 seconds: you answer the bills question, its line is written in, and its stroke inks in the notebook.",
		);
	});

	it("gives the Recommended and Picked pills to option E alone, and takes both off option A", async () => {
		const chunk = section(await drawn());
		expect(chunk.match(/>Recommended</g)?.length).toBe(1);
		expect(chunk.match(/>Picked</g)?.length).toBe(1);
		const e = option(chunk, "Option E · The notebook, one question at a time");
		expect(e).toContain(">Recommended<");
		expect(e).toContain(">Picked<");
		const a = option(chunk, "Option A · The Opening Entry");
		expect(a).not.toContain(">Recommended<");
		expect(a).not.toContain(">Picked<");
	});
});

// P127 (#500 part 1): Home's Safe to spend row on a small phone, drawn for the owner's pick. Each picture
// is Home's top at 320, 360 or 390 px, so the drawing and the amount are measured where they really lay out.
describe("GET /design-system/proposals, P127 · Safe to spend on a small phone (#500)", () => {
	const drawn = async () => (await get("/design-system/proposals")).html;
	// Each option's chunk, from its heading to the next (the first chunk is the note above the first option).
	const options = (chunk: string) => chunk.split("<h4 ").slice(1);
	// Each picture under an option, from its label on, up to the next picture's label.
	const pictures = (chunk: string) =>
		chunk.split('role="img" aria-label="').slice(1);
	const captions = (chunk: string) =>
		[...chunk.matchAll(/<figcaption[^>]*>([^<]*)<\/figcaption>/g)].map(
			(m) => m[1] ?? "",
		);
	const AMOUNTS = ["$9,999", "−$9,999"];
	const WIDTHS = [320, 360, 390];
	// Tailwind's spacing step is 4 px: pr-16 is 64 px, pr-4 is 16 px, pr-2 is 8 px.
	const ROOM: Record<number, string> = {
		320: "pr-16",
		360: "pr-4",
		390: "pr-2",
	};
	const ROOM_PX: Record<number, number> = { 320: 64, 360: 16, 390: 8 };
	// Option A's drawing shows from this frame width up: decision 116's 390 px edge for amounts of 7 characters or fewer.
	const N = 390;
	// The one frame height: the tallest picture's content, Option C's, measured in Chrome at 1280, 390 and 320 px.
	const FRAME_HEIGHT = 478;

	it("sits among the Picked sections, after P129 (decision 117) and before P126 (decision 115), titled and dated as the brief asks", async () => {
		const html = await drawn();
		const start = html.indexOf('<section aria-labelledby="p127-title"');
		expect(start).toBeGreaterThan(-1);
		expect(start).toBeGreaterThan(
			html.indexOf('<section aria-labelledby="p129-title"'),
		);
		expect(start).toBeLessThan(
			html.indexOf('<section aria-labelledby="p126-title"'),
		);
		expect(html).toContain(
			'<h2 id="p127-title" class="font-serif text-3xl font-semibold">Picked: Safe to spend on a small phone</h2>',
		);
		expect(html).not.toContain("Open: Safe to spend on a small phone");
		expect(html).toContain(
			"Drawn Oct 14 for issue #500. The owner&#39;s pick, marked Picked, is decision 116: A, no drawing below 390 px for amounts of 7 characters or fewer, and below 640 px for 8 or more, built in #566.",
		);
	});

	it("words and labels option A to decision 116 and what #566 built, and marks it Picked and Recommended", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		const [, a = ""] = options(chunk);
		expect(a).toContain(
			"Option A · No drawing below 390 px (640 px for 8 or more characters)",
		);
		expect(a).toContain(">Picked<");
		expect(a).toContain(">Recommended<");
		expect(chunk.split(">Picked<").length - 1).toBe(1);
		expect(a).toContain(
			"built in #566: home-top.tsx hides the drawing below 390 px for 7 characters or fewer and below 640 px for 8 or more",
		);
		expect(chunk).not.toContain("Pick one");
		expect(chunk).not.toContain("Pick how");
		expect(chunk).not.toContain("Open:");
	});

	it("draws P127 as one specimen with its title and its sentence over 320, 360 and 390 px", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		expect(chunk).toContain("P127 · Safe to spend on a small phone");
		expect(chunk).toContain(
			"Home&#39;s Safe to spend row at 320, 360 and 390 px, with $9,999 and −$9,999:",
		);
	});

	it("draws the reference and options A to C, each with six pictures: 320, 360, then 390 px, $9,999 then −$9,999", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		const list = options(chunk);
		expect(list.length).toBe(4);
		expect(list[0]).toContain("Reference · Before #566&#39;s drawing rule");
		expect(list[0]).toContain(
			'aria-label="Reference · Before #566&#39;s drawing rule, 320 px wide, with $9,999, on a phone"',
		);
		expect(list[1]).toContain(`Option A · No drawing below ${N} px`);
		expect(list[2]).toContain("Option B · A smaller drawing on phones");
		expect(list[3]).toContain("Option C · The drawing under the amount");
		const expected = WIDTHS.flatMap((w) =>
			AMOUNTS.map((a) => `${w} px wide, with ${a}, on a phone`),
		);
		for (const option of list) {
			const labels = pictures(option).map((p) => p.slice(0, p.indexOf('"')));
			// A label is "<option name>, <width> px wide, with <amount>, on a phone"; names have no commas.
			expect(
				labels.map((label) => label.split(", ").slice(1).join(", ")),
			).toEqual(expected);
		}
	});

	it("lays each picture out in a frame as wide as its phone, 320, 360 or 390 px, as a container, all one height", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		const frames = [...chunk.matchAll(/<div role="img"[^>]*class="([^"]*)"/g)];
		expect(frames.length).toBe(24);
		frames.forEach((frame, i) => {
			const width = WIDTHS[Math.floor(i / 2) % 3];
			expect(frame[1]).toContain(`w-[${width}px]`);
			expect(frame[1]).toContain("@container");
		});
		// Every frame shares one height: the tallest picture's content, measured in Chrome. Not the 420 px of
		// the first draft, nor the 442 px before How this works, nor the 498 px before the Start here link,
		// nor the 522 px with How this works under the status.
		const heights = new Set(
			frames.map((frame) => frame[1]?.match(/h-\[\d+px\]/)?.[0]),
		);
		expect(heights.size).toBe(1);
		expect(heights.has("h-[420px]")).toBe(false);
		expect(heights.has("h-[442px]")).toBe(false);
		expect(heights.has("h-[498px]")).toBe(false);
		expect(heights.has("h-[522px]")).toBe(false);
		expect(heights.has(`h-[${FRAME_HEIGHT}px]`)).toBe(true);
	});

	it("gives each width room for its widest spill, and each row's two frames fit the card", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		const wrappers = [
			...chunk.matchAll(/<div class="([^"]*)"><div role="img"/g),
		];
		expect(wrappers.length).toBe(24);
		wrappers.forEach(([, cls = ""], i) => {
			const width = WIDTHS[Math.floor(i / 2) % 3] ?? 0;
			expect(cls).toContain(ROOM[width]);
		});
		// The grid lays out one width per row: two columns, not the three-row flow of the first draft.
		expect(chunk.match(/grid w-max grid-cols-2 gap-x-4 gap-y-6/g)?.length).toBe(
			4,
		);
		expect(chunk).not.toContain("grid-rows-2");
		const cards = [
			...chunk.matchAll(
				/class="flex min-w-0 max-w-full flex-col gap-4 w-\[(\d+)px\]"/g,
			),
		];
		expect(cards.length).toBe(4);
		// The widest row is 390 px with 8 px of room, beside itself with a 16 px gap: 2 × 398 + 16 = 812 px.
		const widest = Math.max(...WIDTHS.map((w) => w + (ROOM_PX[w] ?? 0)));
		expect(2 * widest + 16).toBeLessThanOrEqual(824);
		for (const [, width = "0"] of cards)
			expect(Number(width)).toBeGreaterThanOrEqual(822);
	});

	it("keeps the minus with its number: every amount is one nowrap run", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		const amounts = [
			...chunk.matchAll(/<p class="[^"]*whitespace-nowrap[^"]*">([^<]*)<\/p>/g),
		].map((m) => m[1]);
		expect(amounts.length).toBe(24);
		expect(amounts.filter((a) => a === "−$9,999").length).toBe(12);
		expect(amounts.filter((a) => a === "$9,999").length).toBe(12);
	});

	it("hides option A's drawing below 390 px and shows it from 390 px up, by the frame's own width", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		const [, a = ""] = options(chunk);
		expect(a).toMatch(
			new RegExp(`class="[^"]*\\bhidden\\b[^"]*@min-\\[${N}px\\]:block`),
		);
		expect(a).not.toContain("@min-[360px]");
		expect(a).not.toContain("@min-[375px]");
		expect(a).not.toMatch(/size-18/);
	});

	it("words Option A as decision 116's rule: no drawing below 390 px for 7 characters or fewer, below 640 px for 8 or more", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		const [, a = ""] = options(chunk);
		expect(a).toContain("390 px");
		expect(a).toContain("640 px");
		expect(a).toContain("7 characters or fewer");
		expect(a).toContain("8 or more");
		expect(a).toContain(
			"No picture&#39;s amount reaches 8 characters, so the pictures show only the 390 px edge.",
		);
		expect(a).not.toContain("375");
	});

	it("puts the real month navigation in every picture, inside its inert page, so its links take no focus", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		expect(chunk.match(/aria-label="Months"/g)?.length).toBe(24);
		expect(chunk.match(/>October<\/h1>/g)?.length).toBe(24);
	});

	it("draws the demo banner above the masthead in every picture, with its Start here link, as the demo Home does", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		const banner = "Demo data. Nothing here is real.";
		const startHere = 'href="/how-it-works#start-here"';
		expect(chunk.match(/Demo data\. Nothing here is real\./g)?.length).toBe(24);
		expect(chunk.match(/href="\/how-it-works#start-here"/g)?.length).toBe(24);
		for (const picture of pictures(chunk)) {
			const at = picture.indexOf(banner);
			expect(at).toBeGreaterThan(-1);
			expect(picture.indexOf(startHere)).toBeGreaterThan(at);
			expect(picture.indexOf(startHere)).toBeLessThan(
				picture.indexOf('aria-label="Tally home"'),
			);
		}
	});

	it("draws no How this works in P127's pictures: main's HomeTop leaves it to HowFoot at Home's foot (#592)", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		expect(chunk).not.toContain('aria-label="How this works: the budget"');
		expect(chunk).not.toContain(">How this works<");
		// Every picture still draws its status sentence: 12 under $9,999 and 12 under −$9,999.
		expect(chunk.match(/Eating Out is \$36 over\./g)?.length).toBe(12);
		expect(chunk.match(/Over budget this month\./g)?.length).toBe(12);
	});

	it("draws option B's drawing at 72 px (size-18) with a 16 px gap on phones", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		const [, , b = ""] = options(chunk);
		expect(b).toMatch(/size-18/);
		// The row's own gap, not the card's (the card also has gap-4 in the next option's chunk).
		expect(b).toMatch(/justify-between gap-4"/);
	});

	it("draws option C's drawing after the amount on phones, under the amount row", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		const [, , , c = ""] = options(chunk);
		const pictureList = pictures(c);
		expect(pictureList.length).toBe(6);
		for (const picture of pictureList) {
			const amount = picture.search(/>−?\$9,999</);
			const under = picture.indexOf('data-drawing="under"');
			expect(amount).toBeGreaterThan(-1);
			expect(under).toBeGreaterThan(amount);
		}
	});

	it("draws the Fixed note with #566 as on main, its minus fix in every picture, #388's size rule and that the drawing is decoration", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		expect(chunk).not.toContain("Fixed already");
		expect(chunk).not.toContain("not on main yet");
		expect(chunk).toContain(
			"In every picture: </span>#566, now on main, keeps the minus with its number; #388&#39;s size rule steps a long amount down; the drawing is decoration and never carries meaning.",
		);
	});

	it("draws the Reference note as main before #566's drawing rule, with the minus kept with its number", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		expect(chunk).toContain(
			"Before #566&#39;s drawing rule: the 112 px notebook sits beside the amount at every width, with the minus kept on its number.",
		);
		expect(chunk).not.toContain("What main draws now");
	});

	it("marks exactly one option Recommended, and all six of its pictures say Fits", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		const recommended = options(chunk).filter((o) =>
			o.includes(">Recommended<"),
		);
		expect(recommended.length).toBe(1);
		const own = captions(recommended[0] ?? "");
		expect(own).toHaveLength(6);
		for (const caption of own) expect(caption.endsWith(": Fits")).toBe(true);
	});

	it("captions every picture under it with its measured fit: Fits, or Spills N px", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		const all = captions(chunk);
		expect(all.length).toBe(24);
		for (const caption of all)
			expect(caption).toMatch(/: (Fits|Spills \d+ px)$/);
		// Each caption sits under its picture: the frame and its wrapper close, then the caption opens.
		expect(chunk.match(/<\/div><\/div><figcaption/g)?.length).toBe(24);
	});
});

// P136 (#602, the owner's pick to draw): what Bills' Upcoming and Paid this month totals count. Proposal only: nothing in the app changes.
describe("GET /design-system/proposals, P136 (what Bills' section totals count, #602)", () => {
	const drawn = async () => (await get("/design-system/proposals")).html;
	const count = (text: string, part: string) => text.split(part).length - 1;
	// Each option's chunk, from its heading to the next (the first chunk is the note above the first option).
	const options = (chunk: string) => chunk.split("<h4 ").slice(1);
	// Each status group under a picture: a div with the class mt-4, up to the end of its list.
	const groupsOf = (chunk: string) =>
		chunk
			.split('<div class="mt-4">')
			.slice(1)
			.map((group) => group.slice(0, group.indexOf("</ul>") + "</ul>".length));
	const NAMES = [
		"Reference · Today on main",
		"Option A · Each heading says what it counts",
		"Option B · Paid counts its rows",
	];
	const UPCOMING_LINE = "Includes Daycare&#39;s Fridays on Oct 23 and 30";
	const PAID_LINE = "Includes Daycare&#39;s Fridays on Oct 2 and 9";

	it("sits first among the Picked sections, straight after the page's intro and before P128, titled and dated as the brief asks", async () => {
		const html = await drawn();
		const intro = html.indexOf("Back to the design system");
		const start = html.indexOf(
			'<section aria-labelledby="p136-title" class="mt-12">',
		);
		expect(start).toBeGreaterThan(intro);
		expect(html.slice(intro, start)).not.toContain("<section ");
		expect(start).toBeLessThan(
			html.indexOf('<section aria-labelledby="p128-title" class="mt-12">'),
		);
		expect(html).toContain(
			'<h2 id="p136-title" class="font-serif text-3xl font-semibold">Picked: what Bills&#39; totals count</h2>',
		);
		expect(html).toContain(
			"Drawn Oct 15. The owner&#39;s pick, marked Picked, is decision 122: A, each heading counts every occurrence in the month and says which ones aren&#39;t listed.",
		);
	});

	it("draws P136 as one specimen, titled and sentenced over 390 and 1280 px", async () => {
		const chunk = block(await drawn(), "p136-bills-totals");
		expect(chunk).toContain('<section id="p136-bills-totals"');
		expect(chunk).toContain("P136 · What Bills&#39; section totals count");
		expect(chunk).toContain(
			"Bills&#39; Upcoming and Paid this month totals, today and in options A and B, at 390 and 1280 px.",
		);
	});

	it("draws today on main and options A and B, each at 390 px and at 1280 px", async () => {
		const chunk = block(await drawn(), "p136-bills-totals");
		const list = options(chunk);
		expect(list.length).toBe(3);
		for (const [i, name] of NAMES.entries()) {
			expect(list[i]).toContain(name);
			const labels = [
				...(list[i] ?? "").matchAll(/role="img" aria-label="([^"]*)"/g),
			].map((m) => m[1]);
			expect(labels).toEqual([
				`${name} at 390 px, on a phone`,
				`${name} at 1280 px, on desktop`,
			]);
		}
	});

	it("draws Bills from its Due heading to Paid this month with the demo's rows, and lists only Daycare's next Friday", async () => {
		const chunk = block(await drawn(), "p136-bills-totals");
		for (const option of options(chunk)) {
			// Daycare's Oct 16 Friday is the row; its Oct 23 and 30 Fridays, and its paid Oct 2 and 9, are not rows.
			expect(count(option, ">Daycare</span>")).toBe(2);
			expect(count(option, "Due Oct 16 · every Friday")).toBe(2);
			expect(count(option, "Due Oct 18")).toBe(2);
			expect(count(option, "$68.33")).toBe(2);
			expect(count(option, "Due Jul 14, 2027")).toBe(2);
			expect(count(option, "Paid today")).toBe(4);
			expect(count(option, "$305.00")).toBe(2);
		}
	});

	it("keeps Upcoming's $480.00 this month with its line in A and B, and draws today's reference with no line", async () => {
		const chunk = block(await drawn(), "p136-bills-totals");
		const [today = "", a = "", b = ""] = options(chunk);
		expect(count(today, "$480.00 this month")).toBe(2);
		expect(count(today, UPCOMING_LINE)).toBe(0);
		for (const option of [a, b]) {
			expect(count(option, "$480.00 this month")).toBe(2);
			expect(count(option, UPCOMING_LINE)).toBe(2);
		}
	});

	it("reads Paid this month as $16.98 today and in B, and as $496.98 with its line in A, in both pictures", async () => {
		const chunk = block(await drawn(), "p136-bills-totals");
		const [today = "", a = "", b = ""] = options(chunk);
		for (const option of [today, b]) {
			expect(count(option, "$16.98")).toBe(2);
			expect(count(option, "$496.98")).toBe(0);
			expect(count(option, PAID_LINE)).toBe(0);
		}
		expect(count(a, "$496.98")).toBe(2);
		expect(count(a, "$16.98")).toBe(0);
		expect(count(a, PAID_LINE)).toBe(2);
	});

	it("sets each line under its heading: A's Upcoming and Paid lines come before their rows", async () => {
		const chunk = block(await drawn(), "p136-bills-totals");
		const [, a = ""] = options(chunk);
		for (const [heading, line] of [
			["Upcoming</h2>", UPCOMING_LINE],
			["Paid this month</h2>", PAID_LINE],
		] as const) {
			const groups = groupsOf(a ?? "").filter((g) => g.includes(heading));
			expect(groups.length).toBe(2);
			for (const group of groups)
				expect(group.indexOf(heading)).toBeLessThan(group.indexOf(line));
		}
	});

	it("draws B's Paid this month with its rows and no line, and keeps Upcoming's line", async () => {
		const chunk = block(await drawn(), "p136-bills-totals");
		const [, , b = ""] = options(chunk);
		const paid = groupsOf(b ?? "").filter((g) =>
			g.includes("Paid this month</h2>"),
		);
		expect(paid.length).toBe(2);
		for (const group of paid) {
			expect(group).toContain("$16.98");
			expect(group).not.toContain("Includes");
		}
		const upcoming = groupsOf(b ?? "").filter((g) =>
			g.includes("Upcoming</h2>"),
		);
		expect(upcoming.length).toBe(2);
		for (const group of upcoming) expect(group).toContain(UPCOMING_LINE);
	});

	it("weighs A and B in words: A is recommended, each option gives its trade-off and why", async () => {
		const chunk = block(await drawn(), "p136-bills-totals");
		const [today = "", a = "", b = ""] = options(chunk);
		expect(count(today ?? "", "Recommended")).toBe(0);
		expect(count(a ?? "", "Recommended")).toBe(1);
		expect(count(b ?? "", "Recommended")).toBe(0);
		expect(a).toContain(
			"Trade-off: Paid&#39;s total adds the month&#39;s paid occurrences;",
		);
		expect(a).toContain(
			"Why: “Paid this month” means what the family paid, and the two headings count the same way.",
		);
		expect(b).toContain("Trade-off: the line under Upcoming only.");
		expect(b).toContain(
			"Why: a heading&#39;s total matches what&#39;s under it wherever it can.",
		);
	});

	it("gives A and B the brief's notes word for word, and A's line rule under its note", async () => {
		const chunk = block(await drawn(), "p136-bills-totals");
		const [, a = "", b = ""] = options(chunk);
		expect(a).toContain(
			'<p class="text-sm">Both headings count every occurrence in the month, and say which ones aren&#39;t listed.</p>',
		);
		expect(a).toContain(
			'<p class="text-sm">The muted line names up to two bills, then “and 2 more”.</p>',
		);
		expect(b).toContain(
			'<p class="text-sm">Paid is exactly its rows; Upcoming says what else it counts.</p>',
		);
	});

	it("gives option A the Recommended and Picked pills together, and B and today's reference neither (decision 122)", async () => {
		const chunk = block(await drawn(), "p136-bills-totals");
		const [today = "", a = "", b = ""] = options(chunk);
		const heading = (option: string) =>
			option.slice(0, option.indexOf("</h4>"));
		expect(heading(a)).toContain(">Recommended<");
		expect(heading(a)).toContain(">Picked<");
		for (const option of [today, b]) {
			expect(heading(option)).not.toContain(">Recommended<");
			expect(heading(option)).not.toContain(">Picked<");
		}
	});

	it("shows Bills as the current page in every picture: the phone's tab bar and the desktop sidebar", async () => {
		const chunk = block(await drawn(), "p136-bills-totals");
		for (const option of options(chunk)) {
			expect(option).toContain('<nav class="absolute inset-x-0 bottom-0');
			const bar = option.slice(
				option.indexOf('<nav class="absolute inset-x-0 bottom-0'),
				option.indexOf("</nav>", option.indexOf('<nav class="absolute')),
			);
			const tabs = bar.split(/<li[ >]/).slice(1);
			const current = tabs.filter((tab) =>
				tab.slice(0, tab.indexOf(">")).includes("text-accent"),
			);
			expect(current.length).toBe(1);
			expect(current[0]).toContain('data-icon="bills"');
			expect(option).toMatch(/<a href="\/bills" class="[^"]*text-accent/);
			expect(option).not.toMatch(/<a href="\/" class="[^"]*text-accent/);
		}
	});

	it("draws each bill with the demo's category icon and colour, as the seed names them", async () => {
		const chunk = block(await drawn(), "p136-bills-totals");
		const categories = buildSeed("2026-10-15").categories;
		const look = (name: string) => {
			const category = categories.find((c) => c.name === name);
			expect(category, name).toBeDefined();
			return category;
		};
		const household = look("Household");
		const childcare = look("Childcare");
		const kids = look("Kids");
		const expected: [string, { icon: string; color: string } | undefined][] = [
			["Internet", household],
			["Streaming", household],
			["Water", household],
			["Daycare", childcare],
			["Soccer league", kids],
		];
		for (const option of options(chunk)) {
			for (const [name, category] of expected) {
				const rows = option
					.split(/<li[ >]/)
					.filter((li) => li.includes(`>${name}</span>`));
				// One row per picture: the phone's and the desktop's.
				expect(rows.length, name).toBe(2);
				for (const row of rows) {
					expect(row, name).toContain(`data-icon="${category?.icon}"`);
					expect(row, name).toContain(`text-${category?.color}`);
				}
			}
		}
	});

	it("links each drawn bill to its demo bill, by the id src/demo/reset.ts gives it", async () => {
		const chunk = block(await drawn(), "p136-bills-totals");
		const demo: [string, number][] = [
			["Internet", 5],
			["Daycare", 8],
			["Soccer league", 6],
			["Streaming", 1],
			["Water", 2],
		];
		for (const [name, id] of demo) {
			expect(resetSource, name).toMatch(
				new RegExp(`\\[\\s*${id},\\s*"${name}"`),
			);
		}
		for (const option of options(chunk)) {
			for (const [name, id] of demo) {
				const rows = option
					.split(/<li[ >]/)
					.filter((li) => li.includes(`>${name}</span>`));
				// One row per picture: the phone's and the desktop's.
				expect(rows.length, name).toBe(2);
				for (const row of rows)
					expect(row, name).toContain(`href="/bills/${id}"`);
			}
		}
	});

	it("draws the demo's Planned group between Upcoming and Paid this month in every picture, with its two plans", async () => {
		const chunk = block(await drawn(), "p136-bills-totals");
		for (const option of options(chunk)) {
			expect(count(option, ">Car registration<")).toBe(2);
			expect(count(option, ">Lawn service<")).toBe(2);
			expect(count(option, "$90.00 this month")).toBe(2);
			expect(count(option, "Set aside for September")).toBe(2);
			expect(count(option, "Set aside for October")).toBe(2);
			for (const picture of option.split('role="img" aria-label="').slice(1)) {
				const upcoming = picture.indexOf("Upcoming</h2>");
				const planned = picture.indexOf("Planned</h2>");
				const paid = picture.indexOf("Paid this month</h2>");
				expect(upcoming).toBeGreaterThan(-1);
				expect(upcoming).toBeLessThan(planned);
				expect(planned).toBeLessThan(paid);
			}
			const planGroups = groupsOf(option).filter((g) =>
				g.includes("Planned</h2>"),
			);
			expect(planGroups.length).toBe(2);
			for (const group of planGroups) {
				expect(group).toContain(">Car registration<");
				expect(group).toContain(">Lawn service<");
			}
		}
	});

	it("lists P136 in the decisions file as decision 122, after decision 119, with option A's words", () => {
		const rows = decisions.split("\n").filter((line) => line.startsWith("| "));
		const row =
			rows.find((line) =>
				line.startsWith("| 122 | 2026-10-15 | The owner's pick on P136 (#602)"),
			) ?? "";
		expect(row).not.toBe("");
		expect(rows.indexOf(row)).toBeGreaterThan(
			rows.findIndex((line) => line.startsWith("| 119 | ")),
		);
		expect(row).toContain("**P136 A:**");
		expect(row).toContain("This replaces Paid's rule from #612");
		expect(row).toContain("Decided by seeing (decision 47)");
	});

	it("states the totals rule in spec §8.4 as decision 122 does, and drops the old sentence", () => {
		expect(spec).toContain("listed as a row or not (decision 122)");
		expect(spec).not.toContain("counts its occurrences' remaining amounts");
	});

	it("adds no client JavaScript: the specimen has no script", async () => {
		expect(block(await drawn(), "p136-bills-totals")).not.toContain("<script");
	});
});

// P128 (#72 and #516): where the keyboard shortcuts list lives, drawn for the owner's sign-off. Proposal only: nothing in the app changes.
describe("GET /design-system/proposals, P128 (the keyboard shortcuts list)", () => {
	const drawn = async () => (await get("/design-system/proposals")).html;
	const section = (html: string) => {
		const start = html.indexOf('<section id="p128-keys"');
		expect(start).toBeGreaterThan(-1);
		const end = html.indexOf('<section aria-labelledby="p129-title"', start);
		expect(end).toBeGreaterThan(start);
		return html.slice(start, end);
	};
	// One option: from its heading to the next option's heading (the last runs to the section's end).
	const option = (chunk: string, name: string) => {
		const heads = [...chunk.matchAll(/<h4 /g)].map((m) => m.index ?? 0);
		const at = heads.find((i) => chunk.slice(i, i + 400).includes(`>${name}`));
		expect(at, name).toBeDefined();
		const next = heads.find((i) => i > (at ?? 0));
		return chunk.slice(at, next);
	};
	// The ledger row that holds some words: from the row's opening tag to its end.
	const rowOf = (chunk: string, words: string) => {
		const at = chunk.indexOf(words);
		expect(at, words).toBeGreaterThan(-1);
		return chunk.slice(
			chunk.lastIndexOf("<li", at),
			chunk.indexOf("</li>", at),
		);
	};
	// One picture, from its label to the end of its figure, so no other picture or caption comes in.
	const pictureOf = (chunk: string, label: string) => {
		const at = chunk.indexOf(`role="img" aria-label="${label}"`);
		expect(at, label).toBeGreaterThan(-1);
		return chunk.slice(at, chunk.indexOf("</figure>", at));
	};
	// Every disclosure that holds the keys: its opening tag (attributes only) and its summary.
	const keyDisclosures = (chunk: string) =>
		[...chunk.matchAll(/<details([^>]*)><summary[\s\S]*?<\/summary>/g)].filter(
			(m) => m[0].includes("Keyboard shortcuts"),
		);
	const isOpen = (attrs: string) => /\sopen\b/.test(attrs);

	it("sits before P129 and above P127 and P126 (decisions 118, 117, 116, 115), as the picked proposal with its heading and line", async () => {
		const html = await drawn();
		const p128 = html.indexOf('<section id="p128-keys"');
		const p129 = html.indexOf('<section aria-labelledby="p129-title"');
		const p127 = html.indexOf('<section aria-labelledby="p127-title"');
		const p126 = html.indexOf('<section aria-labelledby="p126-title"');
		expect(p128).toBeGreaterThan(-1);
		expect(p128).toBeLessThan(p129);
		expect(p129).toBeLessThan(p127);
		expect(p127).toBeLessThan(p126);
		expect(html).toContain(
			'<h2 id="p128-title" class="font-serif text-3xl font-semibold">Picked: the keyboard shortcuts list</h2>',
		);
		expect(html).toContain(
			"Drawn Oct 15. The owner&#39;s pick, marked Picked, is decision 118: C, a sheet that ? opens, with the extra keys and mono key chips.",
		);
		expect(html).not.toContain("Open: the keyboard shortcuts list");
		expect(html).not.toContain("Drawn Oct 15 for the owner&#39;s sign-off");
	});

	it("draws the Fixed box with decision 109's words, the keys and their rules", async () => {
		const chunk = section(await drawn());
		expect(chunk).toContain(
			"Already fixed by the spec: </span>Decision 109 (keyboard.js).",
		);
		expect(chunk).toContain("focuses search");
		expect(chunk).toContain("opens this list");
		expect(chunk).toContain("move between a list&#39;s rows");
		expect(chunk).toContain(
			"no key acts while typing in a field, with Ctrl, Alt or Cmd held, or while a sheet is open (Escape belongs to the sheet)",
		);
		expect(chunk).toContain(
			"the list is a &lt;details&gt; that reads without the script.",
		);
	});

	it("draws three options, C recommended and picked, A and B with neither, each with a note, a trade-off and a why", async () => {
		const chunk = section(await drawn());
		const names = [...chunk.matchAll(/<h4 [^>]*>([\s\S]*?)<\/h4>/g)].map(
			(m) => (m[1] ?? "").split("<")[0],
		);
		expect(names).toEqual([
			"A · A sidebar line that opens in place",
			"B · At the foot of the page",
			"C · A sheet, with the details as its fallback",
		]);
		expect(chunk.match(/>Recommended</g)?.length).toBe(1);
		expect(chunk.match(/>Picked</g)?.length).toBe(1);
		const c = option(chunk, "C · A sheet");
		expect(c).toContain(">Recommended<");
		expect(c).toContain(">Picked<");
		for (const name of [
			"A · A sidebar line that opens in place",
			"B · At the foot of the page",
		]) {
			const opt = option(chunk, name);
			expect(opt, name).not.toContain(">Recommended<");
			expect(opt, name).not.toContain(">Picked<");
		}
		expect(chunk.match(/Trade-off: /g)?.length).toBe(3);
		expect(chunk.match(/text-muted">Why: /g)?.length).toBe(3);
	});

	it("draws the one open More, shared by every option, above the options, with the whole ledger", async () => {
		const chunk = section(await drawn());
		const lead = chunk.indexOf(
			'<p class="max-w-prose text-sm">In every option, below lg (a phone, a narrow window or a tablet with a keyboard), More&#39;s contents end in a Keyboard shortcuts row: the same details, opening the same ledger.</p>',
		);
		const at = chunk.indexOf(
			'role="img" aria-label="All options, More with Keyboard shortcuts open, on a phone"',
		);
		const first = chunk.indexOf("<h4 ");
		expect(lead).toBeGreaterThan(chunk.indexOf("Already fixed by the spec"));
		expect(at).toBeGreaterThan(lead);
		expect(at).toBeLessThan(first);
		// Scrolled: it starts at the contents list, so no title sits above it.
		const shared = chunk.slice(at, first);
		expect(shared).not.toContain("<h1");
		expect(shared).not.toContain("to confirm");
		expect(shared).toContain(
			"Keys don&#39;t work while you&#39;re typing in a field. In a sheet, Escape closes it.",
		);
		// Exactly one More picture in the section is open, and it is this one.
		const more = [
			...chunk.matchAll(/role="img" aria-label="([^"]*More[^"]*)"/g),
		].map((m) => m[1] ?? "");
		expect(
			more.filter((label) =>
				/<details class="group"[^>]*\sopen\b/.test(pictureOf(chunk, label)),
			),
		).toEqual(["All options, More with Keyboard shortcuts open, on a phone"]);
	});

	it("draws each option's pictures: A three (closed, open, More), B three, C four", async () => {
		const chunk = section(await drawn());
		const a = option(chunk, "A · A sidebar");
		const b = option(chunk, "B · At the foot");
		const c = option(chunk, "C · A sheet");
		expect(a.match(PICTURE)?.length).toBe(3);
		expect(b.match(PICTURE)?.length).toBe(3);
		expect(c.match(PICTURE)?.length).toBe(4);
		// Home's pictures draw no How this works link: the foot pictures carry it, Home's status does not.
		for (const label of [
			"A, the sidebar closed, on desktop",
			"A, the sidebar open, on desktop",
			"C, the sheet over Home, on desktop",
			"C, the sheet open, on a phone",
		]) {
			expect(pictureOf(chunk, label), label).not.toContain(
				'aria-label="How this works: the budget"',
			);
		}
		expect(a).toContain(
			'role="img" aria-label="A, the sidebar closed, on desktop"',
		);
		expect(a).toContain(
			'role="img" aria-label="A, the sidebar open, on desktop"',
		);
		expect(a).toContain('role="img" aria-label="A, More, on a phone"');
		expect(b).toContain(
			'role="img" aria-label="B, the foot closed, on desktop"',
		);
		expect(b).toContain('role="img" aria-label="B, the foot open, on desktop"');
		expect(b).toContain('role="img" aria-label="B, More, on a phone"');
		expect(c).toContain(
			'role="img" aria-label="C, the sheet over Home, on desktop"',
		);
		expect(c).toContain(
			'role="img" aria-label="C, the sheet open, on a phone"',
		);
		expect(c).toContain(
			'role="img" aria-label="C, the fallback foot, on desktop"',
		);
		expect(c).toContain('role="img" aria-label="C, More, on a phone"');
		expect(chunk).not.toMatch(/, Home, on a phone/);
	});

	it("draws More below lg in each option: Accounts, Settings, How Tally works, then Keyboard shortcuts closed, with the Feedback pill in the top line", async () => {
		const chunk = section(await drawn());
		for (const name of ["A", "B", "C"]) {
			const more = pictureOf(chunk, `${name}, More, on a phone`);
			expect(more, name).toContain(">More</h1>");
			const at = [
				"Accounts",
				"Settings",
				"How Tally works",
				"Keyboard shortcuts",
			].map((words) => more.indexOf(words));
			expect(
				at.every((i) => i > -1),
				name,
			).toBe(true);
			expect(at, name).toEqual([...at].sort((x, y) => x - y));
			expect(more, name).toMatch(/<details class="group">/);
			expect(more, name).not.toMatch(/<details class="group"[^>]*\sopen\b/);
			// Closed, the ledger is still in the markup (the details reads without the script); the browser hides it.
			expect(more, name).toContain("Show these keys");
			expect(more.slice(0, more.indexOf("<h1")), name).toContain(
				'href="/feedback"',
			);
		}
	});

	it("draws the same ledger of keys in each open list, with its words, and no to-confirm tags or needs-your-yes line", async () => {
		const chunk = section(await drawn());
		for (const name of ["A · A sidebar", "B · At the foot", "C · A sheet"]) {
			const opt = option(chunk, name);
			expect(opt, name).not.toContain("to confirm");
			expect(opt, name).not.toContain("needs your yes");
			expect(rowOf(opt, "Search transactions")).toContain(">/</kbd>");
			expect(rowOf(opt, "Show these keys")).toContain(">?</kbd>");
			expect(rowOf(opt, "Next row / previous row")).toContain(">j</kbd>");
			expect(rowOf(opt, "Open the row")).toContain(">Enter</kbd>");
			expect(rowOf(opt, "Previous month / next month")).toContain(">←</kbd>");
			expect(rowOf(opt, "Undo it, while its toast shows")).toContain(
				">u</kbd>",
			);
			expect(opt).toContain(
				"Keys don&#39;t work while you&#39;re typing in a field. In a sheet, Escape closes it.",
			);
		}
	});

	it("gives every Keyboard shortcuts disclosure a group, a chevron that turns when open, and the marker hidden", async () => {
		const chunk = section(await drawn());
		const found = keyDisclosures(chunk);
		// Nine: A's sidebar (closed, open), B's foot (closed, open), C's fallback foot, three closed More rows and the shared open More.
		const summaries = chunk.match(/<summary[\s\S]*?<\/summary>/g) ?? [];
		expect(
			summaries.filter((s) => s.includes("Keyboard shortcuts")).length,
		).toBe(9);
		expect(found.length).toBe(9);
		for (const m of found) {
			expect(m[1], m[0]).toContain('class="group"');
			expect(m[0], m[0]).toContain("m9 18 6-6-6-6");
			expect(m[0], m[0]).toContain("group-open:rotate-90");
			expect(m[0], m[0]).toContain("list-none");
			expect(m[0], m[0]).toContain("[&amp;::-webkit-details-marker]:hidden");
		}
		// Open: A's sidebar, B's foot and the shared More.
		expect(found.filter((m) => isOpen(m[1] ?? "")).length).toBe(3);
	});

	it("draws the full sidebar in every desktop picture, with Keyboard shortcuts in the sidebar only in A's", async () => {
		const chunk = section(await drawn());
		const desktop = [
			...chunk.matchAll(/role="img" aria-label="([^"]*, on desktop)"/g),
		].map((m) => m[1] ?? "");
		expect(desktop.length).toBe(6);
		for (const label of desktop) {
			const frame = pictureOf(chunk, label);
			const aside = frame.slice(
				frame.indexOf("<aside"),
				frame.indexOf("</aside>"),
			);
			expect(aside, label).toContain("How Tally works");
			expect(aside, label).toContain("Feedback");
			expect(aside.includes("Keyboard shortcuts"), label).toBe(
				label.startsWith("A, "),
			);
		}
	});

	it("draws B's foot and C's fallback foot with How this works as the short-ruled link", async () => {
		const chunk = section(await drawn());
		for (const label of [
			"B, the foot closed, on desktop",
			"B, the foot open, on desktop",
			"C, the fallback foot, on desktop",
		]) {
			const frame = pictureOf(chunk, label);
			expect(frame, label).toContain('aria-label="How this works: the budget"');
			expect(frame, label).toContain("w-12 border-t border-muted");
			expect(frame, label).not.toContain("underline underline-offset-4");
			expect(frame.indexOf("How this works")).toBeLessThan(
				frame.indexOf("Keyboard shortcuts"),
			);
		}
	});

	it("draws C's sheet as the BottomSheet draws it: a rounded side panel, and a Cancel link in a footer under the ledger", async () => {
		const chunk = section(await drawn());
		const sheet = pictureOf(chunk, "C, the sheet over Home, on desktop");
		// The panel: the sheet's rounded left corner, and no rule on its edge (BottomSheet's desktop side panel).
		const panel = sheet.match(/<div class="([^"]*\binset-y-0 right-0\b[^"]*)"/);
		expect(panel?.[1] ?? "").toMatch(/\brounded-l-sheet\b/);
		expect(panel?.[1] ?? "").not.toMatch(/\bborder-l\b/);
		// The body keeps BottomSheet's p-5, and the footer sits under the ledger on a rule.
		const body = sheet.match(/<div class="([^"]*\boverflow-y-auto\b[^"]*)"/);
		expect(body?.[1] ?? "").toMatch(/\bp-5\b/);
		expect(body?.[1] ?? "").not.toMatch(/\bp-6\b/);
		const ledgerEnd = sheet.indexOf(
			"Keys don&#39;t work while you&#39;re typing in a field.",
		);
		expect(ledgerEnd).toBeGreaterThan(-1);
		const footer = sheet.indexOf("border-t border-rule", ledgerEnd);
		expect(footer).toBeGreaterThan(ledgerEnd);
		// Cancel is the secondary link back to the list, full width, and there is no Close button.
		expect(sheet.slice(footer)).toMatch(
			/<a href="#p128-keys" class="[^"]*\bw-full\b[^"]*">Cancel<\/a>/,
		);
		expect(sheet).not.toContain(">Close</button>");
		// The title is the ledger sheet's (DESIGN.md: font-serif, 2xl, semibold, tight tracking).
		expect(sheet).toContain(
			'<p class="font-serif text-2xl font-semibold tracking-tight">Keyboard shortcuts</p>',
		);
	});

	it("draws C's sheet at phone width as the BottomSheet draws it: a rounded sheet rising over the tab bar, with Home behind it", async () => {
		const chunk = section(await drawn());
		expect(option(chunk, "C · A sheet")).toContain(
			"Over Home on a phone: the sheet",
		);
		const sheet = pictureOf(chunk, "C, the sheet open, on a phone");
		// The panel: the phone sheet's rounded top corners, 754px at most (the BottomSheet's max height on an 844px
		// screen), and no rule on its edge. It has no side corner, since it is drawn from the screen's foot.
		const panel = sheet.match(
			/<div class="([^"]*\binset-x-0 bottom-0\b[^"]*)"/,
		);
		expect(panel, "panel").not.toBeNull();
		expect(panel?.[1] ?? "").toMatch(/\brounded-t-sheet\b/);
		expect(panel?.[1] ?? "").toMatch(/\bmax-h-\[754px\]/);
		expect(panel?.[1] ?? "").not.toMatch(/\brounded-l-sheet\b/);
		expect(panel?.[1] ?? "").not.toMatch(/\bborder-[tl]\b/);
		// The sheet covers the tab bar: the tab bar comes first, then the dimmed backdrop, then the panel over both.
		const nav = sheet.indexOf("<nav");
		expect(nav).toBeGreaterThan(-1);
		expect(sheet.indexOf("bg-ink/30")).toBeGreaterThan(nav);
		expect(sheet.indexOf(panel?.[0] ?? "")).toBeGreaterThan(nav);
		// The body keeps BottomSheet's p-5, and the footer sits under the ledger on a rule.
		const body = sheet.match(/<div class="([^"]*\boverflow-y-auto\b[^"]*)"/);
		expect(body?.[1] ?? "").toMatch(/\bp-5\b/);
		const ledgerEnd = sheet.indexOf(
			"Keys don&#39;t work while you&#39;re typing in a field.",
		);
		expect(ledgerEnd).toBeGreaterThan(-1);
		const footer = sheet.indexOf("border-t border-rule", ledgerEnd);
		expect(footer).toBeGreaterThan(ledgerEnd);
		// Cancel stays in view under the ledger, and there is no Close button.
		expect(sheet.slice(footer)).toMatch(
			/<a href="#p128-keys" class="[^"]*\bw-full\b[^"]*">Cancel<\/a>/,
		);
		expect(sheet).not.toContain(">Close</button>");
		// The title is the ledger sheet's, as on the desktop.
		expect(sheet).toContain(
			'<p class="font-serif text-2xl font-semibold tracking-tight">Keyboard shortcuts</p>',
		);
		// Home is behind it: its title, its amount and the Feedback pill in the top line, and no How this works link.
		expect(sheet).toContain(">October</h1>");
		expect(sheet).toContain("$1,240");
		const feedback = sheet.indexOf('href="/feedback"');
		expect(feedback).toBeGreaterThan(-1);
		expect(feedback).toBeLessThan(sheet.indexOf("<h1"));
		expect(sheet).not.toContain("How this works");
	});

	it("gives each option its note, with where its list sits below lg, and no line about phones showing nothing", async () => {
		const chunk = section(await drawn());
		expect(chunk).not.toContain("Phones show nothing");
		expect(chunk).not.toContain("Phones don&#39;t show it");
		expect(option(chunk, "A · A sidebar")).toContain(
			"On desktop, the sidebar&#39;s second group gains a third line, Keyboard shortcuts, with a keyboard icon. Opening it drops the ledger down inside the sidebar; ? opens it and moves focus to its summary. Below lg the sidebar is hidden, so ? opens More&#39;s Keyboard shortcuts row instead (from another page, it goes to More with the row open).",
		);
		expect(option(chunk, "B · At the foot")).toContain(
			"On desktop, Keyboard shortcuts sits under How this works at the foot of each page that has it, and opens downward. ? opens it and scrolls it into view. Below lg, How this works stays at the foot but Keyboard shortcuts isn&#39;t drawn there, so ? opens More&#39;s Keyboard shortcuts row instead (from another page, it goes to More with the row open).",
		);
		expect(option(chunk, "C · A sheet")).toContain(
			"? opens the list as a ledger sheet, the BottomSheet that #87 made modal, at any width. Without the script, the same list is B&#39;s details under How this works at the foot of each desktop page that has it, and More&#39;s Keyboard shortcuts row below lg.",
		);
	});

	it("gives B and C their costs: the details under How this works, and C's sheet route, Cancel, its fallbacks and decision 118", async () => {
		const chunk = section(await drawn());
		expect(option(chunk, "B · At the foot")).toContain(
			"a details under How this works on each desktop page that has it",
		);
		expect(option(chunk, "C · A sheet")).toContain(
			"a ?keys param the server draws the sheet from over the page it was opened from, so Cancel, Escape and the backdrop close it as every sheet closes; keyboard.js opens it and sheet.js already makes it modal; without the script, the foot&#39;s details and More&#39;s row; a monospaced font token for the key chips; and a decision entry (decision 118), since decision 109&#39;s list was a disclosure only.",
		);
	});

	it("adds no client JavaScript to the section", async () => {
		const chunk = section(await drawn());
		expect(chunk).not.toContain("<script");
	});

	it("gives every picture frame position, so an absolutely placed child can't escape its clip and widen the page at 390", async () => {
		const html = await drawn();
		// Opening tags, matched attribute by attribute, so a `>` inside a class can't cut a tag short.
		const tags = [
			...html.matchAll(
				/<([a-z][a-z0-9]*)((?:\s+[a-zA-Z:_-]+(?:="[^"]*")?)*)\s*\/?>/g,
			),
		].filter((m) => /\srole="img"/.test(m[2] ?? ""));
		const clipped = tags.filter((m) =>
			/\sclass="[^"]*\boverflow-hidden\b/.test(m[2] ?? ""),
		);
		expect(clipped.length).toBeGreaterThan(0);
		expect(
			clipped
				.filter((m) => !/\sclass="[^"]*\brelative\b/.test(m[2] ?? ""))
				.map((m) => m[0]),
		).toEqual([]);
	});
});

// P129 (#80): the money input, state by state, drawn for the owner's pick. Proposal only: nothing in src/views changes.
describe("GET /design-system/proposals, P129 (the money input, state by state, #80)", () => {
	const drawn = async () => (await get("/design-system/proposals")).html;
	// P129's section: from its heading to P127's (Home's budget list behind each sheet holds a section of its own).
	const section = (html: string) => {
		const start = html.indexOf('<section aria-labelledby="p129-title"');
		const end = html.indexOf('<section aria-labelledby="p127-title"');
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		return html.slice(start, end);
	};
	// The five states, in order, as each row's label is drawn.
	const STATES = [
		"Empty",
		"With cents: Round to $613 appears",
		"Equal to last month: Round to $572 appears too",
		"At $0: the minus buttons are off",
		"Error: “six hundred” isn’t an amount",
	];
	// The state's words as the picture labels spell them.
	const TAGS = ["empty", "with cents", "equal to last month", "at $0", "error"];
	// One state's row: from its label to the next state's label; the last runs to the fixed behaviours.
	const row = (chunk: string, i: number) => {
		const from = chunk.indexOf(`>${STATES[i]}</p>`);
		const to =
			i < STATES.length - 1
				? chunk.indexOf(`>${STATES[i + 1]}</p>`)
				: chunk.indexOf("Fixed with either option");
		expect(from, STATES[i]).toBeGreaterThan(-1);
		expect(to, STATES[i]).toBeGreaterThan(from);
		return chunk.slice(from, to);
	};
	// Every picture's label and kind, in drawing order. A phone and a desktop picture can share a label, so the kind is part of the key.
	const PICTURE_LABEL = /aria-label="([^"]*), on (a phone|desktop)"/g;
	// The phone pictures in a chunk, by label, in drawing order.
	const labels = (chunk: string) =>
		[...chunk.matchAll(PICTURE_LABEL)]
			.filter((m) => m[2] === "a phone")
			.map((m) => m[1]);
	// One picture's markup, by label and kind: from its label to the next picture of either kind, or to the chunk's end.
	const picture = (chunk: string, label: string, kind = "a phone") => {
		const found = [...chunk.matchAll(PICTURE_LABEL)];
		const at = found.findIndex((m) => m[1] === label && m[2] === kind);
		expect(at, `${label}, on ${kind}`).toBeGreaterThan(-1);
		return chunk.slice(found[at]?.index ?? 0, found[at + 1]?.index);
	};
	// The buttons with a data-nudge attribute (− and + and the cent arrows), each with whether the disabled
	// attribute is on it (Hono writes it as disabled="", and the disabled: class variant has a colon after it).
	const nudges = (chunk: string) =>
		[...chunk.matchAll(/<button [^>]*data-nudge="(-?\d+)"[^>]*>/g)].map(
			(m) => ({
				nudge: m[1],
				disabled: /\sdisabled(=""|\s|>)/.test(m[0] ?? ""),
			}),
		);
	// The whole button that holds `words`.
	const chipOf = (markup: string, words: string) => {
		const at = markup.indexOf(words);
		expect(at, words).toBeGreaterThan(-1);
		const open = markup.lastIndexOf("<button", at);
		return markup.slice(open, markup.indexOf("</button>", at));
	};
	// The class of the div that opens just before `words` (a chip row, say).
	const rowClassBefore = (markup: string, words: string) => {
		const at = markup.indexOf(words);
		expect(at, words).toBeGreaterThan(-1);
		const open = markup.lastIndexOf('<div class="', at) + '<div class="'.length;
		return markup.slice(open, markup.indexOf('"', open));
	};
	// The class of the error line under the box.
	const errorClass = (markup: string) =>
		markup.match(/<p [^>]*class="([^"]*)"[^>]*>Enter a dollar amount/)?.[1] ??
		"";
	// The class tokens of a chip's check: the span that holds the check icon, so its slot's classes show whether it's laid out and when it shows.
	const checkTokens = (chip: string) =>
		(chip.match(/<span class="([^"]*)"><svg/)?.[1] ?? "").split(" ");
	const CHECK = "M20 6 9 17l-5-5";

	it("sits after P128 and before P127 (decision 116), titled and dated as the brief asks", async () => {
		const html = await drawn();
		const start = html.indexOf(
			'<section aria-labelledby="p129-title" class="mt-12">',
		);
		expect(start).toBeGreaterThan(-1);
		expect(start).toBeGreaterThan(html.indexOf('<section id="p128-keys"'));
		expect(start).toBeLessThan(
			html.indexOf('<section aria-labelledby="p127-title"'),
		);
		expect(html).toContain(
			'<h2 id="p129-title" class="font-serif text-3xl font-semibold">Picked: the money input</h2>',
		);
		expect(html).toContain(
			"Drawn Oct 15. The owner&#39;s pick, marked Picked, is decision 117: A, today&#39;s money input with what it lost put back.",
		);
		expect(html).not.toContain("Open: the money input, state by state");
		expect(html).not.toContain("Drawn Oct 15 for #80");
		expect(html).toContain(
			'<section id="p129-money" aria-labelledby="p129-money-title"',
		);
		expect(html).toContain(
			'<h3 id="p129-money-title" class="text-xl font-semibold">P129 · The money input, state by state</h3>',
		);
	});

	it("names the three drawings in order: A recommended and picked, and A and B each with a trade-off and a reason", async () => {
		const chunk = section(await drawn());
		expect(optionPicks(chunk)).toEqual([
			{ name: "Reference · Today on main", picked: false },
			{ name: "Option A · Today’s, with what it lost put back", picked: true },
			{ name: "Option B · One left edge", picked: false },
		]);
		expect(chunk.match(/>Recommended</g)?.length).toBe(1);
		const a = optionOf(chunk, "Option A · Today’s, with what it lost put back");
		expect(a).toContain(">Recommended<");
		expect(a).toContain(">Picked<");
		// The one Picked pill is A's: it is the only one in the section.
		expect(chunk.match(/>Picked</g)?.length).toBe(1);
		expect(a).toContain(
			"Trade-off: src/views/money-input.tsx (the placeholder and the chip’s check slot) and money.js (decision 39); no new token or script.",
		);
		expect(a).toContain(
			"Why: it keeps the owner’s own hero layout, centred, and fixes the losses: the placeholder, a faded chip that reads at about 2.3:1, and buttons that do nothing.",
		);
		const b = optionOf(chunk, "Option B · One left edge");
		expect(b).not.toContain(">Recommended<");
		expect(b).toContain("Trade-off: same as A.");
		expect(b).toContain(
			"Why: one left edge for the whole sheet, and nothing moves under a finger.",
		);
		expect(b).not.toContain(">Picked<");
	});

	it("draws five states, one row each, with Today, A and B side by side in every row", async () => {
		const chunk = section(await drawn());
		STATES.forEach((_, i) => {
			expect(labels(row(chunk, i))).toEqual([
				`Today on main, ${TAGS[i]}`,
				`Option A, ${TAGS[i]}`,
				`Option B, ${TAGS[i]}`,
			]);
		});
		expect(labels(chunk)).toHaveLength(15);
		expect(chunk).not.toContain(", on a phone, on a phone");
		// At 1280, the cents and the equal-to-last-month rows each add Today and A as desktop pictures; the other rows have none.
		const desk = [...chunk.matchAll(/aria-label="([^"]*), on desktop"/g)].map(
			(m) => m[1],
		);
		expect(desk).toEqual([
			"Today on main, with cents",
			"Option A, with cents",
			"Today on main, equal to last month",
			"Option A, equal to last month",
		]);
		for (const i of [0, 3, 4]) {
			expect(row(chunk, i), STATES[i]).not.toContain(", on desktop");
		}
	});

	it("draws every phone picture on the 390 by 844 phone, with a backdrop over the whole phone, banner and wordmark included, and the sheet reaching the foot", async () => {
		const chunk = section(await drawn());
		const phones = STATES.flatMap((_, i) => [
			`Today on main, ${TAGS[i]}`,
			`Option A, ${TAGS[i]}`,
			`Option B, ${TAGS[i]}`,
		]);
		expect(phones).toHaveLength(15);
		for (const label of phones) {
			const phone = picture(chunk, label);
			// The frame is the whole 390 by 844 phone, with its 1px border around it.
			const frame = phone.match(/ class="([^"]*)"/)?.[1] ?? "";
			expect(frame, label).toContain("h-[846px] w-[392px]");
			// One backdrop, drawn after the banner and the wordmark, so it dims both.
			expect(phone.split("absolute inset-0 bg-ink/30").length - 1, label).toBe(
				1,
			);
			const banner = phone.indexOf("Demo data. Nothing here is real.");
			const wordmark = phone.indexOf('aria-label="Tally home"');
			expect(banner, label).toBeGreaterThan(-1);
			expect(wordmark, label).toBeGreaterThan(-1);
			expect(
				phone.indexOf("absolute inset-0 bg-ink/30"),
				label,
			).toBeGreaterThan(Math.max(banner, wordmark));
			// One sheet, pinned to the foot and starting 144px down: the wordmark row's 120px, then 24px.
			const panels = [
				...phone.matchAll(/class="([^"]*rounded-t-sheet[^"]*)"/g),
			].map((m) => m[1] ?? "");
			expect(panels, label).toHaveLength(1);
			expect(panels[0], label).toContain("absolute inset-x-0 bottom-0 top-36 ");
			// No wrapper that clips the backdrop to the lower part of the phone.
			expect(phone, label).not.toContain("relative -mx-5");
			expect(phone, label).not.toContain("h-[724px]");
		}
	});

	it("draws Today and Option A at 1280 as a panel on Home's budget list, with the same bodies as the phone sheets", async () => {
		const chunk = section(await drawn());
		const cents = picture(
			row(chunk, 1),
			"Today on main, with cents",
			"desktop",
		);
		const centsA = picture(row(chunk, 1), "Option A, with cents", "desktop");
		const last = picture(
			row(chunk, 2),
			"Today on main, equal to last month",
			"desktop",
		);
		const lastA = picture(
			row(chunk, 2),
			"Option A, equal to last month",
			"desktop",
		);
		for (const desk of [cents, centsA, last, lastA]) {
			// The panel is BottomSheet's right-hand one (its lg: classes), and the page behind it is dimmed.
			expect(desk).toContain("w-[28rem]");
			expect(desk).toContain("rounded-l-sheet");
			expect(desk).toContain("bg-ink/30");
			expect(desk).toContain("h-[560px] w-[722px]");
			expect(desk).toContain("inert");
			expect(desk).toContain('data-screen="picture"');
		}
		// Today's desktop pictures are the real money input; A's hold the check and the Round to chip where they belong.
		expect(cents).toContain("data-money");
		expect(last).toContain("data-money");
		expect(chipOf(last, "Last month:")).toContain("aria-pressed:text-ink");
		expect(chipOf(last, "Last month:")).not.toContain(
			"aria-pressed:opacity-50",
		);
		expect(chipOf(last, "Last month:")).toContain('aria-pressed="true"');
		expect(centsA).toContain("Round to $613");
		expect(checkTokens(chipOf(lastA, "Last month:"))).toContain(
			"group-aria-pressed:visible",
		);
		expect(chipOf(lastA, "Last month:")).toContain('aria-pressed="true"');
		// Each desktop picture has its own ids, so none repeats on the page.
		const html = await drawn();
		for (const id of [
			"p129-today-cents-desk",
			"p129-a-cents-desk",
			"p129-today-last-desk",
			"p129-a-last-desk",
		]) {
			expect(html.split(`id="${id}"`).length - 1, id).toBe(1);
		}
	});

	it("draws Today's pictures as the real money input, with its chips, Round to and error as they are", async () => {
		const chunk = section(await drawn());
		const today = (i: number) =>
			picture(row(chunk, i), `Today on main, ${TAGS[i]}`);
		// Empty: the muted 0.00 placeholder (decision 117), Round to kept but hidden, and both chips offered.
		expect(today(0)).toContain("data-money");
		expect(today(0)).toContain('placeholder="0.00"');
		expect(chipOf(today(0), "Round to")).toMatch(/\shidden(=""|\s|>)/);
		expect(today(0)).toContain("Last month: $571.80");
		expect(today(0)).toContain("3-month average: $602.45");
		// With cents: Round to $613 appears, and the box reads 612.45.
		expect(today(1)).toContain('value="612.45"');
		expect(today(1)).toContain("Round to $613");
		// Equal to last month: the chip is pressed and its words go ink, and Round to $572 appears too.
		expect(chipOf(today(2), "Last month:")).toContain('aria-pressed="true"');
		expect(chipOf(today(2), "Last month:")).toContain("aria-pressed:text-ink");
		expect(chipOf(today(2), "Last month:")).not.toContain(
			"aria-pressed:opacity-50",
		);
		expect(today(2)).toContain("Round to $572");
		// At $0: − is off, and the box reads 0.00.
		expect(today(3)).toContain('value="0.00"');
		expect(nudges(today(3)).find((n) => n.nudge === "-100")?.disabled).toBe(
			true,
		);
		// Error: the words the parser gives sit under the box, and all four steps are off (decision 117).
		expect(today(4)).toContain('role="alert"');
		expect(today(4)).toContain("Enter a dollar amount, like 250 or 250.50.");
		for (const nudge of ["100", "1", "-1", "-100"]) {
			expect(nudges(today(4)).find((n) => n.nudge === nudge)?.disabled).toBe(
				true,
			);
		}
	});

	it("options A and B: the empty box shows a muted 0.00 placeholder, as today's does", async () => {
		const chunk = section(await drawn());
		const a = picture(row(chunk, 0), "Option A, empty");
		expect(a).toContain('placeholder="0.00"');
		expect(a).toContain("placeholder:text-muted");
		expect(a).toContain("placeholder:font-normal");
		expect(picture(row(chunk, 0), "Option B, empty")).toContain(
			'placeholder="0.00"',
		);
	});

	it("option A: a chip that matches the box gets a check in ink, instead of fading", async () => {
		const chunk = section(await drawn());
		const a = picture(row(chunk, 2), "Option A, equal to last month");
		const lastMonth = chipOf(a, "Last month:");
		expect(lastMonth).toContain('aria-pressed="true"');
		expect(lastMonth).toContain("aria-pressed:text-ink");
		expect(lastMonth).toContain(CHECK);
		expect(lastMonth).not.toContain("aria-pressed:opacity-50");
		// The check is laid out and hidden until the chip is pressed: its slot is kept, so the chip never changes width.
		expect(checkTokens(lastMonth)).toEqual(
			expect.arrayContaining([
				"inline-flex",
				"invisible",
				"group-aria-pressed:visible",
			]),
		);
		expect(checkTokens(lastMonth)).not.toContain("hidden");
		// The chip that doesn't match is not pressed.
		expect(chipOf(a, "3-month average:")).toContain('aria-pressed="false"');
	});

	it("option A: both chips hold their check's slot, so a chip keeps its width when it's pressed", async () => {
		const chunk = section(await drawn());
		const withCents = picture(row(chunk, 1), "Option A, with cents");
		for (const words of ["Last month:", "3-month average:"]) {
			const tokens = checkTokens(chipOf(withCents, words));
			expect(tokens, words).toContain("invisible");
			expect(tokens, words).toContain("group-aria-pressed:visible");
			expect(tokens, words).not.toContain("hidden");
		}
	});

	it("option A: with unreadable text, all four step buttons are off", async () => {
		const chunk = section(await drawn());
		const steps = nudges(picture(row(chunk, 4), "Option A, error"));
		expect(steps.map((s) => s.nudge).sort()).toEqual([
			"-1",
			"-100",
			"1",
			"100",
		]);
		expect(steps.every((s) => s.disabled)).toBe(true);
	});

	it("option A: the chips and the error stay centred under the symmetric row", async () => {
		const chunk = section(await drawn());
		expect(
			rowClassBefore(
				picture(row(chunk, 1), "Option A, with cents"),
				"Last month:",
			),
		).toBe("flex flex-wrap justify-center gap-2");
		expect(errorClass(picture(row(chunk, 4), "Option A, error"))).toContain(
			"text-center",
		);
	});

	it("option B: the chips and the error line up at the left, with Round to last", async () => {
		const chunk = section(await drawn());
		const b = picture(row(chunk, 1), "Option B, with cents");
		expect(rowClassBefore(b, "Last month:")).toBe("flex flex-wrap gap-2");
		const lastMonth = b.indexOf("Last month:");
		const average = b.indexOf("3-month average:");
		const roundTo = b.indexOf("Round to $613");
		expect(lastMonth).toBeGreaterThan(-1);
		expect(average).toBeGreaterThan(lastMonth);
		expect(roundTo).toBeGreaterThan(average);
		const error = picture(row(chunk, 4), "Option B, error");
		expect(errorClass(error)).not.toContain("text-center");
		expect(errorClass(error)).toContain("text-over");
		// B keeps A's other changes: the placeholder, the check and the four steps off.
		expect(b).toContain('placeholder="0.00"');
		expect(nudges(error).every((s) => s.disabled)).toBe(true);
		const bLast = chipOf(
			picture(row(chunk, 2), "Option B, equal to last month"),
			"Last month:",
		);
		expect(checkTokens(bLast)).toContain("group-aria-pressed:visible");
		expect(checkTokens(bLast)).toContain("invisible");
		expect(checkTokens(bLast)).not.toContain("hidden");
	});

	it("says what the spec already fixes, and lists the keyboard and screen-reader fixes either option brings", async () => {
		const chunk = section(await drawn());
		expect(chunk).toContain("Already fixed by the spec: </span>");
		expect(chunk).toContain(
			"the round ±$1 buttons either side of the box (decision 46), its 12px control corners (decision 85, Q61 A) and the 3-month average chip (decision 85, Q62 B).",
		);
		expect(chunk).toContain(
			"Fixed with either option (keyboard and screen-reader paths)",
		);
		for (const item of [
			"When − or ▼ reaches $0 while it has focus, focus moves to its pair instead of being dropped.",
			"↑ and ↓ in the field are announced.",
			"Round to stays, ticked, after use instead of vanishing while focused.",
			"Announced amounts use commas: “$1,234.50”.",
			"A typed third decimal is refused, not cut.",
		]) {
			expect(chunk, item).toContain(item);
		}
	});
});

describe("GET /design-system/proposals, the second design audit (#603, #604, #605)", () => {
	const drawn = async () => (await get("/design-system/proposals")).html;
	// The Picked section (P130 to P133), from its heading to the P134 and P135 section.
	const pickedSection = (html: string) => {
		const start = html.indexOf('<section aria-labelledby="audit2-picks-title"');
		const end = html.indexOf('<section aria-labelledby="audit3-title"');
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		return html.slice(start, end);
	};
	// One proposal's block, in the section it is drawn in, from its specimen to the next one in that section.
	const specimen = (html: string, id: string) => {
		const body = pickedSection(html);
		const start = body.indexOf(`<section id="${id}"`);
		expect(start, id).toBeGreaterThan(-1);
		// A proposal's pictures may hold real components that draw a section (PlanBand, TrendGroup), so the next proposal is the cut.
		const next = body.indexOf('<section id="', start + 1);
		return body.slice(start, next < 0 ? undefined : next);
	};
	// One picture's markup, from its label up to the next picture's label.
	const picture = (chunk: string, label: string) => {
		const start = chunk.indexOf(`role="img" aria-label="${label}"`);
		expect(start, label).toBeGreaterThan(-1);
		const next = chunk
			.slice(start + 1)
			.search(/role="img" aria-label="[^"]*, on (?:a phone|desktop)"/);
		return chunk.slice(start, next < 0 ? undefined : start + 1 + next);
	};
	// Every picture's label in a chunk, in drawing order.
	const labelsOf = (chunk: string) =>
		[
			...chunk.matchAll(
				/role="img" aria-label="([^"]*, on (?:a phone|desktop))"/g,
			),
		].map((m) => m[1] ?? "");
	const count = (text: string, needle: string) => text.split(needle).length - 1;
	const PHONE = ", on a phone";
	const DESK = ", on desktop";

	it("draws the Picked section after P136 and before P134 and P135's, with P130 to P133 in it and no Open section", async () => {
		const html = await drawn();
		expect(html).not.toContain('aria-labelledby="audit2-title"');
		expect(html).not.toContain("Open: the month dots");
		const picked = html.indexOf(
			'<section aria-labelledby="audit2-picks-title"',
		);
		const audit = html.indexOf('<section aria-labelledby="audit3-title"');
		expect(picked).toBeGreaterThan(
			html.indexOf('<section aria-labelledby="p136-title"'),
		);
		expect(picked).toBeLessThan(audit);
		expect(audit).toBeLessThan(
			html.indexOf('<section aria-labelledby="p128-title"'),
		);
		expect(html).toContain(
			'<h2 id="audit2-picks-title" class="font-serif text-3xl font-semibold">Picked: from the second design audit</h2>',
		);
		expect(html).toContain(
			'<p class="mt-2 max-w-prose text-muted">Drawn Oct 15. The owner&#39;s picks, marked Picked, are decision 121: P130 A, one Why per page; P131 A, a quiet ledger of months; P132 A, one line names the cause; P133 A, marks in outline.</p>',
		);
		for (const id of [
			"p130-why",
			"p131-bill-page",
			"p132-month-result",
			"p133-month-dots",
		])
			expect(pickedSection(html)).toContain(`<section id="${id}"`);
		expect(pickedSection(html)).not.toContain("<script");
	});

	it("titles P130 to P133 in the Picked section, each with its title", async () => {
		const html = await drawn();
		expect(specimen(html, "p130-why")).toContain("P130 · One Why per page");
		expect(specimen(html, "p131-bill-page")).toContain(
			"P131 · A bill&#39;s page",
		);
		expect(specimen(html, "p132-month-result")).toContain(
			"P132 · What a past month&#39;s result says",
		);
		expect(specimen(html, "p133-month-dots")).toContain(
			"P133 · The month dots",
		);
	});

	it("names each proposal's options in order, with one Recommended pill per proposal", async () => {
		const html = await drawn();
		const names = (id: string) =>
			[...specimen(html, id).matchAll(/<h4 [^>]*>([\s\S]*?)<\/h4>/g)].map(
				(m) => (m[1] ?? "").split("<")[0],
			);
		expect(names("p130-why")).toEqual([
			"Today (current)",
			"Option A · One Why, beside the summary",
			"Option B · Quiet Why on the headings",
		]);
		expect(names("p131-bill-page")).toEqual([
			"Today (current)",
			"Option A · A quiet ledger of months",
			"Option B · A year at a glance",
		]);
		expect(names("p132-month-result")).toEqual([
			"Today (current)",
			"Option A · One line names the cause",
			"Option B · Split the result",
		]);
		expect(names("p133-month-dots")).toEqual([
			"Today (current)",
			"Option A · Marks in outline, as first drawn",
			"Option C · Tally strokes",
			"Option D · Filled tokens",
			"Option E · Mini bars",
		]);
		for (const id of [
			"p130-why",
			"p131-bill-page",
			"p132-month-result",
			"p133-month-dots",
		])
			expect(specimen(html, id).split(">Recommended<").length - 1, id).toBe(1);
	});

	it("draws P130's pictures: Today's Bills at 390 and 1280 and Trends at 390, A's three, B's three", async () => {
		const chunk = specimen(await drawn(), "p130-why");
		expect(labelsOf(chunk)).toEqual([
			`Today, Bills&#39; top${PHONE}`,
			`Today, Bills&#39; top${DESK}`,
			`Today, Trends&#39; top${PHONE}`,
			`Option A, Bills&#39; top${PHONE}`,
			`Option A, Bills&#39; top${DESK}`,
			`Option A, Trends&#39; top${PHONE}`,
			`Option B, Bills&#39; top${PHONE}`,
			`Option B, Bills&#39; top${DESK}`,
			`Option B, Trends&#39; top${PHONE}`,
		]);
	});

	it("draws P130 A with one Why? on Bills' summary line and none on Trends' groups", async () => {
		const chunk = specimen(await drawn(), "p130-why");
		const bills = picture(chunk, `Option A, Bills&#39; top${PHONE}`);
		expect(bills.split('href="/how-it-works#bills"').length - 1).toBe(1);
		expect(bills).toContain("5 bills to pay soon, $1,062.49 in all");
		const trends = picture(chunk, `Option A, Trends&#39; top${PHONE}`);
		// Trends' headline keeps its Why?; Going well and Worth a look lose theirs.
		expect(trends.split('href="/how-it-works#trends"').length - 1).toBe(1);
		expect(trends).toContain("Going well");
		expect(trends).toContain("Worth a look");
	});

	it("draws P130 today's Bills picture with a Why? on each heading it shows, and none on the summary", async () => {
		const chunk = specimen(await drawn(), "p130-why");
		const today = picture(chunk, `Today, Bills&#39; top${PHONE}`);
		expect(today.split('href="/how-it-works#bills"').length - 1).toBe(2);
		expect(today).toContain("Overdue");
		expect(today).toContain("Due in the next 7 days");
	});

	it("draws P130 B's Why? muted, not terracotta, on each Bills heading", async () => {
		const chunk = specimen(await drawn(), "p130-why");
		const bills = picture(chunk, `Option B, Bills&#39; top${PHONE}`);
		const links = bills.match(/<a href="\/how-it-works#bills"[^>]*>/g) ?? [];
		expect(links.length).toBe(2);
		for (const link of links) {
			expect(link).toContain("text-muted");
			expect(link).not.toContain("text-accent");
		}
	});

	it("draws P130 B's Trends with its three Why? links muted, the headline's sentence among them", async () => {
		const chunk = specimen(await drawn(), "p130-why");
		const trends = picture(chunk, `Option B, Trends&#39; top${PHONE}`);
		expect(trends).toContain("$339 less than by this time in September.");
		expect(trends).toContain("Going well");
		expect(trends).toContain("Worth a look");
		const links = trends.match(/<a href="\/how-it-works#trends"[^>]*>/g) ?? [];
		expect(links.length).toBe(3);
		for (const link of links) {
			expect(link).toContain("text-muted");
			expect(link).not.toContain("text-accent");
		}
		expect(trends).toContain('aria-label="Why? this month against last"');
		expect(trends).toContain('aria-label="Why? going well"');
		expect(trends).toContain('aria-label="Why? worth a look"');
	});

	it("writes P130's three Trends pictures from the demo's October: $1,665 spent, both October so far amounts, and no $2,535", async () => {
		const chunk = specimen(await drawn(), "p130-why");
		for (const label of [
			`Today, Trends&#39; top${PHONE}`,
			`Option A, Trends&#39; top${PHONE}`,
			`Option B, Trends&#39; top${PHONE}`,
		]) {
			const trends = picture(chunk, label);
			expect(trends, label).toContain("$1,665");
			expect(trends, label).toContain(
				"$339 less than by this time in September.",
			);
			expect(trends, label).toContain("October so far $84.");
			expect(trends, label).toContain("October so far $264.");
			expect(trends, label).not.toContain("$2,535");
		}
	});

	it("writes P130's group headings in cents, $757.49 and $305.00, on every Bills picture", async () => {
		const chunk = specimen(await drawn(), "p130-why");
		for (const label of [
			`Today, Bills&#39; top${PHONE}`,
			`Option A, Bills&#39; top${PHONE}`,
			`Option B, Bills&#39; top${PHONE}`,
		]) {
			const bills = picture(chunk, label);
			expect(bills, label).toContain("$757.49");
			expect(bills, label).toContain("$305.00");
			expect(bills, label).not.toContain(">$757<");
			expect(bills, label).not.toContain(">$305<");
		}
	});

	it("draws P131 A's September charge as its own row, April to August folded, with no filled status pill", async () => {
		const chunk = specimen(await drawn(), "p131-bill-page");
		expect(chunk).toContain(
			"Tally found asks to be linked; months nothing was paid say so once, instead of &#39;Not paid&#39; six times.",
		);
		const closed = picture(chunk, `Option A, a bill&#39;s page${PHONE}`);
		// September has a charge Tally found: one row, with Link it as its action (the one terracotta step).
		expect(closed).toContain("September");
		expect(closed).toContain("A $2.99 charge on Sep 23 looks like this");
		expect(closed.split("Link it").length - 1).toBe(1);
		expect(closed).toContain('text-accent">Link it</span>');
		// April to August had no charge: one folded row, reading No payment.
		expect(closed).toContain("April to August");
		expect(closed).toContain("No payment");
		expect(closed).not.toContain("April to September");
		expect(closed).not.toContain("Link them");
		expect(closed).not.toContain("6 months");
		// The demo banner is bg-band too, so a status pill is its class with the rounded box around it.
		expect(closed).not.toContain("rounded-control bg-band px-2");
		expect(closed).not.toContain("<details open");
		// The fold's arrow turns when the fold is open (the Disclosure rule, with reduced motion left still).
		expect(closed).toContain('<details class="group">');
		expect(closed).toMatch(
			/<summary[\s\S]*group-open:rotate-90[\s\S]*<\/summary>/,
		);
		const opened = picture(
			chunk,
			`Option A, a bill&#39;s page, with April to August opened${PHONE}`,
		);
		expect(opened).toContain('<details class="group" open');
		// The five months under the fold each say Link a payment in muted words, not terracotta ones.
		expect(
			opened.split('text-sm text-muted">Link a payment</span>').length - 1,
		).toBe(5);
		expect(opened).not.toContain('text-accent">Link a payment');
		expect(opened).not.toContain("rounded-control bg-band px-2");
	});

	it("draws P131 A's October as a paid row that opens its payment, with the check and the row arrow, in all three Option A pictures", async () => {
		const chunk = specimen(await drawn(), "p131-bill-page");
		for (const label of [
			`Option A, a bill&#39;s page${PHONE}`,
			`Option A, a bill&#39;s page, with April to August opened${PHONE}`,
			`Option A, a bill&#39;s page${DESK}`,
		]) {
			// A paid month is a disclosure (#604): its summary is the row, and its payment and Not this one open under it.
			const row =
				picture(chunk, label).match(
					/<li><details class="group"[\s\S]*?<\/summary>/,
				)?.[0] ?? "";
			expect(row, label).toContain("October");
			expect(row, label).toContain("Paid Oct 15 · $2.99");
			expect(row, label).toContain('class="text-ok"');
			expect(row, label).toContain('data-icon="check"');
			expect(row, label).toContain('data-icon="chevron-right"');
		}
	});

	it("draws P131 today's bill page with its filled status pills and Link a payment", async () => {
		const chunk = specimen(await drawn(), "p131-bill-page");
		const today = picture(chunk, `Today, a bill&#39;s page${PHONE}`);
		expect(today).toContain("rounded-control bg-band px-2");
		expect(today).toContain("No payment linked yet");
		expect(today).toContain("Link a payment");
	});

	it("draws P131 B's year strip from April to March, each month a link to its row below", async () => {
		const chunk = specimen(await drawn(), "p131-bill-page");
		const bills = picture(chunk, `Option B, a bill&#39;s page${PHONE}`);
		// Eight cells link to their row: the six unpaid months and the two due ones. October and January to March have none.
		expect(bills.split('href="#p131-b-phone-').length - 1).toBe(8);
		expect(bills).toContain('data-mark="paid"');
		expect(bills).toContain('data-mark="due"');
		expect(bills).toContain('data-mark="none"');
	});

	it("says each year cell's status in words: paid, due, or no payment linked", async () => {
		const chunk = specimen(await drawn(), "p131-bill-page");
		const bills = picture(chunk, `Option B, a bill&#39;s page${PHONE}`);
		for (const words of [
			"September, no payment linked",
			"October, paid",
			"November, due",
			"January, due",
		])
			expect(bills).toContain(words);
	});

	it("words P132 A's cause for both sample months, and links the first to Not budgeted", async () => {
		const chunk = specimen(await drawn(), "p132-month-result");
		expect(chunk).toContain(
			"Most of it had no budget: Childcare $960 and Rent $1,200.",
		);
		expect(chunk).toContain(
			"Most of it was over budget: Eating Out $180 and Kids $40.",
		);
		const sep = picture(chunk, `Option A, September${PHONE}`);
		expect(sep).toContain('href="#p132-a-sep-not-budgeted"');
	});

	it("puts P132 A's cause sentence under the number and stamp, above the bars, in September and in the decided list", async () => {
		const chunk = specimen(await drawn(), "p132-month-result");
		const sep = picture(chunk, `Option A, September${PHONE}`);
		const sentence = sep.indexOf(
			"Most of it had no budget: Childcare $960 and Rent $1,200.",
		);
		const bars = sep.indexOf('aria-label="Spent against each budget:');
		expect(sentence).toBeGreaterThan(-1);
		expect(bars).toBeGreaterThan(sentence);
		const entry = DECIDED.find((d) => d.title.startsWith("P132 ·"));
		expect(entry?.outcome).toContain(
			"under the number and stamp, above the bars",
		);
		const row = decisions
			.split("\n")
			.find((line) => line.startsWith("| 121 | 2026-10-15 |"));
		expect(row).toContain("under the number and stamp, above the bars");
	});

	it("keeps P132 A's link to Not budgeted muted, not ink", async () => {
		const chunk = specimen(await drawn(), "p132-month-result");
		const link =
			picture(chunk, `Option A, September${PHONE}`).match(
				/<a href="#p132-a-sep-not-budgeted"[^>]*>/,
			)?.[0] ?? "";
		expect(link).toContain("text-muted");
		expect(link).not.toContain("text-ink");
	});

	it("works each month's result from every budget row: September $2,134 over, the sample month $168 over", async () => {
		const chunk = specimen(await drawn(), "p132-month-result");
		const sample = picture(
			chunk,
			`Option A, a month over budget, sample numbers${PHONE}`,
		);
		expect(sample).toContain(">$168<");
		expect(sample).not.toContain("$220");
		expect(picture(chunk, `Option A, September${PHONE}`)).toContain(">$2,134<");
		expect(picture(chunk, `Today, September${PHONE}`)).toContain("2,134");
	});

	it("writes the cause sentence from integer cents, with Most of it only when the causes are over half", async () => {
		const { monthCause: rule } = await import("../src/budgets/month-cause");
		const monthCause = (
			causes: Parameters<typeof rule>[0],
			overCents: number,
		) => rule(causes, overCents)?.text ?? "";
		expect(
			monthCause(
				[
					{ name: "Childcare", cents: 96000, kind: "unbudgeted" },
					{ name: "Rent", cents: 120000, kind: "unbudgeted" },
				],
				213400,
			),
		).toBe("Most of it had no budget: Childcare $960 and Rent $1,200.");
		expect(
			monthCause(
				[
					{ name: "Eating Out", cents: 18000, kind: "over" },
					{ name: "Kids", cents: 4000, kind: "over" },
				],
				22000,
			),
		).toBe("Most of it was over budget: Eating Out $180 and Kids $40.");
		expect(
			monthCause(
				[
					{ name: "Childcare", cents: 10000, kind: "unbudgeted" },
					{ name: "Rent", cents: 5000, kind: "unbudgeted" },
				],
				100000,
			),
		).toBe("Part of it had no budget: Childcare $100 and Rent $50.");
		expect(
			monthCause(
				[
					{ name: "Rent", cents: 120000, kind: "unbudgeted" },
					{ name: "Eating Out", cents: 18000, kind: "over" },
				],
				138000,
			),
		).toBe("Most of it: Rent $1,200 with no budget and Eating Out $180 over.");
		expect(monthCause([], 0)).toBe("");
	});

	it("leaves out a category with a net refund from the causes, whether or not it has a budget", async () => {
		const { monthCause: rule } = await import("../src/budgets/month-cause");
		const monthCause = (
			causes: Parameters<typeof rule>[0],
			overCents: number,
		) => rule(causes, overCents)?.text ?? "";
		expect(
			monthCause(
				[
					{ name: "Rent", cents: 120000, kind: "unbudgeted" },
					{ name: "Gifts", cents: -5000, kind: "unbudgeted" },
				],
				115000,
			),
		).toBe("Most of it had no budget: Rent $1,200.");
		expect(
			monthCause([{ name: "Gifts", cents: -5000, kind: "unbudgeted" }], 1000),
		).toBe("");
	});

	it("draws P133 A, C, D and E with three labelled pictures each: October and September at 390 px, October at 1280 px", async () => {
		const chunk = specimen(await drawn(), "p133-month-dots");
		const labels = labelsOf(chunk).filter((label) =>
			label.startsWith("Option "),
		);
		expect(labels).toEqual(
			["A", "C", "D", "E"].flatMap((x) => [
				`Option ${x}, the month dots, October${PHONE}`,
				`Option ${x}, the month dots, September${PHONE}`,
				`Option ${x}, the month dots, October${DESK}`,
			]),
		);
	});

	it("marks each finished month of A, C, D and E in October: three under, two over, the empty April and the current month", async () => {
		const chunk = specimen(await drawn(), "p133-month-dots");
		for (const x of ["A", "C", "D", "E"]) {
			const october = picture(
				chunk,
				`Option ${x}, the month dots, October${PHONE}`,
			);
			expect(count(october, 'data-mark="under"'), x).toBe(3);
			expect(count(october, 'data-mark="over"'), x).toBe(2);
			expect(count(october, 'data-mark="empty"'), x).toBe(1);
			expect(count(october, 'data-mark="current"'), x).toBe(1);
			// The words carry each result, so no colour is needed to read it.
			expect(october, x).toContain("September, ended $2,134 over");
			expect(october, x).toContain("August, ended $134 over");
			expect(october, x).not.toContain("August, ended $144 under");
			expect(october, x).toContain("May, ended $310 under");
			expect(october, x).toContain("April, no budgets");
			expect(october, x).toContain("October, so far");
			// Every month is a 44px link to that month.
			const links = october.match(/<a href="\/\?month=[^"]*"[^>]*>/g) ?? [];
			expect(links.length, x).toBe(7);
			for (const link of links) expect(link, x).toContain("min-h-11 w-11");
		}
	});

	it("draws one ring per disc: October's accent when it is shown and current, September's ink when shown", async () => {
		const chunk = specimen(await drawn(), "p133-month-dots");
		// One month's own link, from its href to its closing tag, so the other six months' rings are not counted.
		const linkTo = (shot: string, month: string) => {
			const at = shot.indexOf(`<a href="/?month=${month}"`);
			expect(at, month).toBeGreaterThan(-1);
			return shot.slice(at, shot.indexOf("</a>", at));
		};
		const october = linkTo(
			picture(chunk, `Option A, the month dots, October${PHONE}`),
			"2026-10",
		);
		expect(october).toContain("ring-accent");
		expect(october).not.toContain("ring-ink");
		expect(october).not.toContain("border-ink");
		expect(count(october, "ring-2")).toBe(1);
		expect(count(october, "ring-offset-2 ring-offset-paper")).toBe(1);

		const september = picture(
			chunk,
			`Option A, the month dots, September${PHONE}`,
		);
		const shownSeptember = linkTo(september, "2026-09");
		expect(shownSeptember).toContain("ring-ink");
		expect(shownSeptember).not.toContain("ring-accent");
		expect(shownSeptember).not.toContain("border-ink");
		expect(count(shownSeptember, "ring-2")).toBe(1);
		expect(count(shownSeptember, "ring-offset-2 ring-offset-paper")).toBe(1);
		// October is current but not shown here, so it keeps its accent ring alone.
		const currentOctober = linkTo(september, "2026-10");
		expect(currentOctober).toContain("ring-accent");
		expect(currentOctober).not.toContain("ring-ink");
		expect(count(currentOctober, "ring-2")).toBe(1);
		expect(count(currentOctober, "ring-offset-2 ring-offset-paper")).toBe(1);
	});

	it("draws C's over month as a brick stroke through the ink one", async () => {
		const chunk = specimen(await drawn(), "p133-month-dots");
		const october = picture(chunk, `Option C, the month dots, October${PHONE}`);
		const at = october.indexOf('data-mark="over"');
		expect(at).toBeGreaterThan(-1);
		expect(october.slice(at, october.indexOf("</svg>", at))).toContain(
			"text-over",
		);
	});

	it("draws the next arrow dashed and faded on October's strips, and solid on September's", async () => {
		const chunk = specimen(await drawn(), "p133-month-dots");
		const dashed = "border-dashed border-rule text-muted/40";
		for (const label of labelsOf(chunk)) {
			const shot = picture(chunk, label);
			if (label.includes(", the month dots, October"))
				expect(shot, label).toContain(dashed);
			if (label.includes(", the month dots, September"))
				expect(shot, label).not.toContain(dashed);
		}
	});

	it("drops P133 B: the redraw has no plain-dots picture", async () => {
		expect(specimen(await drawn(), "p133-month-dots")).not.toContain(
			"Option B",
		);
	});

	it("draws P133's Today with its October desk shot beside the two phone shots", async () => {
		const chunk = specimen(await drawn(), "p133-month-dots");
		expect(
			labelsOf(chunk).filter((label) =>
				label.startsWith("Today, the month dots"),
			),
		).toEqual([
			"Today, the month dots, October, on a phone",
			"Today, the month dots, September, on a phone",
			"Today, the month dots, October, on desktop",
		]);
	});

	it("draws the Today pictures' month dots as hand-drawn grey discs, with no mark from the real strip", async () => {
		const html = await drawn();
		const dots = specimen(html, "p133-month-dots");
		const todayLabels = labelsOf(dots).filter((label) =>
			label.startsWith("Today, the month dots"),
		);
		expect(todayLabels).toHaveLength(3);
		const p132 = specimen(html, "p132-month-result");
		const todayShots = [
			...todayLabels.map((label) => picture(dots, label)),
			picture(p132, `Today, September${PHONE}`),
			picture(p132, `Today, September${DESK}`),
		];
		for (const shot of todayShots) {
			expect(shot).not.toContain("data-mark=");
			expect(shot).toContain("bg-muted/45");
		}
	});

	it("marks P133 A Picked and Recommended, C not recommended, and C, D and E not picked", async () => {
		const chunk = specimen(await drawn(), "p133-month-dots");
		const headings = [...chunk.matchAll(/<h4 [^>]*>([\s\S]*?)<\/h4>/g)].map(
			(m) => m[1] ?? "",
		);
		const option = (letter: string) =>
			headings.find((h) => h.includes(`Option ${letter} ·`)) ?? "";
		expect(option("A")).toContain(">Picked<");
		expect(option("A")).toContain(">Recommended<");
		for (const letter of ["C", "D", "E"])
			expect(option(letter), letter).not.toContain(">Picked<");
		expect(option("C")).not.toContain(">Recommended<");
		expect(chunk.split(">Recommended<").length - 1).toBe(1);
		expect(chunk.split(">Picked<").length - 1).toBe(1);
	});

	it("adds no client JavaScript: the sections have no script", async () => {
		const html = await drawn();
		expect(pickedSection(html)).not.toContain("<script");
	});

	it("states P133 A's marks and P132 A's cause line's place in spec §8.4 (decision 121)", () => {
		expect(spec).toContain(
			"Each finished month's dot holds a small mark: a check on ok for under budget, a minus on over for over, or an empty ring for a month with no budgets; the shown month keeps its ink ring around the mark, and the current month its ring; each month's link names its result in words (\"September, ended $2,134 over\") (P133 A, decision 121).",
		);
		expect(spec).toContain(
			"the word carrying the status. Under the number and stamp, above the bars, one muted line names the month's biggest causes",
		);
		expect(spec).not.toContain("Under the bars, one muted line");
		// The bars sit under the cause line, not under the whole sentence's "it".
		expect(spec).toContain(
			"Under the cause line is one small bar per budgeted category, scaled against its own budget: ",
		);
		expect(spec).not.toContain(
			"Under it is one small bar per budgeted category",
		);
	});

	it("lists P130 to P133 as the decided entries before P134, each with its issue and decision 121", () => {
		const last = DECIDED.slice(-7, -3);
		expect(last.map((d) => d.title.split(" · ")[0])).toEqual([
			"P130",
			"P131",
			"P132",
			"P133",
		]);
		expect(last.map((d) => d.issue)).toEqual([603, 604, 605, 605]);
		expect(last[3]?.title).toBe("P133 · The month dots");
		for (const entry of last)
			expect(entry.outcome, entry.title).toContain("(decision 121)");
		expect(last[3]?.outcome).toContain("C, D and E stay drawn, not picked.");
	});

	it("records decision 121 as the decisions table's row between 120 and 122, with the picks and P133's pick", () => {
		const rows = decisions.split("\n").filter((line) => line.startsWith("| "));
		const at = (prefix: string) => rows.findIndex((r) => r.startsWith(prefix));
		const row = at("| 121 | 2026-10-15 |");
		expect(row).toBeGreaterThan(at("| 120 |"));
		expect(row).toBeLessThan(at("| 122 |"));
		const last = rows[row] ?? "";
		for (const text of [
			"**P130 A (#603):**",
			"**P131 A (#604):**",
			"**P132 A (#605):**",
			`**P133 A (#605):** each finished month's dot in the month strip holds a small mark, a check on ok for under budget, a minus on over for over, or an empty ring for a month with no budgets; the shown month keeps its ink ring around the mark, the current month its ring; and each month's link names its result in words ("September, ended $2,134 over"). The owner saw three other looks (tally strokes, filled tokens, mini bars) and kept A.`,
			"Not picked: P130 B, P131 B, P132 B, P133 C, D and E.",
		])
			expect(last, text).toContain(text);
		expect(last).not.toContain("**P133:**");
		expect(last).not.toContain("drawn again before it is decided");
	});
});

// P134 and P135 (the second design audit, #606 and #607): the owner's picks, drawn for decision. Proposal only: nothing in the app changes.
describe("GET /design-system/proposals, P134 and P135 (the second audit, #606 and #607)", () => {
	const drawn = async () => (await get("/design-system/proposals")).html;
	const esc = (words: string) => words.replaceAll("'", "&#39;");
	// The audit's section, from its heading to the next section's heading (P128's, which follows it).
	const audit = (html: string) => {
		const start = html.indexOf(
			'<section aria-labelledby="audit3-title" class="mt-12">',
		);
		const end = html.indexOf("<section aria-labelledby=", start + 1);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		return html.slice(start, end);
	};
	// The names of the options marked Recommended, in drawing order.
	const recommendedOf = (chunk: string) =>
		[...chunk.matchAll(/<h4 [^>]*>([\s\S]*?)<\/h4>/g)]
			.filter((m) => (m[1] ?? "").includes(">Recommended<"))
			.map((m) => (m[1] ?? "").split("<")[0]);
	// Each picture's label and kind, in drawing order: a phone and a desktop picture can share a label.
	const PICTURE = /aria-label="([^"]*), on (a phone|desktop)"/g;
	const labels = (chunk: string) =>
		[...chunk.matchAll(PICTURE)].map((m) => `${m[1]}, on ${m[2]}`);
	// One picture's markup: from its label to the next picture's label, or to the chunk's end.
	const picture = (chunk: string, label: string) => {
		const found = [...chunk.matchAll(PICTURE)];
		const at = found.findIndex((m) => `${m[1]}, on ${m[2]}` === label);
		expect(at, label).toBeGreaterThan(-1);
		return chunk.slice(found[at]?.index ?? 0, found[at + 1]?.index);
	};
	// Each word's first place in the markup, in the order given, so a list's order can be checked.
	const inOrder = (markup: string, words: string[]) => {
		const at = words.map((word) => markup.indexOf(esc(word)));
		for (const [i, index] of at.entries()) {
			expect(index, words[i]).toBeGreaterThan(-1);
			if (i > 0) expect(index, words[i]).toBeGreaterThan(at[i - 1] ?? -1);
		}
	};
	// A's contents rows, each section's name then its live count, as More lists them (P122 A).
	const CONTENTS_ROWS = [
		"Categories",
		"7 categories · $3,940 a month",
		"Tally's rules",
		"3 merchants",
		"Household",
		"Eastern · sign-in emails on",
		"People",
		"Everyone",
		"AI suggestions",
		"All on · 23 sorted in October",
		"Your data",
		"Download",
	];
	// Pet Care's rows, newest first, as the demo's Settings card and Suggestions page list them.
	const PET_ROWS_NEWEST_FIRST = ["Banfield Pet Hospital", "Petsmart", "Chewy"];
	// The bank sign-in emails' recipients, as catalog.tsx's sample has them (the demo has no household members).
	const RECIPIENTS = ["alex@example.com", "sam@example.com", "jo@example.com"];
	// The five AI switches' hints, in Settings' order, as settings.tsx's AI_FEATURES words them.
	const AI_HINTS = [
		"Turns bank text like SQ *BLUE BOTTLE COF into Blue Bottle Coffee. You pick the name.",
		"Adds a note, the kind of spending and who it was for.",
		"Picks categories, and leaves out transfers and reimbursements.",
		"Spots paychecks and other money coming in.",
		"Sorts them right after each sync, not only overnight.",
	];
	// The Suggestions page's own chrome, as src/routes/suggestions.tsx draws it: Settings' link, then the count, then the card.
	const SETTINGS_LINK =
		'<a href="/settings" class="inline-flex min-h-11 items-center text-accent">Settings</a>';
	const expectSuggestionsChrome = (markup: string, card: string) => {
		const link = markup.indexOf(SETTINGS_LINK);
		const count = markup.indexOf("Suggestions · 1 of 5");
		const first = markup.indexOf(card);
		expect(link, "Settings' link").toBeGreaterThan(-1);
		expect(count, "the count").toBeGreaterThan(link);
		expect(first, card).toBeGreaterThan(count);
		expect(markup).not.toMatch(/<h1[^>]*>\s*Suggestions\s*<\/h1>/);
		// Each Suggestions page keeps a Skip link, as the route's card draws it.
		expect(markup, "Skip").toContain(">Skip</a>");
	};

	it("opens the Picked list with P136's section, then P130 to P133's, then the audit's section, ahead of P128, P129, P127 and P126, titled and dated as the brief asks", async () => {
		const html = await drawn();
		const top = html.indexOf(">Proposals</h1>");
		const p136 = html.indexOf('<section aria-labelledby="p136-title"');
		const picked = html.indexOf(
			'<section aria-labelledby="audit2-picks-title"',
		);
		const audit = html.indexOf(
			'<section aria-labelledby="audit3-title" class="mt-12">',
		);
		const p128 = html.indexOf(
			'<section aria-labelledby="p128-title" class="mt-12">',
		);
		const p129 = html.indexOf('<section aria-labelledby="p129-title"');
		const p127 = html.indexOf('<section aria-labelledby="p127-title"');
		const p126 = html.indexOf('<section aria-labelledby="p126-title"');
		expect(top).toBeGreaterThan(-1);
		expect(p136).toBeGreaterThan(top);
		// Nothing sits between the intro and P136's section. Between P136's section and the audit's, the only section drawn with
		// mt-12 is the P130 to P133 one: its pictures hold labelled sections too (PlanBand, TrendGroup), but none of them has that class.
		expect(html.slice(top, p136)).not.toContain("<section ");
		expect(picked).toBeGreaterThan(p136);
		expect(audit).toBeGreaterThan(picked);
		expect(
			html
				.slice(p136 + 1, audit)
				.match(/<section aria-labelledby="[^"]*" class="mt-12">/g),
		).toEqual(['<section aria-labelledby="audit2-picks-title" class="mt-12">']);
		expect(p128).toBeGreaterThan(audit);
		expect(html.slice(audit + 1, p128)).not.toContain(
			'<section aria-labelledby="p12',
		);
		expect(p129).toBeGreaterThan(p128);
		expect(p127).toBeGreaterThan(p129);
		expect(p126).toBeGreaterThan(p127);
		expect(html).toContain(
			'<h2 id="audit3-title" class="font-serif text-3xl font-semibold">Picked: from the second design audit, Settings and suggestions</h2>',
		);
		expect(html).toContain(
			"Drawn Oct 15. The owner&#39;s picks, marked Picked, are decision 120: A, Settings as a contents page, and A, one card for a category suggestion.",
		);
	});

	it("marks exactly one Picked pill in each specimen, on Option A", async () => {
		const html = await drawn();
		const settings = block(html, "p134-settings");
		const suggestions = block(html, "p135-suggestions");
		for (const [chunk, option] of [
			[settings, "Option A · A contents page, each section its own page"],
			[suggestions, "Option A · One card, one set of words, everywhere"],
		] as const) {
			expect(chunk.match(/>Picked</g)?.length).toBe(1);
			expect(optionOf(chunk, option)).toContain(">Picked<");
		}
	});

	it("gives the bank sign-in emails their fixed ids once: today's picture only", async () => {
		const html = await drawn();
		expect(html.match(/id="bank-sign-in-emails"/g)?.length).toBe(1);
		expect(html.match(/id="household-emails"/g)?.length).toBe(1);
	});

	it("draws P134 and P135 as two specimens in that order, inside the audit's section, each with its title", async () => {
		const html = await drawn();
		expect(block(html, "p134-settings")).toContain("P134 · Settings");
		expect(block(html, "p135-suggestions")).toContain(
			"P135 · Category suggestions",
		);
		expect(audit(html)).toContain('<section id="p134-settings"');
		expect(audit(html)).toContain('<section id="p135-suggestions"');
		expect(html.indexOf('<section id="p134-settings"')).toBeLessThan(
			html.indexOf('<section id="p135-suggestions"'),
		);
	});

	it("names P134's three options in order, A recommended and picked", async () => {
		const settings = block(await drawn(), "p134-settings");
		expect(optionPicks(settings)).toEqual([
			{ name: "Reference · Today on main", picked: false },
			{
				name: "Option A · A contents page, each section its own page",
				picked: true,
			},
			{ name: "Option B · One page, tidied", picked: false },
		]);
		expect(recommendedOf(settings)).toEqual([
			"Option A · A contents page, each section its own page",
		]);
	});

	it("draws P134's pictures: Today four, A four and B three, each labelled, with desktop pictures at 1280", async () => {
		const settings = block(await drawn(), "p134-settings");
		expect(labels(optionOf(settings, "Reference · Today on main"))).toEqual([
			"Reference, Settings top, on a phone",
			"Reference, Settings Household, on a phone",
			"Reference, Settings AI suggestions, on a phone",
			"Reference, Settings, on desktop",
		]);
		expect(
			labels(
				optionOf(
					settings,
					"Option A · A contents page, each section its own page",
				),
			),
		).toEqual([
			"Option A, contents, on a phone",
			"Option A, contents, on desktop",
			"Option A, Household, on a phone",
			"Option A, rules, on a phone",
		]);
		expect(labels(optionOf(settings, "Option B · One page, tidied"))).toEqual([
			"Option B, top, on a phone",
			"Option B, AI suggestions, on a phone",
			"Option B, Settings, on desktop",
		]);
	});

	it("lists A's contents rows in order, each with its live count in words, under the 5-suggestions Band", async () => {
		const settings = block(await drawn(), "p134-settings");
		const contents = picture(
			optionOf(
				settings,
				"Option A · A contents page, each section its own page",
			),
			"Option A, contents, on a phone",
		);
		expect(contents).toContain("5 suggestions to check");
		inOrder(contents, CONTENTS_ROWS);
	});

	it("draws A's contents at 1280 in a 900px window, so all six rows and Your data's Download show", async () => {
		const settings = block(await drawn(), "p134-settings");
		const desktop = picture(
			optionOf(
				settings,
				"Option A · A contents page, each section its own page",
			),
			"Option A, contents, on desktop",
		);
		// The contents list needs about 650px; a 560px window cut off Your data.
		expect(desktop).toContain("h-[900px]");
		inOrder(desktop, CONTENTS_ROWS);
	});

	it("draws A's Household with its recipients and a switch just flipped, its toast, and no Save button", async () => {
		const settings = block(await drawn(), "p134-settings");
		const option = optionOf(
			settings,
			"Option A · A contents page, each section its own page",
		);
		const household = picture(option, "Option A, Household, on a phone");
		expect(household).toContain('role="switch"');
		expect(household).toContain("Bank sign-in emails");
		// Who gets them, after the switch: the sr-only line, the open list with each address and its Remove.
		const after = household.slice(household.indexOf('role="switch"'));
		expect(after).toContain(`Goes to ${RECIPIENTS.join(", ")}`);
		expect(after).toContain("Who gets them");
		for (const email of RECIPIENTS) expect(after).toContain(email);
		expect(after.match(/>Remove<span class="sr-only"> [^<]+<\/span>/g)).toEqual(
			RECIPIENTS.map(
				(email) => `>Remove<span class="sr-only"> ${email}</span>`,
			),
		);
		expect(after).toContain(
			"Everyone who has signed in to Tally in the last 90 days.",
		);
		expect(household).toContain('role="status"');
		expect(after).toContain("Saved bank sign-in emails");
		expect(household).not.toContain(">Save<");
		expect(household).not.toContain("Tells everyone in the household");
	});

	it("draws today's Household with the app's own bank sign-in emails block, its Save, and no invented hint", async () => {
		const settings = block(await drawn(), "p134-settings");
		const today = picture(
			optionOf(settings, "Reference · Today on main"),
			"Reference, Settings Household, on a phone",
		);
		expect(today).toContain("Who gets them");
		for (const email of RECIPIENTS) expect(today).toContain(email);
		expect(today).toContain(">Save<");
		expect(today).not.toContain("Tells everyone in the household");
	});

	it("keeps each AI switch's hint in today's picture and Option B's: five aria-describedby hints, the sentences in order", async () => {
		const settings = block(await drawn(), "p134-settings");
		const option = optionOf(settings, "Option B · One page, tidied");
		for (const pic of [
			picture(
				optionOf(settings, "Reference · Today on main"),
				"Reference, Settings AI suggestions, on a phone",
			),
			picture(option, "Option B, AI suggestions, on a phone"),
		]) {
			expect(pic.match(/aria-describedby="[^"]*-hint"/g)?.length).toBe(5);
			inOrder(pic, AI_HINTS);
		}
	});

	it("draws the app's own AI tally in today's and Option B's AI pictures: In October, its three lines and Why? what Tally did, and today's after Save", async () => {
		const settings = block(await drawn(), "p134-settings");
		const today = picture(
			optionOf(settings, "Reference · Today on main"),
			"Reference, Settings AI suggestions, on a phone",
		);
		const b = picture(
			optionOf(settings, "Option B · One page, tidied"),
			"Option B, AI suggestions, on a phone",
		);
		for (const pic of [today, b]) {
			expect(pic).toContain("In October");
			expect(pic).toContain("Sorted 23 transactions · you changed 2");
			expect(pic).toContain("Cleaned 6 merchant names");
			expect(pic).toContain("Found 2 paychecks");
			expect(pic).toContain('aria-label="Why? what Tally did"');
			expect(pic).not.toContain('aria-label="Why? AI suggestions"');
			expect(pic).not.toContain("23 sorted in October");
			expect(pic).toContain(
				"Off means your rules and choices only. Nothing already decided changes.",
			);
		}
		expect(today.indexOf(">Save<")).toBeGreaterThan(-1);
		expect(today.indexOf(">Save<")).toBeLessThan(today.indexOf("In October"));
		expect(b).not.toContain(">Save<");
	});

	it("draws the Suggestions page with its real chrome in each of its four pictures, with no h1 of its own", async () => {
		const suggestions = block(await drawn(), "p135-suggestions");
		const reference = optionOf(suggestions, "Reference · Today on main");
		const a = optionOf(
			suggestions,
			"Option A · One card, one set of words, everywhere",
		);
		const b = optionOf(suggestions, "Option B · One place to answer");
		expectSuggestionsChrome(
			picture(reference, "Reference, Suggestions page, on a phone"),
			"Maybe new: Pet Care",
		);
		expectSuggestionsChrome(
			picture(a, "Option A, Suggestions page, on a phone"),
			esc("Tally's guess"),
		);
		expectSuggestionsChrome(
			picture(a, "Option A, Suggestions page, on desktop"),
			esc("Tally's guess"),
		);
		expectSuggestionsChrome(
			picture(b, "Option B, Suggestions page, on a phone"),
			esc("Tally's guess"),
		);
	});

	it("draws A's rules with each Remove a quiet muted link, the rule naming its category once, and Never suggest as one muted line", async () => {
		const settings = block(await drawn(), "p134-settings");
		const rules = picture(
			optionOf(
				settings,
				"Option A · A contents page, each section its own page",
			),
			"Option A, rules, on a phone",
		);
		// The demo's three Always rules, A to Z, as the local demo's Settings lists them (seed.ts).
		inOrder(rules, [
			"City Gym · Always Household · 2 transactions",
			"Procreate Dreams · Always Household · 2 transactions",
			"YouTube Premium · Always Household · 2 transactions",
		]);
		expect(rules).not.toContain("Costco");
		expect(rules).not.toContain("Shell");
		const remove = rules.match(
			/<a [^>]*class="([^"]*)"[^>]*>Remove<span class="sr-only"> [^<]+<\/span><\/a>/,
		);
		expect(remove, "Remove as a link").not.toBeNull();
		// Each Remove's accessible name carries its merchant, as the app's own Remove does (spec §7, decision 120).
		const removeNames = [
			...rules.matchAll(
				/<a [^>]*>Remove<span class="sr-only"> ([^<]+)<\/span><\/a>/g,
			),
		].map((m) => m[1]);
		expect(removeNames).toEqual([
			"City Gym",
			"Procreate Dreams",
			"YouTube Premium",
		]);
		expect(remove?.[1]).toContain("text-muted");
		expect(remove?.[1]).not.toContain("text-accent");
		// The Remove link is a touch target, so it is at least 44px tall (CLAUDE.md, 44px touch targets).
		expect(remove?.[1]).toContain("min-h-11");
		// The empty "Never suggest" is one muted line: its name, then the app's own sentence.
		expect(rules).toMatch(
			new RegExp(
				`<p class="[^"]*text-muted[^"]*">${esc("Never suggest: Tally hasn't been told No yet.")}</p>`,
			),
		);
		expect(rules).not.toContain("none yet");
		// The rule's name and category sit on one line, once; the Remove's sr-only name is checked above.
		expect(rules.match(/City Gym · Always Household/g)?.length).toBe(1);
	});

	it("draws each rule's visible line hidden from speech, with its spoken sentence beside it, and reads each rule row as the spec says", async () => {
		const settings = block(await drawn(), "p134-settings");
		const rules = picture(
			optionOf(
				settings,
				"Option A · A contents page, each section its own page",
			),
			"Option A, rules, on a phone",
		);
		const NAMES = ["City Gym", "Procreate Dreams", "YouTube Premium"];
		for (const name of NAMES) {
			// The visible line is aria-hidden, and its spoken sentence is the sr-only span right after it.
			expect(rules, name).toContain(
				`<span aria-hidden="true">${name} · Always Household · 2 transactions</span><span class="sr-only">${name} is always Household, 2 transactions</span>`,
			);
		}
		inOrder(
			rules,
			NAMES.map((name) => `${name} is always Household, 2 transactions`),
		);
		// What a screen reader reads of each row: its hidden line and icon left out, its tags stripped.
		const list = rules.slice(rules.indexOf("<ul"), rules.indexOf("</ul>"));
		const items = [...list.matchAll(/<li [^>]*>[\s\S]*?<\/li>/g)].map(
			(m) => m[0],
		);
		expect(items).toHaveLength(3);
		for (const [i, item] of items.entries()) {
			const name = NAMES[i] ?? "";
			const spoken = item
				.replace(/<span aria-hidden="true">[\s\S]*?<\/span>/g, "")
				.replace(/<svg[\s\S]*?<\/svg>/g, "")
				.replace(/<[^>]+>/g, "")
				.replace(/\s+/g, " ")
				.trim();
			expect(
				spoken.startsWith(`${name} is always Household, 2 transactions`),
				name,
			).toBe(true);
			expect(spoken, name).not.toContain("·");
			expect(spoken.endsWith(`Remove ${name}`), name).toBe(true);
		}
	});

	it("draws Household's category icon in cat-brown before each rule's line, in the rules' order", async () => {
		const settings = block(await drawn(), "p134-settings");
		const rules = picture(
			optionOf(
				settings,
				"Option A · A contents page, each section its own page",
			),
			"Option A, rules, on a phone",
		);
		const names = ["City Gym", "Procreate Dreams", "YouTube Premium"];
		// CategoryIcon's span in Household's colour, as the app draws a category's icon.
		const icons = [
			...rules.matchAll(/<span class="shrink-0 text-cat-brown">/g),
		].map((m) => m.index ?? -1);
		expect(icons).toHaveLength(3);
		for (const [i, name] of names.entries()) {
			const line = rules.indexOf(`${name} · Always`);
			expect(line, name).toBeGreaterThan(-1);
			expect(icons[i], name).toBeLessThan(line);
			if (i > 0) {
				expect(icons[i], name).toBeGreaterThan(
					rules.indexOf(`${names[i - 1]} · Always`),
				);
			}
		}
	});

	it("draws B's top with the in-page links under the title, in the brief's order, and B's AI picture with five switches and no Save button", async () => {
		const settings = block(await drawn(), "p134-settings");
		const option = optionOf(settings, "Option B · One page, tidied");
		inOrder(picture(option, "Option B, top, on a phone"), [
			"Categories",
			"Rules",
			"Household",
			"People",
			"AI",
			"Your data",
		]);
		const ai = picture(option, "Option B, AI suggestions, on a phone");
		expect(ai).not.toContain(">Save<");
		expect(ai.match(/role="switch"/g)?.length).toBe(5);
	});

	it("names P135's three options in order, A recommended and picked", async () => {
		const suggestions = block(await drawn(), "p135-suggestions");
		expect(optionPicks(suggestions)).toEqual([
			{ name: "Reference · Today on main", picked: false },
			{
				name: "Option A · One card, one set of words, everywhere",
				picked: true,
			},
			{ name: "Option B · One place to answer", picked: false },
		]);
		expect(recommendedOf(suggestions)).toEqual([
			"Option A · One card, one set of words, everywhere",
		]);
	});

	it("draws P135's pictures: Today three at 390, A four at 390 and the Suggestions page at 1280, B three at 390", async () => {
		const suggestions = block(await drawn(), "p135-suggestions");
		expect(labels(optionOf(suggestions, "Reference · Today on main"))).toEqual([
			"Reference, Settings card, on a phone",
			"Reference, Suggestions page, on a phone",
			"Reference, Organize, on a phone",
		]);
		expect(
			labels(
				optionOf(
					suggestions,
					"Option A · One card, one set of words, everywhere",
				),
			),
		).toEqual([
			"Option A, Categories page, on a phone",
			"Option A, Settings card, on a phone",
			"Option A, Suggestions page, on a phone",
			"Option A, Organize, on a phone",
			"Option A, Suggestions page, on desktop",
		]);
		expect(
			labels(optionOf(suggestions, "Option B · One place to answer")),
		).toEqual([
			"Option B, Settings top, on a phone",
			"Option B, Suggestions page, on a phone",
			"Option B, Organize, on a phone",
		]);
	});

	it("draws A's Categories page at 390 as its own page: the back link, its title, the seven categories, then the card under the list", async () => {
		const suggestions = block(await drawn(), "p135-suggestions");
		const option = optionOf(
			suggestions,
			"Option A · One card, one set of words, everywhere",
		);
		const page = picture(option, "Option A, Categories page, on a phone");
		// Unscrolled, so the demo banner shows; the card's lower part falls below the fold, as on a real phone.
		expect(page).toContain("Demo data. Nothing here is real.");
		inOrder(page, [
			'<a href="/settings" class="flex min-h-11 items-center gap-1 text-lg text-ink no-underline">',
			'<h1 class="mt-2 font-serif text-4xl font-semibold tracking-tight">Categories</h1>',
			">Groceries</span>",
			">Eating Out</span>",
			">Gas</span>",
			">Kids</span>",
			">Household</span>",
			">Childcare</span>",
			">Rent</span>",
			"A new category: Pet Care",
		]);
		expect(page).not.toMatch(/<h2[^>]*>Categories<\/h2>/);
	});

	it("draws A's Settings card further down Categories, with no heading of its own, Childcare and Rent before the card", async () => {
		const suggestions = block(await drawn(), "p135-suggestions");
		const option = optionOf(
			suggestions,
			"Option A · One card, one set of words, everywhere",
		);
		const card = picture(option, "Option A, Settings card, on a phone");
		// Scrolled: no banner, and the first five categories are above it.
		expect(card).not.toContain("Demo data. Nothing here is real.");
		expect(card).not.toMatch(/<h2[^>]*>Categories<\/h2>/);
		expect(card).not.toContain(">Groceries</span>");
		inOrder(card, [
			">Childcare</span>",
			">Rent</span>",
			"A new category: Pet Care",
		]);
	});

	it("gives every category row on P134 and P135 its own ids, so no cat-NNNN id is drawn twice", async () => {
		const ids = [
			...audit(await drawn()).matchAll(/ id="(cat-\d+-[^"]+)"/g),
		].map((m) => m[1]);
		expect(ids.length).toBeGreaterThan(0);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("draws today's three places with their own words: the dashed card, two headlines, and Organize with no suggestion", async () => {
		const suggestions = block(await drawn(), "p135-suggestions");
		const option = optionOf(suggestions, "Reference · Today on main");
		const card = picture(option, "Reference, Settings card, on a phone");
		expect(card).toContain("Suggested: Pet Care");
		expect(card).toContain("Dismiss");
		const page = picture(option, "Reference, Suggestions page, on a phone");
		expect(page).toContain("Maybe new: Pet Care");
		expect(page).toContain("Yes, create Pet Care");
		const organize = picture(option, "Reference, Organize, on a phone");
		expect(organize).toContain("Banfield Pet Hospital");
		expect(organize).not.toContain("Pet Care");
	});

	it("draws A's one set of words across its three places and the Suggestions page at 1280", async () => {
		const suggestions = block(await drawn(), "p135-suggestions");
		const option = optionOf(
			suggestions,
			"Option A · One card, one set of words, everywhere",
		);
		const settingsCard = picture(option, "Option A, Settings card, on a phone");
		const page = picture(option, "Option A, Suggestions page, on a phone");
		const organize = picture(option, "Option A, Organize, on a phone");
		const desk = picture(option, "Option A, Suggestions page, on desktop");
		for (const pic of [settingsCard, page, desk]) {
			expect(pic).toContain("A new category: Pet Care");
			expect(pic).toContain("Create Pet Care");
			expect(pic).toContain(esc("Tally's guess"));
			// The card's answers are Create and No, with decision 89's Why? after No. No is the quiet answer: it
			// retires the suggestion and asks decision 101's question (decision 120).
			expect(pic).toContain(">No</button>");
			expect(pic).not.toContain(">Not now</button>");
			expect(pic.indexOf(">No</button>")).toBeLessThan(
				pic.indexOf('aria-label="Why? suggested categories"'),
			);
			expect(pic).toContain('aria-label="Why? suggested categories"');
		}
		// The guess line is muted: the sparkles icon and "Tally's guess" in a text-muted paragraph, on every card.
		for (const pic of [settingsCard, page, organize, desk]) {
			expect(pic).toMatch(
				new RegExp(
					`<p class="[^"]*text-muted[^"]*">(?:(?!</p>)[\\s\\S])*${esc("Tally's guess")}</p>`,
				),
			);
		}
		expect(organize).toContain("Create Pet Care");
		expect(organize).toContain(esc("Tally's guess"));
		expect(organize).toContain(
			"Tally suggested a new category for this and 2 more: Pet Care",
		);
		expect(organize).toContain("Pick a category below");
		// Organize's card has no Why? (decision 120 names its two answers only); Skip is a link under the card on the
		// Suggestions pages alone, as the route draws it.
		expect(organize).not.toContain("Why?");
		expect(organize).not.toContain(">No</button>");
		for (const pic of [page, desk]) expect(pic).toContain(">Skip</a>");
		for (const pic of [settingsCard, organize]) {
			expect(pic).not.toContain(">Skip</a>");
		}
		for (const pic of [settingsCard, page, organize, desk]) {
			expect(pic).not.toContain("Yes, create");
			expect(pic).not.toContain("Maybe new");
			expect(pic).not.toContain("Dismiss");
			expect(pic).not.toContain("Suggested: ");
		}
	});

	it("draws one unticked row on A's Suggestions page at 390, Chewy's, with its optional note under the label in the same row, and no other picture has one", async () => {
		const suggestions = block(await drawn(), "p135-suggestions");
		const option = optionOf(
			suggestions,
			"Option A · One card, one set of words, everywhere",
		);
		const page = picture(option, "Option A, Suggestions page, on a phone");
		// Three checkboxes, and only Chewy's (transaction 7101, the last row) is unticked.
		const boxes = [...page.matchAll(/<input type="checkbox"[^>]*>/g)].map(
			(m) => m[0],
		);
		expect(boxes).toHaveLength(3);
		const unticked = boxes.filter((box) => !box.includes(" checked"));
		expect(unticked).toHaveLength(1);
		const chewy = page.indexOf(">Chewy</span>");
		const row = page.slice(
			page.lastIndexOf("<li>", chewy),
			page.indexOf("</li>", chewy),
		);
		expect(row).toContain(unticked[0]);
		// The note's wrapper follows Chewy's label, inside the same row, and the field names the transaction.
		const labelEnd = row.indexOf("</label>") + "</label>".length;
		const field = row.indexOf('<input id="p135-a-note-7101"');
		expect(field).toBeGreaterThan(labelEnd);
		expect(row.slice(labelEnd, field)).toContain('<div class="pb-2">');
		expect(row).toContain('for="p135-a-note-7101"');
		expect(row).toContain(">A note for Chewy (optional)</label>");
		const input = row.match(/<input id="p135-a-note-7101"[^>]*>/)?.[0] ?? "";
		expect(input).toContain('name="note_7101"');
		expect(input).toContain('maxlength="500"');
		expect(input).toContain('placeholder="Only used if you untick it"');
		expect(input).toContain('aria-describedby="p135-a-note-7101-hint"');
		expect(row).toContain(
			'<p id="p135-a-note-7101-hint" class="text-sm text-muted">Tally sorts it again right away, with your note.</p>',
		);
		// The field comes before the hint under the list.
		expect(page.indexOf('id="p135-a-note-7101"')).toBeLessThan(
			page.indexOf(esc("Untick any that don't belong.")),
		);
		// No other option's picture has the field: not A's Categories page, the Settings card, Organize, the 1280 picture, or B.
		// Today's reference keeps the hidden note fields its card has always drawn, so it is left out of this check.
		for (const label of labels(suggestions)) {
			if (label.startsWith("Reference,")) continue;
			if (label === "Option A, Suggestions page, on a phone") continue;
			expect(picture(suggestions, label), label).not.toContain(
				"A note for Chewy",
			);
		}
	});

	it("keeps today's reference card's own note fields, note-7101 to note-7103, and gives A's unticked note a new id", async () => {
		const suggestions = block(await drawn(), "p135-suggestions");
		const reference = picture(
			optionOf(suggestions, "Reference · Today on main"),
			"Reference, Settings card, on a phone",
		);
		for (const id of [7101, 7102, 7103]) {
			expect(reference, `note-${id}`).toContain(`id="note-${id}"`);
		}
	});

	it("says in A's note that an unticked row keeps its optional note, and that the Settings card sits on A's Categories page", async () => {
		const suggestions = block(await drawn(), "p135-suggestions");
		const note = optionOf(
			suggestions,
			"Option A · One card, one set of words, everywhere",
		);
		expect(note).toContain(
			esc(
				"An unticked row keeps its optional note, as today's card does, and Tally sorts it again with it.",
			),
		);
		expect(note).toContain(
			esc(
				"The Settings card sits on A's Categories page, under the list (P134 A, decision 120).",
			),
		);
	});

	it("lists Pet Care's rows newest first in every card and on the Suggestions pages, as the demo does", async () => {
		const suggestions = block(await drawn(), "p135-suggestions");
		const reference = optionOf(suggestions, "Reference · Today on main");
		const option = optionOf(
			suggestions,
			"Option A · One card, one set of words, everywhere",
		);
		inOrder(
			picture(reference, "Reference, Settings card, on a phone"),
			PET_ROWS_NEWEST_FIRST,
		);
		// The Suggestions page names its stores in a headline above the rows, so only the rows (after the hint) are ordered here.
		const page = picture(reference, "Reference, Suggestions page, on a phone");
		const rowsAt = page.indexOf(esc("Untick any that don't belong."));
		expect(rowsAt).toBeGreaterThan(-1);
		inOrder(page.slice(rowsAt), PET_ROWS_NEWEST_FIRST);
		inOrder(
			picture(option, "Option A, Settings card, on a phone"),
			PET_ROWS_NEWEST_FIRST,
		);
		inOrder(
			picture(option, "Option A, Suggestions page, on a phone"),
			PET_ROWS_NEWEST_FIRST,
		);
	});

	it("draws B's Settings top with only the Band for suggestions, B's Suggestions page with A's card and No, and B's Organize with one link above the chips", async () => {
		const suggestions = block(await drawn(), "p135-suggestions");
		const option = optionOf(suggestions, "Option B · One place to answer");
		const top = picture(option, "Option B, Settings top, on a phone");
		expect(top).toContain("5 suggestions to check");
		expect(top).not.toContain("Pet Care");
		const page = picture(option, "Option B, Suggestions page, on a phone");
		expect(page).toContain(">No</button>");
		expect(page).not.toContain(">Not now</button>");
		const organize = picture(option, "Option B, Organize, on a phone");
		expect(organize).toContain("Tally has a suggestion for this merchant");
		expect(organize).not.toContain("Create Pet Care");
		expect(organize.indexOf("Tally has a suggestion")).toBeLessThan(
			organize.indexOf("Groceries"),
		);
	});

	it("records P135's answer as No in decision 120's row, the word the owner picked", () => {
		const row =
			decisions.split("\n").find((line) => line.startsWith("| 120 |")) ?? "";
		expect(row).toContain(
			"then Create {name} or No, with decision 89's Why? after No",
		);
		expect(row).toContain("No retires the suggestion");
		expect(row).toContain("Skip stays on the Suggestions page only");
		expect(row).not.toContain("Open for the owner");
	});

	it("gives each desktop picture of Settings and the Suggestions page the full sidebar, with How Tally works and Feedback in its second group", async () => {
		const html = await drawn();
		const settings = block(html, "p134-settings");
		const suggestions = block(html, "p135-suggestions");
		// The sidebar's second group, under its rule, from its class to the list's end.
		const secondGroup = (desk: string) => {
			const start = desk.indexOf(
				"mt-3 flex flex-col gap-1 border-t border-rule pt-3",
			);
			expect(start).toBeGreaterThan(-1);
			return desk.slice(start, desk.indexOf("</ul>", start));
		};
		const desks = [
			picture(
				optionOf(settings, "Reference · Today on main"),
				"Reference, Settings, on desktop",
			),
			picture(
				optionOf(
					settings,
					"Option A · A contents page, each section its own page",
				),
				"Option A, contents, on desktop",
			),
			picture(
				optionOf(settings, "Option B · One page, tidied"),
				"Option B, Settings, on desktop",
			),
			picture(
				optionOf(
					suggestions,
					"Option A · One card, one set of words, everywhere",
				),
				"Option A, Suggestions page, on desktop",
			),
		];
		for (const desk of desks) {
			expect(secondGroup(desk)).toContain('href="/how-it-works"');
			expect(secondGroup(desk)).toContain("How Tally works");
			expect(secondGroup(desk)).toContain('href="/feedback"');
			expect(secondGroup(desk)).toContain("Feedback");
		}
	});

	it("says in spec §8.6 that the card's answer is Create Pet Care or No, with the Why? link after No, as decision 120 records", () => {
		const paragraph =
			spec
				.split("\n")
				.find((line) => line.startsWith("**New category suggestions")) ?? "";
		expect(paragraph).toContain("Create Pet Care or No (decision 120)");
		expect(paragraph).toContain('"Why?" link after No');
		expect(paragraph).toContain("can still Create it or answer No");
		expect(paragraph).toContain(
			"answers No, which retires the suggestion as the Suggestions page's No does and then asks decision 101's “Don't suggest Pet Care again?”",
		);
		expect(paragraph).toContain(
			"Skip, on the Suggestions page only, leaves it waiting (decision 120)",
		);
		expect(paragraph).not.toContain("Not now");
	});

	it("says in spec §7 that a rule row is read aloud with its count, as the drawing reads it", () => {
		expect(spec).toContain(
			'read aloud as "Costco is always Groceries, 23 transactions"',
		);
	});

	it("says the More → Settings suggestions Band leads to the one review for every waiting suggestion", () => {
		const row =
			spec
				.split("\n")
				.find((line) => line.startsWith("| **More → Settings** |")) ?? "";
		expect(row).toContain(
			"the one review screen for every waiting suggestion: names, categories, new categories, income and transfers (§8.6, decision 120)",
		);
		expect(row).not.toContain("merchant name review");
	});

	it("adds no client JavaScript: neither specimen nor the audit's section has a script", async () => {
		const html = await drawn();
		expect(block(html, "p134-settings")).not.toContain("<script");
		expect(block(html, "p135-suggestions")).not.toContain("<script");
		expect(audit(html)).not.toContain("<script");
	});
});

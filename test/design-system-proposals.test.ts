import { env, exports } from "cloudflare:workers";
import htmxSource from "htmx.org/dist/htmx.js?raw";
import { describe, expect, it } from "vitest";
import { DECIDED } from "../src/design-system/proposals";
import { endBarRatio } from "../src/design-system/proposals-phase5-picks";
import { designSystem } from "../src/routes/design-system";

const get = async (path: string) => {
	const res = await exports.default.fetch(`http://tally.test${path}`);
	return { res, html: await res.text() };
};
const notDemo = { ...env, DEMO: "false" } as unknown as Env;

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

	it("shows P23–P117 with one recommended option each (P91–P109 and P117 are picks drawn as decided), marks the owner's picks from P34 on, and lists every decided proposal", async () => {
		const { res, html } = await get("/design-system/proposals");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Proposals · Design system · Tally</title>");
		expect(html).not.toContain("No open proposals.");
		expect(html).not.toContain('id="p22-counts"');
		const ids = [...html.matchAll(/<section id="(p\d+[a-z0-9-]*)"/g)].map(
			(m) => m[1] ?? "",
		);
		// Every proposal from P23 to P117 is drawn, and each id is used once.
		const numbers = new Set(ids.map((id) => Number(id.match(/^p(\d+)/)?.[1])));
		for (let n = 23; n <= 117; n++) expect(numbers.has(n)).toBe(true);
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
			expect(section.match(/text-muted">Why: /g)?.length ?? 0).toBe(
				recommended,
			);
			// P34 on mark the owner's pick (decisions 72–86); P60 and P111 took two options. P120 and P121 are
			// open (no pick yet), so they mark none.
			const picked = section.match(/>Picked</g)?.length ?? 0;
			const open = id === "p120-panel" || id === "p121-header";
			const expected =
				n < 34 || open
					? 0
					: id === "p60-bills-total" || id === "p111-delete-cash"
						? 2
						: 1;
			expect([id, picked]).toEqual([id, expected]);
		}
		// Every option is a picture of a screen: labelled, and nothing inside to Tab to. An option can draw
		// more than one picture (P120's pairs, P121's open Filters), so there are at least as many as options.
		const options = html.match(/<h4 /g)?.length ?? 0;
		const pictures =
			html.match(/role="img" aria-label="[^"]*, on (a phone|desktop)"/g)
				?.length ?? 0;
		expect(pictures).toBeGreaterThanOrEqual(options);
		// …and each picture has something drawn in it, not an empty frame.
		expect(html.match(/<div data-screen="picture">/g)?.length ?? 0).toBe(
			options,
		);
		expect(html).not.toMatch(/<div data-screen="picture">\s*<\/div>/);
		expect(DECIDED.length).toBe(72);
		for (const d of DECIDED) {
			expect(html).toContain(d.title.replaceAll("'", "&#39;"));
			expect(html).toContain(d.outcome.replaceAll("'", "&#39;"));
			if (d.issue) expect(html).toContain(`/issues/${d.issue}"`);
		}
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
			"Open: the polish track, the edit panel and the list&#39;s top",
		);
		expect(html).toContain(
			"Drawn Oct 13 for the owner&#39;s pick: what the edit panel leads with, and how much of Transactions&#39; first screen goes to filters.",
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

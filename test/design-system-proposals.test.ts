import { env, exports } from "cloudflare:workers";
import htmxSource from "htmx.org/dist/htmx.js?raw";
import { describe, expect, it } from "vitest";
import { DECIDED } from "../src/design-system/proposals";
import { endBarRatio } from "../src/design-system/proposals-phase5-picks";
import { designSystem } from "../src/routes/design-system";
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

	it("shows P23–P127 with one recommended option each (P91–P109 and P117 are picks drawn as decided), marks the owner's picks from P34 on, and lists every decided proposal", async () => {
		const { res, html } = await get("/design-system/proposals");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Proposals · Design system · Tally</title>");
		expect(html).not.toContain("No open proposals.");
		expect(html).not.toContain('id="p22-counts"');
		const ids = [...html.matchAll(/<section id="(p\d+[a-z0-9-]*)"/g)].map(
			(m) => m[1] ?? "",
		);
		// Every proposal from P23 to P127 is drawn, and each id is used once. P125 is not on main yet (its drawings are on another branch).
		const numbers = new Set(ids.map((id) => Number(id.match(/^p(\d+)/)?.[1])));
		for (let n = 23; n <= 127; n++)
			if (n !== 125) expect(numbers.has(n)).toBe(true);
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
			const eachOption = id === "p118-rows" || id === "p119-saved";
			const reasons = section.match(/text-muted">Why: /g)?.length ?? 0;
			expect([id, reasons]).toEqual([
				id,
				eachOption ? (section.match(/Trade-off: /g)?.length ?? 0) : recommended,
			]);
			// P34 on mark the owner's pick (decisions 72–86), and P118 to P124 mark the owner's picks (decision 111).
			// P60 and P111 took two picks. P118, P120 and P121 mark a pick and its desktop drawing, which is the same option.
			const picked = section.match(/>Picked</g)?.length ?? 0;
			// P126 and P127 are open: the owner's pick is in words (P126) or not yet made (P127), so their pictures carry no Picked pill.
			const twoPicks = [
				"p60-bills-total",
				"p111-delete-cash",
				"p118-rows",
				"p120-panel",
				"p121-header",
			];
			const expected =
				n < 34 || n === 126 || n === 127 ? 0 : twoPicks.includes(id) ? 2 : 1;
			expect([id, picked]).toEqual([id, expected]);
			// Every option is a picture of a screen: labelled, and nothing inside to Tab to. Each option counts its own
			// pictures: exactly one for the proposals drawn before P120, and at least one from P120 on, which draw a
			// screen per step or per state (decision 47), P120 and P121 with two or three. P119's options are rows of
			// stills, checked in its own test, so they count none here. Counted per option, so one option can't lose
			// its picture while another gains one, and every picture in the proposal must sit inside an option.
			const drawn = section
				.split("<h4 ")
				.slice(1)
				.map((option) => option.match(PICTURE)?.length ?? 0);
			expect([
				id,
				drawn.every((count) =>
					id === "p119-saved"
						? count === 0
						: n >= 120
							? count >= 1
							: count === 1,
				),
			]).toEqual([id, true]);
			expect([id, section.match(PICTURE)?.length ?? 0]).toEqual([
				id,
				drawn.reduce((sum, count) => sum + count, 0),
			]);
		}
		// P119's options are rows of stills (checked in its own test), so they draw no picture above.
		expect((block(html, "p119-saved").match(/<h4 /g) ?? []).length).toBe(3);
		// …and each picture box has something drawn in it, not an empty frame. The boxes don't add up to the
		// labelled pictures (P119's stills have boxes and no label; P120 and P121 put two or three labelled
		// screens in one box), so each proposal's own test above counts its pictures.
		expect(html).not.toMatch(/<div data-screen="picture">\s*<\/div>/);
		expect(DECIDED.length).toBe(79);
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
		expect(firstVisit?.outcome).toContain("first week was sent back");
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

	it("marks the owner's picks for P118 to P124 (decision 111): each picked option carries the Picked pill, its desktop drawing too where it has one, and no other option does", async () => {
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
		// P124 A is the pick for the demo's first visit; the family's first week is still being redrawn.
		expect(html).toContain(
			"P124 A is picked for the demo&#39;s first visit; the family&#39;s first week is being redrawn.",
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
		// Childcare's numbers are the demo seed's: a $1,040 budget, and $480 from the two Fridays of October so far (Oct 2 and 9).
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

	it("opens the page with its own section, ahead of the polish pass's picks", async () => {
		const html = await drawn();
		const top = html.indexOf(">Proposals</h1>");
		const start = html.indexOf(
			'<section aria-labelledby="p126-title" class="mt-10">',
		);
		expect(top).toBeGreaterThan(-1);
		expect(start).toBeGreaterThan(top);
		// P127 is drawn first: only its own section, and the specimen inside it, come before this one.
		const before = html.slice(top, start);
		expect(before.match(/<section /g)?.length).toBe(2);
		expect(before).toContain('<section aria-labelledby="p127-title"');
		expect(start).toBeLessThan(
			html.indexOf('<section aria-labelledby="polish4-title"'),
		);
		expect(html).toContain(
			'<h2 id="p126-title" class="font-serif text-3xl font-semibold">Open: the Budget diagram with Planned</h2>',
		);
		expect(html).toContain(
			"Drawn Oct 14 for the owner&#39;s pick on #202 (PR #545): Planned joins the Budget diagram without its boxes shrinking.",
		);
	});

	it("draws the Fixed note, and three options: today's four boxes, PR #545's five, and option A", async () => {
		const chunk = section(await drawn());
		expect(chunk).toContain(
			"Already fixed by the spec: </span>the diagram is drawn by code from the same numbers as the section&#39;s worked example; its title and description read the whole sum aloud; Safe to spend is the last box, green when it&#39;s zero or more and terracotta when it&#39;s over.",
		);
		expect(options(chunk).length).toBe(3);
		expect(options(chunk)[0]).toContain(
			"Reference · Today on main: four boxes",
		);
		expect(options(chunk)[1]).toContain(
			"Reference · PR #545 as built: five boxes in one row",
		);
		expect(options(chunk)[2]).toContain(
			"Option A · Today&#39;s box size, wrapping after Bills due",
		);
	});

	it("draws today's four boxes with the real BudgetDiagram at 1280 and at 390, and no Planned box", async () => {
		const html = await drawn();
		const [today = ""] = options(section(html));
		expect(today).toContain(
			'aria-label="Reference · Today on main: four boxes, on desktop"',
		);
		expect(today).toContain(
			'aria-label="Reference · Today on main: four boxes, on a phone"',
		);
		// The real component, drawn once per width: each drawing has its own title and description ids.
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

	it("draws option A at today's box size, recommended, with the owner's pick in words noted and no Picked pill", async () => {
		const chunk = section(await drawn());
		const [, , a = ""] = options(chunk);
		expect(a).toContain(">Recommended<");
		expect(a).toContain(
			"The owner&#39;s pick in words, Oct 14; this drawing is to confirm it.",
		);
		expect(a).toContain(
			"Trade-off: a two-part diagram: the boxes split into two groups that wrap, instead of one SVG that scales; no new token, no JavaScript.",
		);
		expect(a).toContain(
			"Why: the labels stay the size they are today on every screen, and the sum still reads left to right.",
		);
		// Each line is its own SVG at natural size: 323 wide (Budget, Spent, Bills due), 230 wide (Planned and Safe to spend).
		const tags = svgs(a);
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
		expect(chunk).not.toContain(">Picked<");
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
				"Reference · Today on main: four boxes, on desktop",
				"p126-today-1280-frame",
				today,
			],
			[
				"Reference · Today on main: four boxes, on a phone",
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
	// Option A's drawing shows from this frame width up (the measured fit, as home-top.tsx's cost note says).
	const N = 375;
	// The one frame height: the tallest picture's content (Option C's), measured in Chrome at 1280 px.
	const FRAME_HEIGHT = 498;

	it("opens the page with its section first, titled and dated as the brief asks", async () => {
		const html = await drawn();
		const top = html.indexOf(">Proposals</h1>");
		const start = html.indexOf(
			'<section aria-labelledby="p127-title" class="mt-10">',
		);
		expect(top).toBeGreaterThan(-1);
		expect(start).toBeGreaterThan(top);
		expect(html.slice(top, start)).not.toContain("<section");
		expect(start).toBeLessThan(
			html.indexOf('<section aria-labelledby="p126-title"'),
		);
		expect(html).toContain(
			'<h2 id="p127-title" class="font-serif text-3xl font-semibold">Open: Safe to spend on a small phone</h2>',
		);
		expect(html).toContain(
			"Drawn Oct 14 for issue #500: what Home&#39;s Safe to spend row does when the amount needs the room.",
		);
	});

	it("draws P127 as one specimen with its title and its sentence over 320, 360 and 390 px", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		expect(chunk).toContain("P127 · Safe to spend on a small phone");
		expect(chunk).toContain(
			"Home&#39;s Safe to spend row at 320, 360 and 390 px, with $9,999 and −$9,999:",
		);
	});

	it("draws today on main and options A to C, each with six pictures: 320, 360, then 390 px, $9,999 then −$9,999", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		const list = options(chunk);
		expect(list.length).toBe(4);
		expect(list[0]).toContain("Reference · Today on main");
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
		// the first draft, nor the 442 px before the demo banner and How this works.
		const heights = new Set(
			frames.map((frame) => frame[1]?.match(/h-\[\d+px\]/)?.[0]),
		);
		expect(heights.size).toBe(1);
		expect(heights.has("h-[420px]")).toBe(false);
		expect(heights.has("h-[442px]")).toBe(false);
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

	it("hides option A's drawing below 375 px and shows it from 375 px up, by the frame's own width", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		const [, a = ""] = options(chunk);
		expect(a).toMatch(
			new RegExp(`class="[^"]*\\bhidden\\b[^"]*@min-\\[${N}px\\]:block`),
		);
		expect(a).not.toContain("@min-[360px]");
		expect(a).not.toMatch(/size-18/);
	});

	it("puts the real month navigation in every picture, inside its inert page, so its links take no focus", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		expect(chunk.match(/aria-label="Months"/g)?.length).toBe(24);
		expect(chunk.match(/>October<\/h1>/g)?.length).toBe(24);
	});

	it("draws the demo banner above the masthead in every picture, as the demo Home does", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		const banner = "Demo data. Nothing here is real.";
		expect(chunk.match(/Demo data\. Nothing here is real\./g)?.length).toBe(24);
		for (const picture of pictures(chunk)) {
			const at = picture.indexOf(banner);
			expect(at).toBeGreaterThan(-1);
			expect(at).toBeLessThan(picture.indexOf('aria-label="Tally home"'));
		}
	});

	it("draws How this works after the status sentence in every picture, as the demo Home does", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		const link = 'aria-label="How this works: the budget"';
		expect(
			chunk.match(/aria-label="How this works: the budget"/g)?.length,
		).toBe(24);
		for (const picture of pictures(chunk)) {
			// The label names the amount; the slice runs on into the next picture, so read only this label.
			const label = picture.slice(0, picture.indexOf('"'));
			const status = label.includes("with −$9,999")
				? "Over budget this month."
				: "Eating Out is $36 over.";
			const at = picture.indexOf(status);
			expect(at).toBeGreaterThan(-1);
			expect(picture.indexOf(link)).toBeGreaterThan(at);
		}
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

	it("draws the Fixed note as #566's minus fix, not yet on main, with #388's size rule and that the drawing is decoration", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		expect(chunk).not.toContain("Fixed already");
		expect(chunk).toContain(
			"In every picture: </span>#566&#39;s fix for #500 part 2 (not on main yet) keeps the minus with its number; #388&#39;s size rule steps a long amount down; the drawing is decoration and never carries meaning.",
		);
	});

	it("draws the Reference note as main plus #566's fix, with the minus kept with its number", async () => {
		const chunk = block(await drawn(), "p127-safe-small");
		expect(chunk).toContain(
			"What main draws now, plus #566&#39;s fix that keeps the minus with its number: the 112 px notebook sits beside the amount.",
		);
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

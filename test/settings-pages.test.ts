import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { settingsPlaces } from "../src/views/settings-pages";

// Settings is a contents page (decision 120): each section is its own page with Settings as its back link.

const BASE = "http://tally.test";
const SRC = import.meta.glob(["../src/**/*.{ts,tsx}"], {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

const get = async (path: string) => {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
};
async function post(path: string, fields: Record<string, string>, htmx = true) {
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			...(htmx ? { "HX-Request": "true" } : {}),
		},
		body: new URLSearchParams(fields).toString(),
	});
	return { res, html: await res.text() };
}
const trigger = (res: Response) =>
	JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
		toast?: { message: string };
		announce?: string;
	};
/** The page's text, without markup. */
const textOf = (html: string) =>
	html.replace(/<[^>]+>/g, "").replaceAll("&#39;", "'");
/** The one h1 of a page, as text. */
const h1Of = (html: string) => {
	const headings = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)];
	return headings.length === 1
		? textOf(headings[0]?.[1] ?? "")
		: `${headings.length} h1s`;
};

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
});

describe("settingsPlaces: the folios are never shortened", () => {
	it("keeps every category and the whole budget in Categories' folio, however large", () => {
		const [categories] = settingsPlaces({
			categories: { count: 50, budgetCents: 5_000_000_000 },
			merchants: 0,
			zone: DEFAULT_TIME_ZONE,
			bankEmailsOn: true,
			people: 0,
			aiOff: 0,
			sorted: 0,
			month: "2026-10",
		});
		expect(categories?.folio?.text).toBe("50 categories · $50,000,000 a month");
	});
});

describe("GET /settings: the contents page", () => {
	// Decision 128 (#676): a folio is a short phrase, not a column, so its words keep normal figures.
	it("sets the household folio's words in normal figures", async () => {
		const { html } = await get("/settings");
		const row = html.split('href="/settings/household"')[1]?.split("</a>")[0];
		const folio = row?.match(
			/<span class="([^"]*)">Eastern · sign-in emails on<\/span>/,
		);
		expect(folio).toBeDefined();
		expect(folio?.[1]).not.toContain("tabular-nums");
	});

	it("lists each section as a row to its own page, each with its live count", async () => {
		const { res, html } = await get("/settings");
		expect(res.status).toBe(200);
		expect(h1Of(html)).toBe("Settings");
		for (const [path, count] of [
			["/settings/categories", "7 categories · $4,350 a month"],
			["/settings/rules", "merchants"],
			["/settings/household", "Eastern · sign-in emails on"],
			["/settings/people", "Everyone"],
			["/settings/ai", "All on · "],
			["/settings/data", "Download"],
		] as const) {
			expect(html).toContain(`href="${path}"`);
			expect(textOf(html)).toContain(count);
		}
		// No section's rows are drawn here any more.
		expect(html).not.toContain('id="categories"');
		expect(html).not.toContain("Add category");
	});
});

describe("GET each Settings page", () => {
	const pages = [
		["/settings/categories", "Categories", "Add category"],
		["/settings/rules", "Tally's rules", "Always for these merchants"],
		["/settings/household", "Household", "Bank sign-in emails"],
		["/settings/people", "People", "Add a person"],
		["/settings/ai", "AI suggestions", "Suggest store names"],
		["/settings/data", "Your data", "Download transactions (CSV)"],
	] as const;
	for (const [path, title, marker] of pages) {
		it(`${path} has one h1 named ${title}, Settings as its first link, and its own content`, async () => {
			const { res, html } = await get(path);
			expect(res.status).toBe(200);
			expect(h1Of(html)).toBe(title);
			expect(textOf(html)).toContain(marker);
			// The back link is SubpageHead's own link (its classes are unique to it), drawn before the h1.
			const back = html.indexOf(
				'<a href="/settings" class="flex min-h-11 items-center gap-1 text-lg text-ink no-underline"',
			);
			expect(back).toBeGreaterThan(-1);
			expect(back).toBeLessThan(html.indexOf("<h1"));
			expect(textOf(html.slice(back, html.indexOf("</a>", back)))).toContain(
				"Settings",
			);
		});
	}
});

describe("Switches save when flipped", () => {
	it("the AI switches post on their own change and keep Save only inside noscript", async () => {
		const { html } = await get("/settings/ai");
		const switches = [...html.matchAll(/<input[^>]*role="switch"[^>]*>/g)].map(
			(m) => m[0],
		);
		expect(switches).toHaveLength(5);
		for (const raw of switches) {
			expect(raw).toContain('hx-post="/settings/ai"');
			expect(raw).toContain('hx-trigger="change"');
		}
		// The form itself posts nothing, so one change never sends two requests.
		expect(html).not.toMatch(/<form[^>]*hx-trigger=/);
		expect(html).toMatch(/<noscript>[\s\S]*?Save[\s\S]*?<\/noscript>/);
		expect(html.indexOf('id="ai-save"')).toBeGreaterThan(
			html.indexOf("<noscript>"),
		);
	});

	it("the bank sign-in emails switch posts on its own change, Remove posts on submit, and both swap the one stable wrapper's body", async () => {
		const { html } = await get("/settings/household");
		expect(html).toMatch(/<noscript>[\s\S]*?Save[\s\S]*?<\/noscript>/);
		// The wrapper stays on the page and its body is what each answer replaces, so answers never nest or pile up.
		expect(html).toMatch(
			/<div id="household-emails"><div id="household-emails-body">/,
		);
		expect(html.match(/id="household-emails-body"/g)).toHaveLength(1);
		const block = html.split('id="household-emails"')[1] ?? "";
		const switchTag = block.match(/<input[^>]*role="switch"[^>]*>/)?.[0] ?? "";
		const form = block.match(/<form[^>]*>/)?.[0] ?? "";
		expect(switchTag).toContain('hx-post="/settings/bank-sign-in-emails"');
		// A flip and a Remove share the wrapper's queue, so each answer lands in the order its request was sent. Both carry
		// the attribute: htmx 4 doesn't inherit hx-sync. "queue all" keeps every one; replace or queue last would drop a Remove.
		expect(switchTag).toContain('hx-trigger="change"');
		expect(switchTag).toContain('hx-sync="#household-emails:queue all"');
		expect(form).toContain('hx-post="/settings/bank-sign-in-emails"');
		expect(form).toContain('hx-sync="#household-emails:queue all"');
		// No hx-trigger on the form: htmx's default trigger for a form is its submit, and a Remove is that submit.
		expect(form).not.toContain("hx-trigger");
		expect(form).toContain("data-switches-revert");
		for (const tag of [switchTag, form]) {
			expect(tag).toContain('hx-target="#household-emails"');
			expect(tag).toContain('hx-select="#household-emails-body"');
			expect(tag).toContain('hx-swap="innerHTML"');
		}
	});

	it("a flipped AI switch answers with the page, its focus on that switch, the toast and announce", async () => {
		const { res, html } = await post("/settings/ai", { sortOnArrival: "on" });
		expect(res.status).toBe(200);
		expect(html).toContain('id="ai-suggestions"');
		expect(html).toMatch(/<input[^>]*name="names"[^>]*autofocus/);
		const sent = trigger(res);
		expect(sent.toast?.message).toBe("Saved AI suggestions");
		expect(sent.announce).toContain("Saved AI suggestions.");
	});

	it("a plain AI save goes back to the AI page", async () => {
		const { res } = await post("/settings/ai", { names: "on" }, false);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/settings/ai");
	});

	it("a plain bank sign-in emails save goes back to Household", async () => {
		const { res } = await post(
			"/settings/bank-sign-in-emails",
			{ enabled: "on" },
			false,
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/settings/household");
	});
});

describe("Plain forms go back to their page", () => {
	it("a plain People add goes back to People", async () => {
		const { res } = await post(
			"/settings/people",
			{ action: "add", name: "Grandma" },
			false,
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/settings/people");
	});
});

describe("Tally's rules page", () => {
	beforeEach(async () => {
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name, default_category_id) VALUES ('CITY GYM 4411', 'City Gym', (SELECT id FROM categories WHERE name = 'Household'))",
		).run();
	});

	it("reads each rule in one line, with its spoken sentence and a quiet Remove", async () => {
		const { html } = await get("/settings/rules");
		expect(html).toMatch(
			/<span aria-hidden="true">City Gym · Always Household · \d+ transactions?<\/span>/,
		);
		expect(html).toMatch(
			/<span class="sr-only">City Gym is always Household, \d+ transactions?<\/span>/,
		);
		expect(html).toMatch(
			/<button[^>]*text-muted[^>]*underline[^>]*>Remove<span class="sr-only"> City Gym<\/span><\/button>/,
		);
		expect(html).not.toMatch(/text-accent[^>]*>Remove/);
	});

	it("draws Never suggest with no rules as one muted line", async () => {
		await env.DB.prepare("DELETE FROM never_suggest_rules").run();
		const { html } = await get("/settings/rules");
		expect(textOf(html)).toContain(
			"Never suggest: Tally hasn't been told No yet.",
		);
	});

	it("starts its section at the top of the page, as the other Settings pages do", async () => {
		const { html } = await get("/settings/rules");
		expect(html).toMatch(
			/<section id="merchant-rules" aria-labelledby="merchant-rules-title" class="lg:max-w-3xl">/,
		);
	});
});

describe("Links point at pages", () => {
	it("no source file links to a Settings anchor", () => {
		for (const [path, source] of Object.entries(SRC)) {
			expect(source, path).not.toContain("/settings#");
		}
	});
});

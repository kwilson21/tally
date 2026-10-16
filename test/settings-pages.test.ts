import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

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

describe("GET /settings: the contents page", () => {
	it("lists each section as a row to its own page, each with its live count", async () => {
		const { res, html } = await get("/settings");
		expect(res.status).toBe(200);
		expect(h1Of(html)).toBe("Settings");
		for (const [path, count] of [
			["/settings/categories", "7 categories · $3,940 a month"],
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
	it("the AI switches post on change and keep Save only inside noscript", async () => {
		const { html } = await get("/settings/ai");
		expect(html).toMatch(/<form[^>]*hx-post="\/settings\/ai"[^>]*>/);
		expect(html).toMatch(/hx-trigger="change, submit"/);
		expect(html).toMatch(/<noscript>[\s\S]*?Save[\s\S]*?<\/noscript>/);
		expect(html.indexOf('id="ai-save"')).toBeGreaterThan(
			html.indexOf("<noscript>"),
		);
	});

	it("the bank sign-in emails switch posts on change and keeps Save only inside noscript", async () => {
		const { html } = await get("/settings/household");
		expect(html).toMatch(/hx-trigger="change, submit"/);
		expect(html).toMatch(/<noscript>[\s\S]*?Save[\s\S]*?<\/noscript>/);
		// Each flip replaces the one before it, so the switch and the toast always show the last save.
		const form =
			html.split('id="household-emails"')[1]?.match(/<form[^>]*>/)?.[0] ?? "";
		expect(form).toContain('hx-sync="replace"');
		expect(form).toContain('hx-trigger="change, submit"');
		expect(form).toContain('hx-target="#household-emails"');
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

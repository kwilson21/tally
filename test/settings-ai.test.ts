import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import {
	AI_SWITCHES_ALL_ON,
	readAiSwitches,
	saveAiSwitches,
} from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";

// The AI suggestions group in Settings (spec §8.6, decision 73, P41 B): four switches with On or
// Off in words, one Save under the group, working with or without JavaScript.

const BASE = "http://tally.test";
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
		toast?: { message: string; type: string };
		announce?: string;
	};

/** The AI suggestions section's markup. */
const group = (html: string) =>
	html.split('id="ai-suggestions"')[1]?.split("</section>")[0] ?? "";
/** The text of each switch's own input: name and whether it's on. */
const inputs = (html: string) =>
	[...group(html).matchAll(/<input[^>]*role="switch"[^>]*>/g)].map((m) => ({
		name: m[0].match(/name="([^"]*)"/)?.[1],
		on: /\schecked(\s|>|=)/.test(m[0]),
	}));
const textOf = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replaceAll("&#39;", "'")
		.replace(/\s+/g, " ");

const FIELDS = ["names", "categories", "income", "sortOnArrival"];

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
});

describe("GET /settings: the AI suggestions group", () => {
	it("sits between Categories and Your data, headed AI suggestions, with its one-line promise", async () => {
		const { res, html } = await get("/settings");
		expect(res.status).toBe(200);
		expect(html).toMatch(
			/<section id="ai-suggestions" aria-labelledby="ai-title"/,
		);
		expect(html).toMatch(/<h2 id="ai-title"[^>]*>AI suggestions<\/h2>/);
		expect(textOf(group(html))).toContain(
			"Off means your rules and choices only. Nothing already decided changes.",
		);
		const at = (needle: string) => html.indexOf(needle);
		expect(at('id="categories"')).toBeLessThan(at('id="ai-suggestions"'));
		expect(at('id="ai-suggestions"')).toBeLessThan(at('id="your-data-title"'));
	});

	it("has four switches, all on to start, each with its words and its muted line", async () => {
		const { html } = await get("/settings");
		expect(inputs(html)).toEqual(FIELDS.map((name) => ({ name, on: true })));
		const words = textOf(group(html));
		for (const sentence of [
			"Merchant names",
			"Suggests clean names for bank text.",
			"Categories and exclusions",
			"Picks categories, and leaves out transfers and reimbursements.",
			"Income",
			"Spots paychecks and other money coming in.",
			"Sort new transactions as they arrive",
			"Sorts them right after each sync, not only overnight.",
		])
			expect(words).toContain(sentence);
		// On and Off are both in the markup; the checkbox's state decides which one shows.
		expect(group(html).match(/>On</g)).toHaveLength(4);
		expect(group(html).match(/>Off</g)).toHaveLength(4);
	});

	it("never names Jev", async () => {
		const { html } = await get("/settings");
		expect(group(html)).not.toMatch(/jev/i);
	});

	it("shows each switch as it's saved", async () => {
		await saveAiSwitches(env.DB, {
			names: true,
			categories: false,
			income: true,
			sortOnArrival: false,
		});
		const { html } = await get("/settings");
		expect(inputs(html)).toEqual([
			{ name: "names", on: true },
			{ name: "categories", on: false },
			{ name: "income", on: true },
			{ name: "sortOnArrival", on: false },
		]);
		expect(textOf(group(html))).toContain(
			"Off means your rules and choices only.",
		);
	});

	it("says so plainly when every switch is off", async () => {
		await saveAiSwitches(env.DB, {
			names: false,
			categories: false,
			income: false,
			sortOnArrival: false,
		});
		const { html } = await get("/settings");
		expect(inputs(html).every((i) => !i.on)).toBe(true);
		expect(textOf(group(html))).toContain(
			"Tally sorts by your rules and choices only.",
		);
		expect(textOf(group(html))).not.toContain("Off means your rules");
	});

	it("has one Save under the group, in a form that works without JavaScript and swaps with it", async () => {
		const { html } = await get("/settings");
		const form = group(html).match(/<form[^>]*>/)?.[0] ?? "";
		expect(form).toContain('method="post"');
		expect(form).toContain('action="/settings/ai"');
		expect(form).toContain('hx-post="/settings/ai"');
		expect(form).toContain('hx-target="#ai-suggestions"');
		expect(form).toContain('hx-select="#ai-suggestions"');
		expect(form).toContain('hx-swap="outerHTML"');
		expect(group(html).match(/<form/g)).toHaveLength(1);
		const buttons = [...group(html).matchAll(/<button[^>]*>/g)];
		expect(buttons).toHaveLength(1);
		expect(buttons[0]?.[0]).toContain('type="submit"');
		// Under the switches, not beside them.
		expect(group(html).lastIndexOf('role="switch"')).toBeLessThan(
			group(html).indexOf("<button"),
		);
		expect(group(html)).toContain("Save");
		expect(group(html)).toContain("Saving…");
		// Resting, not asking for focus: only the answer to a save does.
		expect(buttons[0]?.[0]).not.toContain("autofocus");
	});
});

describe("POST /settings/ai", () => {
	it("saves the group, takes a switch left out as off, and says what it did", async () => {
		const { res, html } = await post("/settings/ai", {
			names: "on",
			income: "on",
		});
		expect(res.status).toBe(200);
		expect(await readAiSwitches(env.DB)).toEqual({
			names: true,
			categories: false,
			income: true,
			sortOnArrival: false,
		});
		// The section comes back as saved, for htmx to swap in.
		expect(inputs(html)).toEqual([
			{ name: "names", on: true },
			{ name: "categories", on: false },
			{ name: "income", on: true },
			{ name: "sortOnArrival", on: false },
		]);
		expect(trigger(res)).toEqual({
			toast: { message: "Saved AI suggestions", type: "success" },
			announce:
				"Saved AI suggestions. Merchant names on, categories and exclusions off, income on, sorting new transactions as they arrive off.",
		});
	});

	it("turns every switch back on", async () => {
		await saveAiSwitches(env.DB, {
			names: false,
			categories: false,
			income: false,
			sortOnArrival: false,
		});
		const { res } = await post("/settings/ai", {
			names: "on",
			categories: "on",
			income: "on",
			sortOnArrival: "on",
		});
		expect(await readAiSwitches(env.DB)).toEqual(AI_SWITCHES_ALL_ON);
		expect(trigger(res).announce).toContain(
			"Merchant names on, categories and exclusions on, income on, sorting new transactions as they arrive on.",
		);
	});

	it("takes only 'on' as on, so a stray value never turns an AI on", async () => {
		await post("/settings/ai", { names: "off", categories: "", income: "on" });
		expect(await readAiSwitches(env.DB)).toEqual({
			names: false,
			categories: false,
			income: true,
			sortOnArrival: false,
		});
	});

	it("moves focus to Save after the swap, which replaced the button that had it", async () => {
		const { html } = await post("/settings/ai", { names: "on" });
		expect(group(html).match(/<button[^>]*>/)?.[0]).toContain("autofocus");
	});

	it("leaves the rest of Settings and the time zone as they were", async () => {
		await env.DB.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('time_zone', 'America/Chicago') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		).run();
		const { html } = await post("/settings/ai", {});
		expect(html).toContain("Add category");
		expect(
			await env.DB.prepare(
				"SELECT value FROM household_settings WHERE key = 'time_zone'",
			).first(),
		).toEqual({ value: "America/Chicago" });
	});

	it("redirects back to the group without JavaScript, after saving", async () => {
		const { res } = await post("/settings/ai", { income: "on" }, false);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/settings#ai-suggestions");
		expect(res.headers.get("HX-Trigger")).toBeNull();
		expect((await readAiSwitches(env.DB)).categories).toBe(false);
	});

	it("is refused from another site, as every post is", async () => {
		const res = await exports.default.fetch(`${BASE}/settings/ai`, {
			method: "POST",
			headers: {
				Origin: "https://elsewhere.example",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "names=on",
		});
		expect(res.status).toBe(403);
		expect(await readAiSwitches(env.DB)).toEqual(AI_SWITCHES_ALL_ON);
	});
});

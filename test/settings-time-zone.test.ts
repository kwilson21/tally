import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { readAiSwitches, saveAiSwitches } from "../src/db/ai-switches";
import { saveTimeZone } from "../src/db/time-zone";
import { resetDemo } from "../src/demo/reset";

// The Household group in Settings (spec §8.5, decision 72, P35 A): one disclosure row, "Time zone"
// with the zone's everyday name at the right, that opens to a select and Save. It works without
// JavaScript (details and a plain form post) and swaps in place with it. Only a listed zone is
// saved, and saving changes only the time zone: "today" follows it, a transaction's date never moves.

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

/** The Household section's time zone row: from the section to the bank sign-in emails block after it. */
const group = (html: string) =>
	html.split('id="household"')[1]?.split('<div id="household-emails"')[0] ?? "";
const textOf = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replaceAll("&#39;", "'")
		.replace(/\s+/g, " ");
const summary = (html: string) =>
	group(html).match(/<summary[^>]*>[\s\S]*?<\/summary>/)?.[0] ?? "";
/** The select's options: each value and name, in order, and whether it is the chosen one. */
const options = (html: string) =>
	[...group(html).matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map((m) => ({
		value: m[1]?.match(/value="([^"]*)"/)?.[1],
		name: m[2],
		selected: /\sselected(\s|>|=|$)/.test(m[1] ?? ""),
	}));
const chosen = (html: string) => options(html).find((o) => o.selected)?.value;
const savedZone = async () =>
	(
		await env.DB.prepare(
			"SELECT value FROM household_settings WHERE key = 'time_zone'",
		).first<{ value: string }>()
	)?.value;

const at = (instant: string) => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(instant));
};

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
});
afterEach(() => {
	vi.useRealTimers();
});

describe("GET /settings: the Household group", () => {
	it("is its own page, headed Household, with Settings as its back link", async () => {
		const { res, html } = await get("/settings/household");
		expect(res.status).toBe(200);
		expect(html).toMatch(
			/<section id="household" aria-labelledby="household-title"/,
		);
		expect(html).toMatch(/<h1 id="household-title"[^>]*>Household<\/h1>/);
		expect(html.indexOf('<a href="/settings"')).toBeLessThan(
			html.indexOf("<h1"),
		);
		// People and the AI switches are pages of their own now.
		expect(html).not.toContain('id="ai-suggestions"');
		expect(html).not.toContain('id="household-people"');
	});

	it("is one disclosure row, closed, saying Time zone with Eastern at the right and a chevron", async () => {
		const { html } = await get("/settings/household");
		expect(group(html).match(/<details/g)).toHaveLength(1);
		const details = group(html).match(/<details[^>]*>/)?.[0] ?? "";
		expect(details).not.toMatch(/\sopen(\s|>|=)/);
		const row = summary(html);
		expect(textOf(row).trim()).toBe("Time zone Eastern");
		// Right-aligned value, then the chevron that turns when it opens; a 44px target.
		expect(row).toContain("ml-auto");
		expect(row).toContain("min-h-11");
		expect(row).toContain("group-open:rotate-90");
		expect(row).toContain("<svg");
		expect(details).toContain("group");
		// Resting, not asking for focus: only the answer to a save does.
		expect(row).not.toContain("autofocus");
	});

	it("says the saved zone's everyday name, and has it chosen when opened", async () => {
		await saveTimeZone(env.DB, "Pacific/Honolulu");
		const { html } = await get("/settings/household");
		expect(textOf(summary(html)).trim()).toBe("Time zone Hawaii");
		expect(chosen(html)).toBe("Pacific/Honolulu");
	});

	it("opens to a labeled select of the six US zones and then Other time zones, with Eastern chosen to start", async () => {
		const { html } = await get("/settings/household");
		const g = group(html);
		const select = g.match(/<select[^>]*>/)?.[0] ?? "";
		expect(select).toContain('name="time_zone"');
		const id = select.match(/id="([^"]*)"/)?.[1] ?? "";
		expect(id).not.toBe("");
		// The summary above already says "Time zone", so the label is for screen readers.
		expect(g).toMatch(
			new RegExp(`<label for="${id}" class="sr-only">Time zone</label>`),
		);
		expect(options(html)).toEqual([
			{ value: "America/New_York", name: "Eastern", selected: true },
			{ value: "America/Chicago", name: "Central", selected: false },
			{ value: "America/Denver", name: "Mountain", selected: false },
			{ value: "America/Los_Angeles", name: "Pacific", selected: false },
			{ value: "America/Anchorage", name: "Alaska", selected: false },
			{ value: "Pacific/Honolulu", name: "Hawaii", selected: false },
			{ value: "America/Phoenix", name: "Phoenix", selected: false },
			{ value: "America/Puerto_Rico", name: "Puerto Rico", selected: false },
			{ value: "America/Toronto", name: "Toronto", selected: false },
			{ value: "Europe/London", name: "London", selected: false },
		]);
		expect(g).toContain('<optgroup label="Other time zones">');
		expect(g.indexOf("Hawaii")).toBeLessThan(g.indexOf("<optgroup"));
		expect(g.indexOf("<optgroup")).toBeLessThan(g.indexOf("Phoenix"));
		// A 44px control, as the drawing has it.
		expect(select).toContain("min-h-11");
	});

	it("says in a muted line what the zone decides, and what it leaves alone", async () => {
		const { html } = await get("/settings/household");
		expect(textOf(group(html))).toContain(
			"Decides when a new month starts and when a bill is due. Transactions keep the bank's dates.",
		);
		const select = group(html).match(/<select[^>]*>/)?.[0] ?? "";
		const id = select.match(/id="([^"]*)"/)?.[1] ?? "";
		expect(select).toContain(`aria-describedby="${id}-hint"`);
		expect(group(html)).toContain(`id="${id}-hint"`);
	});

	it("has Save and Cancel in a form that works without JavaScript and swaps with it", async () => {
		const { html } = await get("/settings/household");
		const form = group(html).match(/<form[^>]*>/)?.[0] ?? "";
		expect(form).toContain('method="post"');
		expect(form).toContain('action="/settings/time-zone"');
		expect(form).toContain('hx-post="/settings/time-zone"');
		expect(form).toContain('hx-target="#time-zone-disclosure"');
		expect(form).toContain('hx-select="#time-zone-disclosure"');
		expect(form).toContain('hx-swap="outerHTML"');
		expect(form).toContain("hx-disable");
		expect(group(html).match(/<form/g)).toHaveLength(1);
		const save = group(html).match(/<button[^>]*>/)?.[0] ?? "";
		expect(save).toContain('type="submit"');
		expect(save).not.toContain("autofocus");
		expect(group(html)).toContain("Save");
		expect(group(html)).toContain("Saving…");
		// Cancel is a link back to the group: it closes the row without JavaScript, and with it
		// swaps only the row back, with focus on it.
		const cancel = group(html).match(/<a[^>]*>\s*Cancel\s*<\/a>/)?.[0] ?? "";
		expect(cancel).toContain('href="/settings/household"');
		expect(cancel).toContain('hx-get="/settings/household?focus=zone"');
		expect(cancel).toContain('hx-target="#time-zone-disclosure"');
		expect(cancel).toContain('hx-select="#time-zone-disclosure"');
		expect(cancel).toContain('hx-swap="outerHTML"');
	});

	it("Save and Cancel swap only the time zone row, so the bank sign-in emails block and the people list are left alone", async () => {
		const { html } = await get("/settings/household");
		const form = group(html).match(/<form[^>]*>/)?.[0] ?? "";
		expect(form).toContain('hx-target="#time-zone-disclosure"');
		expect(form).toContain('hx-select="#time-zone-disclosure"');
		const cancel = group(html).match(/<a[^>]*>\s*Cancel\s*<\/a>/)?.[0] ?? "";
		expect(cancel).toContain('hx-target="#time-zone-disclosure"');
		expect(cancel).toContain('hx-select="#time-zone-disclosure"');
		// One row, and it is a <details>; the row holds no other <details>, so its first close ends it.
		expect(html.match(/id="time-zone-disclosure"/g)).toHaveLength(1);
		const row =
			html.match(
				/<details[^>]*\sid="time-zone-disclosure"[^>]*>[\s\S]*?<\/details>/,
			)?.[0] ?? "";
		expect(row).not.toBe("");
		expect(row).toContain("<select");
		expect(row).toContain('name="time_zone"');
		expect(row).toContain('id="time-zone-save"');
		expect(row).not.toContain('id="household-emails"');
		expect(row).not.toContain('name="enabled"');
		expect(row).not.toContain('id="household-people"');
	});

	it("never names Jev, and shows no error before anything was refused", async () => {
		const { html } = await get("/settings/household");
		expect(group(html)).not.toMatch(/jev/i);
		expect(group(html)).not.toContain('role="alert"');
		expect(group(html)).not.toContain("aria-invalid");
	});

	it("puts focus on the row for Cancel's swap, and leaves it closed", async () => {
		const { html } = await get("/settings/household?focus=zone");
		expect(summary(html)).toContain("autofocus");
		const details = group(html).match(/<details[^>]*>/)?.[0] ?? "";
		expect(details).not.toMatch(/\sopen(\s|>|=)/);
		// Category rows don't take it.
		expect(html.match(/autofocus/g)).toHaveLength(1);
	});

	it("leaves the other sections on their own pages", async () => {
		const { html } = await get("/settings/household");
		expect(html).not.toContain("Add category");
		expect(html).not.toContain("Download transactions (CSV)");
	});
});

describe("POST /settings/time-zone", () => {
	it("saves the zone, comes back with its name at the right and the row closed, and says what it did", async () => {
		const { res, html } = await post("/settings/time-zone", {
			time_zone: "America/Chicago",
		});
		expect(res.status).toBe(200);
		expect(await savedZone()).toBe("America/Chicago");
		// The group comes back as saved, for htmx to swap in.
		expect(html).toContain('id="household"');
		expect(textOf(summary(html)).trim()).toBe("Time zone Central");
		expect(chosen(html)).toBe("America/Chicago");
		const details = group(html).match(/<details[^>]*>/)?.[0] ?? "";
		expect(details).not.toMatch(/\sopen(\s|>|=)/);
		expect(trigger(res)).toEqual({
			toast: { message: "Saved time zone", type: "success" },
			announce: "Saved time zone. Months and bills now follow Central time.",
		});
	});

	it("moves focus to the row, since the swap replaced the Save that had it", async () => {
		const { html } = await post("/settings/time-zone", {
			time_zone: "America/Denver",
		});
		expect(summary(html)).toContain("autofocus");
		expect(html.match(/autofocus/g)).toHaveLength(1);
	});

	it("names a zone from the Other time zones list the same way", async () => {
		const { res, html } = await post("/settings/time-zone", {
			time_zone: "America/Puerto_Rico",
		});
		expect(await savedZone()).toBe("America/Puerto_Rico");
		expect(textOf(summary(html)).trim()).toBe("Time zone Puerto Rico");
		expect(trigger(res).announce).toBe(
			"Saved time zone. Months and bills now follow Puerto Rico time.",
		);
	});

	it("saves the same zone again without a fuss", async () => {
		const { res } = await post("/settings/time-zone", {
			time_zone: "America/New_York",
		});
		expect(res.status).toBe(200);
		expect(await savedZone()).toBe("America/New_York");
	});

	it("redirects back to the group without JavaScript, after saving", async () => {
		const { res } = await post(
			"/settings/time-zone",
			{ time_zone: "America/Los_Angeles" },
			false,
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/settings/household");
		expect(res.headers.get("HX-Trigger")).toBeNull();
		expect(await savedZone()).toBe("America/Los_Angeles");
	});

	it.each([
		["a zone that isn't on the list", { time_zone: "Not/AZone" }],
		["a real zone that isn't offered", { time_zone: "Asia/Tokyo" }],
		["the zone's name instead of its code", { time_zone: "Central" }],
		["an empty value", { time_zone: "" }],
		["no field at all", {}],
	])(
		"refuses %s: the row opens with an alert and nothing changes",
		async (_, fields) => {
			await saveTimeZone(env.DB, "America/Denver");
			const { res, html } = await post("/settings/time-zone", fields);
			expect(res.status).toBe(422);
			expect(await savedZone()).toBe("America/Denver");
			expect(res.headers.get("HX-Trigger")).toBeNull();
			const g = group(html);
			// Opened, so the error is where the person is looking.
			expect(g.match(/<details[^>]*>/)?.[0]).toMatch(/\sopen(\s|>|=)/);
			expect(g).toMatch(
				/<p id="[^"]*-error" role="alert"[^>]*>Choose a time zone from the list\.<\/p>/,
			);
			const select = g.match(/<select[^>]*>/)?.[0] ?? "";
			expect(select).toContain('aria-invalid="true"');
			expect(select).toMatch(/aria-describedby="[^"]*-error/);
			// Focus goes to the field that needs fixing; the select still shows what's saved.
			expect(select).toContain("autofocus");
			expect(chosen(html)).toBe("America/Denver");
			expect(textOf(summary(html)).trim()).toBe("Time zone Mountain");
			// The rest of Settings is still there.
			expect(html).toContain('id="household"');
		},
	);

	it("shows the refusal to a plain browser too, as the page, not a redirect", async () => {
		const { res, html } = await post(
			"/settings/time-zone",
			{ time_zone: "Not/AZone" },
			false,
		);
		expect(res.status).toBe(422);
		expect(res.headers.get("Location")).toBeNull();
		expect(group(html)).toContain('role="alert"');
		expect(await savedZone()).toBe(DEFAULT_TIME_ZONE);
	});

	it("changes only the time zone: other settings, categories and every transaction's date stay", async () => {
		await saveAiSwitches(env.DB, { categories: false });
		const before = {
			dates: await env.DB.prepare(
				"SELECT id, date FROM transactions ORDER BY id",
			).all(),
			categories: await env.DB.prepare(
				"SELECT id, name, sort_order FROM categories ORDER BY id",
			).all(),
			settings: await env.DB.prepare(
				"SELECT key, value FROM household_settings WHERE key <> 'time_zone' ORDER BY key",
			).all(),
		};
		expect(before.dates.results.length).toBeGreaterThan(0);
		await post("/settings/time-zone", { time_zone: "Pacific/Honolulu" });
		await post("/settings/time-zone", { time_zone: "Europe/London" });
		expect(await savedZone()).toBe("Europe/London");
		expect(
			(
				await env.DB.prepare(
					"SELECT id, date FROM transactions ORDER BY id",
				).all()
			).results,
		).toEqual(before.dates.results);
		expect(
			(
				await env.DB.prepare(
					"SELECT id, name, sort_order FROM categories ORDER BY id",
				).all()
			).results,
		).toEqual(before.categories.results);
		expect(
			(
				await env.DB.prepare(
					"SELECT key, value FROM household_settings WHERE key <> 'time_zone' ORDER BY key",
				).all()
			).results,
		).toEqual(before.settings.results);
	});

	it("leaves the AI suggestions as they were, on their own page", async () => {
		await saveAiSwitches(env.DB, { income: false });
		await post("/settings/time-zone", { time_zone: "America/Chicago" });
		expect((await readAiSwitches(env.DB)).income).toBe(false);
		const ai = await get("/settings/ai");
		const income = ai.html.match(/<input[^>]*name="income"[^>]*>/)?.[0] ?? "";
		expect(income).not.toMatch(/\schecked(\s|>|=)/);
	});

	it("is refused from another site, as every post is", async () => {
		const res = await exports.default.fetch(`${BASE}/settings/time-zone`, {
			method: "POST",
			headers: {
				Origin: "https://elsewhere.example",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "time_zone=America%2FChicago",
		});
		expect(res.status).toBe(403);
		expect(await savedZone()).toBe(DEFAULT_TIME_ZONE);
	});
});

describe("today follows the saved zone", () => {
	// 03:30 UTC on Nov 1 is 23:30 Eastern on Oct 31, and already Nov 1 in London.
	const LATE_OCTOBER = "2026-11-01T03:30:00Z";

	it("Home turns to November the moment the zone is London, and back to October on Eastern", async () => {
		at(LATE_OCTOBER);
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		const eastern = await get("/");
		expect(eastern.html).toContain("October");
		expect(eastern.html).not.toContain("November");

		await post("/settings/time-zone", { time_zone: "Europe/London" });
		const london = await get("/");
		expect(london.html).toContain("November");
		expect(london.html).toMatch(/<h1[^>]*>November<\/h1>/);

		await post("/settings/time-zone", { time_zone: "America/New_York" });
		const back = await get("/");
		expect(back.html).toContain("October");
		expect(back.html).not.toContain("November");
	});
});

describe("a save that moves the household into another month", () => {
	// 03:30 UTC on Nov 1 is 23:30 Eastern on Oct 31 (October), and already Nov 1 in London
	// (November). Groceries' budget changes on Nov 1, and Household, which has none in October,
	// gets one, so the two months show different budgets.
	const LATE_OCTOBER = "2026-11-01T03:30:00Z";

	/** What a row's closed summary says about its budget: "$700 a month" or "No budget". */
	const amountOf = (html: string, id: number) =>
		textOf(
			`<span ${html.split(`id="cat-${id}-amount"`)[1]?.split("</summary>")[0] ?? ""}`,
		).trim();

	beforeEach(async () => {
		at(LATE_OCTOBER);
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await env.DB.prepare(
			"DELETE FROM budget_amounts WHERE category_id = 5",
		).run();
		await env.DB.prepare(
			"INSERT INTO budget_amounts (category_id, effective_month, amount_cents) VALUES (1, '2026-11', 90000), (5, '2026-11', 30000)",
		).run();
	});

	it("shows October's budgets on Categories, where the month's amounts are drawn", async () => {
		const { html } = await get("/settings/categories");
		expect(amountOf(html, 1)).toBe("$700 a month");
		expect(amountOf(html, 5)).toBe("No budget");
		expect(html).not.toContain("hx-swap-oob");
	});

	it("answers with the Household page and sends nothing out of band, since no amount is drawn there", async () => {
		const { res, html } = await post("/settings/time-zone", {
			time_zone: "Europe/London",
		});
		expect(res.status).toBe(200);
		expect(html).toContain('id="household"');
		expect(html).not.toContain("hx-swap-oob");
	});

	it("the Categories page then draws the new month's budgets", async () => {
		await post("/settings/time-zone", { time_zone: "Europe/London" });
		const landed = await get("/settings/categories");
		expect(amountOf(landed.html, 1)).toBe("$900 a month");
		expect(landed.html).not.toContain("hx-swap-oob");
	});
});

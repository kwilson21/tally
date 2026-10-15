import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

// P119 A (decision 111, #71): only a save's own reply marks the row it saved, with row-saved (or row-saved-undo
// when its toast offers Undo). Cancel, Adjust's taps, a 422 redraw, archiving and the rest never mark a row.

const BASE = "http://tally.test";

async function get(path: string, htmx = false) {
	const res = await exports.default.fetch(BASE + path, {
		headers: htmx ? { "HX-Request": "true" } : {},
	});
	return { res, html: await res.text() };
}

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

/** The whole opening tag of the link that starts with `href`, so its class is checked on that link alone. */
const linkTag = (html: string, href: string) =>
	html.match(new RegExp(`<a [^>]*href="${href}"[^>]*>`))?.[0] ?? "";
const marked = (html: string) =>
	(html.match(/\brow-saved(?:-undo)?\b/g) ?? []).length;

let bakery: number;
beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	bakery = (
		await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).first<{ id: number }>()
	)?.id as number;
});

describe("a transaction's edit panel save marks its row", () => {
	it("marks exactly the saved row in the list it returns to", async () => {
		const { html } = await post(`/transactions/${bakery}`, {
			merchant: "Local Bakery",
			note: "",
			back: "/transactions",
			category: "2",
		});
		expect(marked(html)).toBe(1);
		expect(linkTag(html, `/transactions/${bakery}[^"]*`)).toMatch(
			/\brow-saved\b/,
		);
		expect(html).toContain("saved-tick");
	});

	it("marks nothing when the save fails validation", async () => {
		const { html } = await post(`/transactions/${bakery}`, {
			merchant: "Local Bakery",
			note: "",
			back: "/transactions",
			category: "999999",
		});
		expect(marked(html)).toBe(0);
	});
});

describe("a budget sheet save marks Home's budget row and draws the bars still", () => {
	it("marks the saved category's row, and no other row", async () => {
		const { res, html } = await post("/budget/1", { budget: "650" });
		expect(res.status).toBe(200);
		expect(marked(html)).toBe(1);
		expect(linkTag(html, "/budget/1")).toMatch(/\brow-saved\b/);
	});

	it("draws Home's bars still on the save's reply, and animates them on a plain load", async () => {
		const { html } = await post("/budget/1", { budget: "650" });
		expect(html).not.toContain("bar-fill");
		const plain = await get("/");
		expect(plain.html).toContain("bar-fill");
	});

	it("marks nothing when the amount is refused and the sheet is drawn again", async () => {
		const { res, html } = await post("/budget/1", { budget: "lots" });
		expect(res.status).toBe(422);
		expect(marked(html)).toBe(0);
	});

	it("marks nothing on an Adjust tap, which keeps the bars and the rows as they are", async () => {
		const { html } = await post("/budget/1/nudge/up", {});
		expect(marked(html)).toBe(0);
		expect(html).not.toContain("saved-tick");
	});
});

describe("a savings goal save marks the Savings row", () => {
	it("marks the Savings row once a goal is set, and draws Home's bars still", async () => {
		const { res, html } = await post("/savings-goal", { goal: "500" });
		expect(res.status).toBe(200);
		expect(marked(html)).toBe(1);
		expect(linkTag(html, "/savings-goal")).toMatch(/\brow-saved\b/);
		expect(html).not.toContain("bar-fill");
	});
});

describe("a Settings category save marks its row", () => {
	it("marks the renamed category's row", async () => {
		const { res, html } = await post("/settings/categories/1", {
			name: "Food at home",
		});
		expect(res.status).toBe(200);
		expect(marked(html)).toBe(1);
		expect(html).toMatch(
			/<details class="[^"]*\brow-saved\b[^"]*" data-row="1"/,
		);
		expect(html).toContain("saved-tick");
	});

	it("marks nothing when the name is taken and the row stays open", async () => {
		const { html } = await post("/settings/categories/1", { name: "gas" });
		expect(marked(html)).toBe(0);
	});

	it("marks nothing on archive, which takes the row out of the list", async () => {
		const { html } = await post("/settings/categories/1/archive", {});
		expect(marked(html)).toBe(0);
	});
});

describe("nothing but a save's own reply marks a row", () => {
	it("marks nothing when Cancel closes the budget sheet", async () => {
		const { html } = await get("/?focus=1", true);
		expect(marked(html)).toBe(0);
	});

	it("marks nothing when Cancel closes the savings goal sheet", async () => {
		const { html } = await get("/?focus=savings-goal", true);
		expect(marked(html)).toBe(0);
	});
});

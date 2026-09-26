import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { monthName, todayUtc } from "../src/dates";
import { setBudget } from "../src/db/budgets";
import { resetDemo } from "../src/demo/reset";

// Home's Adjust mode (#94, decision 48): − and + on every budgeted row, each tap to the next round $10.
const BASE = "http://tally.test";
const get = async (path: string) => {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
};
async function post(path: string, htmx = true) {
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: { Origin: BASE, ...(htmx ? { "HX-Request": "true" } : {}) },
	});
	return { res, html: await res.text() };
}
const trigger = (res: Response) =>
	JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
		toast?: { message: string; type: string };
		announce?: string;
	};
const THIS_MONTH = () => todayUtc().slice(0, 7);
const groceriesBudget = async () =>
	(await env.DB.prepare(
		"SELECT amount_cents, effective_month FROM budget_amounts WHERE category_id = 1 ORDER BY effective_month DESC LIMIT 1",
	).first<{ amount_cents: number; effective_month: string }>()) ?? {
		amount_cents: -1,
		effective_month: "",
	};

beforeEach(async () => {
	await resetDemo(env.DB, todayUtc());
});

describe("Home day to day", () => {
	it("offers Adjust beside the Budget heading, swapping Home in place", async () => {
		const { html } = await get("/");
		expect(html).toMatch(
			/<a href="\/\?adjust=1"[^>]*id="adjust-link"[^>]*hx-get="\/\?adjust=1"[^>]*hx-target="#page"[^>]*hx-select="#page"/,
		);
		expect(html).toContain('Adjust<span class="sr-only"> budgets</span>');
		expect(html).not.toContain("/nudge/");
	});

	it("has no Adjust link when nothing is budgeted", async () => {
		await env.DB.prepare("DELETE FROM budget_amounts").run();
		const { html } = await get("/");
		expect(html).not.toContain('id="adjust-link"');
	});
});

describe("GET /?adjust=1", () => {
	it("puts − and + on every budgeted row, and says Done", async () => {
		const { html } = await get("/?adjust=1");
		expect(html).toMatch(/<a href="\/"[^>]*id="adjust-link"[^>]*hx-get="\/"/);
		expect(html).toContain(
			'Done<span class="sr-only"> adjusting budgets</span>',
		);
		expect(html).toMatch(
			/<form method="post" action="\/budget\/1\/nudge\/down" hx-post="\/budget\/1\/nudge\/down"[^>]*hx-target="#page"[^>]*hx-select="#page"[^>]*hx-sync="body:queue all"/,
		);
		expect(html).toContain('aria-label="Lower Groceries to $690"');
		expect(html).toContain('aria-label="Raise Groceries to $710"');
		expect(html).toContain('id="nudge-1-up"');
	});

	it("gives no buttons to a category it can't budget: not budgeted, or archived", async () => {
		await env.DB.prepare(
			"INSERT INTO categories (name, icon, color, sort_order) VALUES ('Travel', 'tag', 'cat-blue', 9)",
		).run();
		await env.DB.prepare(
			"UPDATE categories SET archived = 1 WHERE id = 2",
		).run();
		const { html } = await get("/?adjust=1");
		expect(html).toContain("Add a budget");
		expect(html).not.toMatch(/\/budget\/(2|\d{2,})\/nudge/);
		expect(html).toContain("/budget/1/nudge/up");
	});
});

describe("POST /budget/:id/nudge/:direction", () => {
	it("moves the budget to the next round $10 from this month on, and says so", async () => {
		const { res, html } = await post("/budget/1/nudge/up");
		expect(res.status).toBe(200);
		expect(await groceriesBudget()).toEqual({
			amount_cents: 71000,
			effective_month: THIS_MONTH(),
		});
		expect(trigger(res)).toEqual({
			toast: { message: "Groceries is $710 a month", type: "success" },
			announce: `Groceries is $710 a month from ${monthName(THIS_MONTH())} on.`,
		});
		// Home comes back still in Adjust mode, with the new amount.
		expect(res.headers.get("HX-Push-Url")).toBe("/?adjust=1");
		expect(html).toMatch(/\$\d+\s+of\s+\$710/);
		expect(html).toContain('aria-label="Raise Groceries to $720"');
	});

	it("goes down to the next round $10 too", async () => {
		await setBudget(env.DB, 1, 71240, THIS_MONTH());
		await post("/budget/1/nudge/down");
		expect((await groceriesBudget()).amount_cents).toBe(71000);
	});

	it("stops at $0, and moves focus to + so it isn't lost on the disabled −", async () => {
		await setBudget(env.DB, 1, 500, THIS_MONTH());
		const { html } = await post("/budget/1/nudge/down");
		expect((await groceriesBudget()).amount_cents).toBe(0);
		expect(html).toMatch(/id="nudge-1-down"[^>]* disabled=""/);
		expect(html).toMatch(/id="nudge-1-up"[^>]*autofocus/);

		const again = await post("/budget/1/nudge/down");
		expect(again.res.status).toBe(200);
		expect((await groceriesBudget()).amount_cents).toBe(0);
		expect(trigger(again.res)).toEqual({ announce: "Groceries is at $0." });
	});

	it("redirects back to Adjust mode without JavaScript", async () => {
		const { res } = await post("/budget/1/nudge/up", false);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/?adjust=1");
		expect((await groceriesBudget()).amount_cents).toBe(71000);
	});

	it("is a 404 for a category that is unknown, archived, or not budgeted", async () => {
		expect((await post("/budget/999/nudge/up")).res.status).toBe(404);
		await env.DB.prepare(
			"UPDATE categories SET archived = 1 WHERE id = 2",
		).run();
		expect((await post("/budget/2/nudge/up")).res.status).toBe(404);
		await env.DB.prepare(
			"INSERT INTO categories (id, name, icon, color, sort_order) VALUES (50, 'Travel', 'tag', 'cat-blue', 9)",
		).run();
		expect((await post("/budget/50/nudge/up")).res.status).toBe(404);
		expect((await post("/budget/1/nudge/sideways")).res.status).toBe(404);
	});
});

import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { monthName, todayUtc } from "../src/dates";
import { lastMonthSpentCents } from "../src/db/budgets";
import { resetDemo } from "../src/demo/reset";
import { formatCents } from "../src/money";

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
		toast?: { message: string };
		announce?: string;
	};
const textOf = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replaceAll("&#39;", "'")
		.replace(/\s+/g, " ");
const THIS_MONTH = () => monthName(todayUtc().slice(0, 7));

beforeEach(async () => {
	await resetDemo(env.DB, todayUtc());
});

describe("Home's budget rows", () => {
	it("open each category's budget sheet over Home", async () => {
		const { html } = await get("/");
		expect(html).toMatch(
			/<a href="\/budget\/1"[^>]*hx-get="\/budget\/1"[^>]*hx-target="#sheet"/,
		);
		expect(html).toContain('<div id="sheet">');
		// Every category has a budget in the demo, so nothing is listed as not budgeted.
		expect(html).not.toContain("Not budgeted");
	});

	it("list a category with no budget under Not budgeted", async () => {
		await env.DB.prepare(
			"INSERT INTO categories (name, icon, color, sort_order) VALUES ('Travel', 'tag', 'cat-blue', 9)",
		).run();
		const { html } = await get("/");
		expect(html).toMatch(/<h3[^>]*>Not budgeted<\/h3>/);
		expect(textOf(html)).toContain("Travel Add a budget");
	});

	it("show an archived category with spending, but not as a link, since it can't be budgeted", async () => {
		await env.DB.prepare(
			"UPDATE categories SET archived = 1 WHERE id = 2",
		).run();
		const { html } = await get("/");
		expect(textOf(html)).toContain("Eating Out");
		expect(html).not.toContain('href="/budget/2"');
	});

	it("leave archived categories out of Not budgeted", async () => {
		await env.DB.prepare(
			"INSERT INTO categories (name, icon, color, sort_order, archived) VALUES ('Old', 'tag', 'cat-blue', 9, 1)",
		).run();
		const { html } = await get("/");
		expect(html).not.toContain("Not budgeted");
	});
});

describe("GET /budget/:id", () => {
	it("opens the sheet with the amount, the nudges and last month's chip", async () => {
		const { res, html } = await get("/budget/1");
		expect(res.status).toBe(200);
		expect(html).toMatch(
			/role="dialog"[^>]*aria-labelledby="budget-sheet-title"/,
		);
		expect(html).toContain(`Budget from ${THIS_MONTH()} on`);
		// Its own heading id: Home's Budget heading keeps "budget-title".
		expect(html).toMatch(/<h2 id="budget-sheet-title"[^>]*>Groceries<\/h2>/);
		expect(html.match(/id="budget-title"/g)).toHaveLength(1);
		expect(html).toMatch(/<input[^>]*name="budget"[^>]*value="700"/);
		expect(html).toMatch(/<input[^>]*inputmode="decimal"/);
		for (const [delta, label] of <[string, string][]>[
			["-100", "Take away $1"],
			["-1", "Take away 1 cent"],
			["1", "Add 1 cent"],
			["100", "Add $1"],
		]) {
			expect(html).toMatch(
				new RegExp(
					`data-nudge="${delta}"[^>]*aria-label="${label.replace("$", "\\$")}"`,
				),
			);
		}
		const last = await lastMonthSpentCents(env.DB, 1, todayUtc().slice(0, 7));
		expect(html).toMatch(new RegExp(`data-set="${last}"`));
		expect(textOf(html)).toContain(`Last month: ${formatCents(last)}`);
		// $700 has no cents, so there's nothing to round up yet.
		expect(html).toMatch(/<button[^>]*data-roundup[^>]*hidden/);
		expect(html).toContain('src="/js/money.js"');
	});

	it("says so when refunds are more than the spending, matching Home", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents = -amount_cents WHERE category_id = 1 AND substr(date, 1, 7) = ?",
		)
			.bind(todayUtc().slice(0, 7))
			.run();
		const { html } = await get("/budget/1");
		expect(textOf(html)).toMatch(
			new RegExp(
				`\\$[\\d,]+\\.\\d\\d more refunded than spent in ${THIS_MONTH()}`,
			),
		);
	});

	it("starts empty for a category with no budget, with the minus buttons off", async () => {
		await env.DB.prepare(
			"DELETE FROM budget_amounts WHERE category_id = 1",
		).run();
		const { html } = await get("/budget/1");
		expect(html).toMatch(/<input[^>]*name="budget"[^>]*value=""/);
		expect(html).toMatch(/data-nudge="-100"[^>]*disabled/);
	});

	it("is a 404 for an unknown or archived category", async () => {
		expect((await get("/budget/999")).res.status).toBe(404);
		await env.DB.prepare(
			"UPDATE categories SET archived = 1 WHERE id = 1",
		).run();
		expect((await get("/budget/1")).res.status).toBe(404);
	});
});

describe("POST /budget/:id", () => {
	it("sets the budget from this month on, says so, and Home follows", async () => {
		const { res, html } = await post("/budget/1", { budget: "650.25" });
		expect(res.status).toBe(200);
		expect(trigger(res)).toEqual({
			toast: { message: "Saved the Groceries budget", type: "success" },
			announce: `Groceries is $650.25 a month from ${THIS_MONTH()} on.`,
		});
		expect(res.headers.get("HX-Push-Url")).toBe("/");
		expect(html).toMatch(/\$\d+\s+of\s+\$650/);
		// The sheet closes and focus goes back to the row.
		expect(html).toContain('<div id="sheet"></div>');
		expect(html).toMatch(/<a href="\/budget\/1"[^>]*autofocus/);
	});

	it("keeps the sheet open with the error and what was typed", async () => {
		const { res, html } = await post("/budget/1", { budget: "12.345" });
		expect(res.status).toBe(422);
		expect(html).toMatch(/role="dialog"/);
		expect(html).toMatch(/<input[^>]*value="12.345"/);
		expect(html).toMatch(
			/role="alert"[^>]*>[^<]*Enter a dollar amount, like 250 or 250.50./,
		);
		expect(html).toMatch(/<input[^>]*aria-invalid="true"/);
	});

	it("redirects to Home without JavaScript", async () => {
		const { res } = await post("/budget/1", { budget: "650" }, false);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/");
	});

	it("is a 404 for an unknown or archived category", async () => {
		expect((await post("/budget/999", { budget: "1" })).res.status).toBe(404);
	});
});

describe("closing the sheet", () => {
	it("goes back to Home with focus on the row", async () => {
		const { html: sheet } = await get("/budget/1");
		expect(sheet).toMatch(/hx-get="\/\?focus=1"/);
		const { html } = await get("/?focus=1");
		expect(html).toMatch(/<a href="\/budget\/1"[^>]*autofocus/);
	});
});

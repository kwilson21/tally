import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_TIME_ZONE,
	monthName,
	monthsBefore,
	todayIn,
} from "../src/dates";
import { lastMonthSpentCents } from "../src/db/budgets";
import { resetDemo } from "../src/demo/reset";
import { formatCents, toCents } from "../src/money";

const BASE = "http://tally.test";
/** A transaction row's amount in integer cents: "$50.00" is money out, "+$15.00" money in (negative). */
const rowCents = (row: string) => {
	const text =
		row.match(/shrink-0 text-lg">([^<]+)<\/span>/)?.[1]?.trim() ?? "";
	const cents = toCents(text.replace(/^\+/, ""));
	return text.startsWith("+") ? -cents : cents;
};
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
const THIS_MONTH = () => monthName(todayIn(DEFAULT_TIME_ZONE).slice(0, 7));

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
});

describe("Home's budget rows", () => {
	it("open each category's budget sheet over Home", async () => {
		const { html } = await get("/");
		expect(html).toMatch(
			/<a href="\/budget\/1"[^>]*hx-get="\/budget\/1"[^>]*hx-target="#sheet"/,
		);
		expect(html).toContain('<div id="sheet">');
		// Savings has no goal yet, so it is the one row under Not budgeted.
		expect(textOf(html)).toContain("Not budgeted Savings Set a goal");
		expect(textOf(html)).not.toContain("Add a budget");
	});

	it("list a category with no budget under Not budgeted", async () => {
		await env.DB.prepare(
			"INSERT INTO categories (name, icon, color, sort_order) VALUES ('Travel', 'tag', 'cat-blue', 9)",
		).run();
		const { html } = await get("/");
		expect(html).toMatch(/<h3[^>]*>Not budgeted<\/h3>/);
		expect(textOf(html)).toContain("Travel Add a budget");
	});

	it("shows counted spending under a Not budgeted category and leaves an empty one unchanged", async () => {
		const month = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		await env.DB.prepare(
			"DELETE FROM categories WHERE name='No spending'",
		).run();
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare(
				"INSERT INTO categories (name, icon, color, sort_order) VALUES ('No spending', 'tag', 'cat-blue', 9)",
			),
			env.DB.prepare("DELETE FROM budget_amounts WHERE category_id = 4"),
			env.DB.prepare(`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, category_source)
				VALUES (901, 1, ?, 6000, 'KIDS', 4, 'user')`).bind(`${month}-05`),
		]);
		const { html } = await get("/");
		expect(textOf(html)).toContain("Kids $60 spent");
		expect(textOf(html)).toContain("No spending Add a budget");
		expect(textOf(html)).not.toContain("No spending $0 spent");
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
		expect(html).toContain("Not budgeted");
		expect(textOf(html)).toContain("Savings Set a goal");
		expect(textOf(html)).not.toContain("Old Add a budget");
	});
});

describe("GET /budget/:id", () => {
	it("links to exactly the category and month transactions that count in the budget", async () => {
		const month = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		const nextMonth = monthsBefore(month, -1);
		const counted = [1000, 2000, 500, 600, 700, 800, 900, 100, 4000];
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			...counted.map((cents, index) =>
				env.DB.prepare(`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, category_source, excluded)
					VALUES (?, 1, ?, ?, ?, 1, 'user', ?)`).bind(
					910 + index,
					index === 8
						? `${nextMonth}-02`
						: `${month}-${String(index + 1).padStart(2, "0")}`,
					cents,
					index === 8 ? "LATE BILL" : `COUNTED ${index + 1}`,
					index === 8 ? 1 : 0,
				),
			),
			env.DB.prepare(`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, category_source, excluded)
				VALUES (919, 1, ?, 3000, 'EXCLUDED', 1, 'user', 1)`).bind(
				`${month}-10`,
			),
			env.DB.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, category_id, merchant_raw_name) VALUES (910, 'Kids activity', 4000, 1, 'monthly', 1, 'LATE BILL')",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments (id, bill_id, period, transaction_id, matched_by, status) VALUES (910, 910, ?, 918, 'user', 'linked')",
			).bind(month),
		]);
		const { html: sheet } = await get("/budget/1");
		expect(sheet).toMatch(
			new RegExp(
				`<a[^>]*href="/transactions\\?category=1&amp;month=${month}&amp;show=spending"[^>]*>9 transactions`,
			),
		);
		const { html: list } = await get(
			`/transactions?month=${month}&category=1&show=spending`,
		);
		const rows = [
			...list.matchAll(/<li data-transaction="(\d+)">([\s\S]*?)<\/li>/g),
		];
		expect(rows).toHaveLength(9);
		const listedCents = rows.reduce((sum, row) => {
			const text =
				row[2]?.match(/shrink-0 text-lg">([^<]+)<\/span>/)?.[1] ?? "";
			return sum + Math.round(Number(text.replace(/[$,]/g, "")) * 100);
		}, 0);
		expect(listedCents).toBe(counted.reduce((sum, cents) => sum + cents, 0));
		expect(rows.map((row) => row[1])).toContain("918");
		expect(rows.map((row) => row[1])).not.toContain("919");
		expect(list).not.toContain("EXCLUDED");
		expect(textOf(sheet)).toContain("$106.00 spent");
	});

	it("opens a list of exactly the rows the sheet counts: a linked refund in both, an unreviewed credit and an excluded purchase in neither", async () => {
		const month = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		const nextMonth = monthsBefore(month, -1);
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare(`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, category_source, excluded)
				VALUES (940, 1, ?, 5000, 'GROCER A', 1, 'user', 0),
				(941, 1, ?, 3000, 'GROCER B', 1, 'user', 0)`).bind(
				`${month}-03`,
				`${month}-04`,
			),
			// A reviewed refund of 940, dated next month and filed under Eating Out: it counts in 940's
			// month and category (spec §6).
			env.DB.prepare(`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, category_source, excluded, refund_of_id, credit_reviewed, credit_reviewed_by)
				VALUES (942, 1, ?, -1500, 'RETURN A', 2, 'user', 0, 940, 1, 'user')`).bind(
				`${nextMonth}-02`,
			),
			// A credit with a category from a merchant rule that nobody has reviewed: it counts in neither
			// Spent nor the list until it is reviewed (spec §6, decision 70).
			env.DB.prepare(`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, category_source, excluded, credit_reviewed)
				VALUES (943, 1, ?, -2000, 'CREDIT B', 1, 'merchant_rule', 0, 0)`).bind(
				`${month}-05`,
			),
			// An excluded purchase in the category: left out of Spent and of the list (spec §6.1 rule 4).
			env.DB.prepare(`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, category_source, excluded)
				VALUES (944, 1, ?, 4000, 'GROCER C', 1, 'user', 1)`).bind(
				`${month}-06`,
			),
		]);
		const { html: sheet } = await get("/budget/1");
		const linked = Number(
			sheet.match(
				new RegExp(
					`<a[^>]*href="/transactions\\?category=1&amp;month=${month}&amp;show=spending"[^>]*>(\\d+) transactions`,
				),
			)?.[1],
		);
		expect(linked).toBe(3);
		expect(textOf(sheet)).toContain("$65.00 spent so far");

		const { html: list } = await get(
			`/transactions?month=${month}&category=1&show=spending`,
		);
		const rows = [
			...list.matchAll(/<li data-transaction="(\d+)">([\s\S]*?)<\/li>/g),
		];
		expect(rows).toHaveLength(linked);
		expect(rows.map((row) => row[1]).sort()).toEqual(["940", "941", "942"]);
		expect(rows.reduce((sum, row) => sum + rowCents(row[2] ?? ""), 0)).toBe(
			6500,
		);
		expect(textOf(list)).toContain("3 spending transactions in Groceries");

		const { html: home } = await get("/");
		expect(textOf(home)).toContain("Groceries $65 of $700");
	});

	it("does not show a transactions button when none count", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
		]);
		const { res, html } = await get("/budget/1");
		expect(res.status).toBe(200);
		expect(html).toContain('aria-labelledby="budget-sheet-title"');
		expect(html).not.toMatch(/href="\/transactions\?category=1/);
	});

	it("shows the three-month average chip in the demo budget sheet", async () => {
		const month = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare(`INSERT INTO transactions
				(id, account_id, date, amount_cents, raw_name, category_id, category_source) VALUES
				(800, 1, ?, 60000, 'JULY', 1, 'user'),
				(801, 1, ?, 65000, 'AUGUST', 1, 'user'),
				(802, 1, ?, 70000, 'SEPTEMBER', 1, 'user')`).bind(
				...[3, 2, 1].map((n) => `${monthsBefore(month, n)}-01`),
			),
		]);
		const { html } = await get("/budget/1");
		expect(html).toContain("3-month average: $650.00");
		expect(html).toMatch(/data-set="65000"[^>]*aria-pressed="false"/);
		expect(html).toMatch(/data-set="65000"[^>]*class="[^"]*min-h-11/);
	});

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
		// DESIGN.md Type roles: a sheet's title is 4xl, a size above the Budget section title (3xl) behind it.
		expect(html).toMatch(
			/<h2 id="budget-sheet-title" class="min-w-0 wrap-anywhere font-serif text-4xl font-semibold tracking-tight"/,
		);
		expect(html).toMatch(
			/<h2 id="budget-title" class="font-serif text-3xl font-semibold"/,
		);
		expect(html).toMatch(/<input[^>]*name="budget"[^>]*value="700.00"/);
		expect(html).toMatch(/<input[^>]*inputmode="decimal"/);
		for (const [delta, label] of <[string, string][]>[
			["-100", `Decrease Budget from ${THIS_MONTH()} on by $1`],
			["-1", `Decrease Budget from ${THIS_MONTH()} on by 1 cent`],
			["1", `Increase Budget from ${THIS_MONTH()} on by 1 cent`],
			["100", `Increase Budget from ${THIS_MONTH()} on by $1`],
		]) {
			expect(html).toMatch(
				new RegExp(
					`data-nudge="${delta}"[^>]*aria-label="${label.replace("$", "\\$")}"`,
				),
			);
		}
		const last = await lastMonthSpentCents(
			env.DB,
			1,
			todayIn(DEFAULT_TIME_ZONE).slice(0, 7),
		);
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
			.bind(todayIn(DEFAULT_TIME_ZONE).slice(0, 7))
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
		expect(html).toMatch(
			/<input[^>]*aria-invalid="true"[^>]*class="[^"]*field-shake[^"]*"/,
		);
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

	it("falls back to the Budget heading when the row is gone, so focus is never lost", async () => {
		// Someone archived it on another screen while the sheet was open.
		await env.DB.prepare(
			"UPDATE categories SET archived = 1 WHERE id = 2",
		).run();
		const { html } = await get("/?focus=2");
		expect(html).toMatch(
			/<h2 id="budget-title"[^>]*tabindex="-1"[^>]*autofocus/,
		);
		expect(html.match(/autofocus/g)).toHaveLength(1);
		// With a row to go to, the heading stays out of the way.
		const { html: normal } = await get("/?focus=1");
		expect(normal).not.toMatch(/<h2 id="budget-title"[^>]*autofocus/);
	});
});

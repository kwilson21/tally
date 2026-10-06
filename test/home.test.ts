import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { summarizeMonth } from "../src/budget";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { loadMonth } from "../src/db/month";
import { resetDemo } from "../src/demo/reset";
import { loadBillRows } from "../src/routes/bills";
import { home as homeRoute } from "../src/routes/home";

async function home() {
	const res = await exports.default.fetch("http://tally.test/");
	return { res, html: await res.text() };
}

describe("GET / with the demo seed", () => {
	beforeEach(async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	});

	it("renders an HTML page titled Tally", async () => {
		const { res, html } = await home();
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(html).toContain("<title>Tally</title>");
		expect(html).toContain('<html lang="en">');
	});

	it("uses a fixed number of D1 statements for a large Home request", async () => {
		const month = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		await env.DB.prepare(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400)
			 INSERT INTO transactions (account_id,date,amount_cents,raw_name,category_id)
			 SELECT 1, ?, 100, 'Home count ' || i, 1 FROM n`,
		)
			.bind(`${month}-05`)
			.run();
		await env.DB.prepare(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
			 INSERT INTO bills (name,amount_cents,due_day,frequency,merchant_raw_name)
			 SELECT 'Home count ' || i, 100, 20, 'monthly', 'Home count ' || i FROM n`,
		).run();

		let statements = 0;
		const db = new Proxy(env.DB, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (property === "prepare")
					return (sql: string) => {
						statements += 1;
						return target.prepare(sql);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const app = new Hono<{ Bindings: Env }>().route("/", homeRoute);
		const response = await app.request(
			"http://tally.test/",
			{},
			{ ...env, DB: db },
		);
		expect(response.status).toBe(200);
		expect(statements).toBeLessThanOrEqual(20);
	});

	it("leads with safe to spend and the status sentence", async () => {
		const { html } = await home();
		expect(html).toContain("Safe to spend");
		expect(html).toMatch(/Safe to spend[\s\S]*?<\/p><p[^>]*>\$[\d,]+/);
		expect(html).toContain('href="/how-it-works#budget"');
		expect(html).toContain('aria-label="Why? safe to spend"');
		expect(html).toContain(
			"Eating Out is $36 over. Everything else is on track.",
		);
	});

	it("links the uncategorized count to the filtered list", async () => {
		const { html } = await home();
		expect(html).toContain('href="/transactions?uncategorized=1"');
		expect(html).toMatch(
			/12<span class="sr-only"> transactions<\/span> need\s+a\s+category/,
		);
	});

	it("lists due and overdue bills under an accurate heading", async () => {
		const { html } = await home();
		expect(html).toContain("Bills due soon");
		expect(html).toContain("Electric");
		expect(html).toContain("Internet");
		expect(html).not.toContain("Bills due in the next 7 days");
	});

	it("draws Bills due soon as a section title, the same size as Budget", async () => {
		const { html } = await home();
		// DESIGN.md Type roles: a section title is 3xl, and Home's two section titles match.
		expect(html).toMatch(
			/<h2 id="budget-title"[^>]*class="font-serif text-3xl font-semibold"/,
		);
		expect(html).toMatch(
			/<h2\s+id="home-bills-title"\s+class="font-serif text-3xl font-semibold"\s*>/,
		);
	});

	it("subtracts exactly active, unpaid due and overdue bills", async () => {
		const dollars = (html: string) =>
			Number(
				html
					.match(/class="font-serif text-6xl[^"]*">(?:−)?\$([\d,]+)/)?.[1]
					?.replaceAll(",", "") ?? Number.NaN,
			);
		const withBills = dollars((await home()).html);
		await env.DB.prepare("UPDATE bills SET active=0").run();
		const withoutBills = dollars((await home()).html);
		// The demo's only unpaid active due/overdue bills are $142 + $65 + $15.49 (Netflix, overdue with a price change on offer).
		expect(withoutBills - withBills).toBe(222);
	});

	it("shows spent of budget per category, and marks over budget with a word", async () => {
		const { html } = await home();
		expect(html).toMatch(/\$395\s+of\s+\$700/);
		expect(html).toMatch(/\$286\s+of\s+\$250/);
		// Eating Out is $36 over; its words say by how much (decision 46).
		expect(
			html.match(/ over<span class="sr-only"> budget<\/span>/g)?.length,
		).toBe(1);
		expect(html).toContain("$36 over");
	});

	it("counts the seeded split's children, not its parent, in Home and Budget data", async () => {
		const month = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		const parent = await env.DB.prepare(
			"SELECT amount_cents FROM transactions WHERE raw_name = 'COSTCO WHSE #0431' AND is_split = 1",
		).first<{ amount_cents: number }>();
		const children = await env.DB.prepare(
			"SELECT amount_cents AS amountCents FROM transactions WHERE parent_id = (SELECT id FROM transactions WHERE raw_name = 'COSTCO WHSE #0431' AND is_split = 1)",
		).all<{ amountCents: number }>();
		const data = await loadMonth(env.DB, month);
		expect(parent?.amount_cents).toBe(18742);
		expect(
			children.results.reduce((sum, row) => sum + row.amountCents, 0),
		).toBe(18742);
		for (const child of children.results) {
			expect(data.transactions).toContainEqual(expect.objectContaining(child));
		}
		expect(data.transactions).not.toContainEqual(
			expect.objectContaining({ amountCents: parent?.amount_cents }),
		);
		const html = (await home()).html;
		expect(html).toMatch(/\$395\s+of\s+\$700/);
		expect(html).toMatch(/\$286\s+of\s+\$250/);
	});

	it("says needs a category once: the Band carries the amount, and there's no Uncategorized row (decision 50)", async () => {
		const { html } = await home();
		expect(html).toMatch(
			/12<span class="sr-only"> transactions<\/span> need a category[\s\S]*?\$228 of this month&#39;s spending/,
		);
		expect(html).not.toContain("Uncategorized");
	});

	it("shows the picked negative amount and sentence, and keeps the label at exactly zero", async () => {
		const today = todayIn(DEFAULT_TIME_ZONE);
		const month = today.slice(0, 7);
		const data = await loadMonth(env.DB, month);
		const billData = await loadBillRows(env.DB, today);
		const dueBills = billData.rows
			.filter(
				(bill) =>
					bill.active && (bill.status === "due" || bill.status === "overdue"),
			)
			.reduce((sum, bill) => sum + bill.amountCents, 0);
		const safe = summarizeMonth({
			month,
			...data,
			unpaidDueBillsCents: dueBills,
		}).safeToSpendCents;
		const budget = await env.DB.prepare(
			"SELECT category_id AS categoryId, amount_cents AS amountCents FROM budget_amounts ORDER BY category_id LIMIT 1",
		).first<{ categoryId: number; amountCents: number }>();
		if (!budget) throw new Error("Demo budget is missing");
		await env.DB.prepare(
			"UPDATE budget_amounts SET amount_cents = amount_cents - ? WHERE category_id = ?",
		)
			.bind(safe + 12000, budget.categoryId)
			.run();
		const negative = (await home()).html;
		expect(negative).toContain("−$120");
		expect(negative).toContain(
			"Over budget this month. Spending more takes it further over.",
		);
		expect(negative).not.toContain("Everything is on track.");
		expect(negative).not.toContain("cut back");
		expect(negative).toContain("Safe to spend");
		await env.DB.prepare(
			"UPDATE budget_amounts SET amount_cents = amount_cents + 12000 WHERE category_id = ?",
		)
			.bind(budget.categoryId)
			.run();
		const zero = (await home()).html;
		expect(zero).toContain("Safe to spend");
		expect(zero).toContain(">$0</p>");
	});

	it("shows older uncategorized transactions in the Band chip", async () => {
		const month = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		const olderMonth =
			month === "2026-01"
				? "2025-12"
				: `${month.slice(0, 5)}${String(Number(month.slice(5)) - 1).padStart(2, "0")}`;
		await env.DB.prepare(
			`UPDATE transactions SET date = ? WHERE id IN (
				SELECT id FROM transactions WHERE category_id IS NULL AND date LIKE ? AND excluded = 0 AND flag_income = 0 LIMIT 6
			)`,
		)
			.bind(`${olderMonth}-01`, `${month}%`)
			.run();
		const html = (await home()).html;
		expect(html).toContain("+6 older");
		expect(html).toMatch(/of this month&#39;s spending/);
	});

	it("keeps the Band for older-only uncategorized transactions and hides it when none remain", async () => {
		const month = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		const olderMonth =
			month === "2026-01"
				? "2025-12"
				: `${month.slice(0, 5)}${String(Number(month.slice(5)) - 1).padStart(2, "0")}`;
		await env.DB.prepare(
			`UPDATE transactions SET date = ? WHERE id IN (
				SELECT id FROM transactions WHERE category_id IS NULL AND date LIKE ? AND excluded = 0 AND flag_income = 0 LIMIT 6
			)`,
		)
			.bind(`${olderMonth}-01`, `${month}%`)
			.run();
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 1 WHERE category_id IS NULL AND date LIKE ? AND excluded = 0 AND flag_income = 0",
		)
			.bind(`${month}%`)
			.run();
		const olderOnly = (await home()).html;
		expect(olderOnly).toMatch(
			/6 transactions from earlier months need a category/,
		);
		expect(olderOnly).not.toContain("of this month's spending");
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 1 WHERE category_id IS NULL",
		).run();
		expect((await home()).html).not.toContain("need a category");
	});

	it("says the uncategorized amount even when refunds are more than the spending", async () => {
		// Make the uncategorized transactions net to −$50: refunds more than purchases.
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents = 0 WHERE category_id IS NULL",
		).run();
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents = -5000 WHERE id = (SELECT MIN(id) FROM transactions WHERE category_id IS NULL AND excluded = 0 AND flag_income = 0 AND date LIKE ?)",
		)
			.bind(`${todayIn(DEFAULT_TIME_ZONE).slice(0, 7)}%`)
			.run();
		const { html } = await home();
		expect(html).toContain("$50 more refunded than spent");
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents = 0 WHERE category_id IS NULL",
		).run();
		expect((await home()).html).toContain("$0 of this month&#39;s spending");
		// Cents only when there are some, so a small refund surplus isn't rounded away.
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents = -30 WHERE id = (SELECT MIN(id) FROM transactions WHERE category_id IS NULL AND excluded = 0 AND flag_income = 0 AND date LIKE ?)",
		)
			.bind(`${todayIn(DEFAULT_TIME_ZONE).slice(0, 7)}%`)
			.run();
		expect((await home()).html).toContain("$0.30 more refunded than spent");
	});

	it("puts the number first: the month, budget remaining, the Band, Budget, then Things to try (#92)", async () => {
		const { html } = await home();
		const at = (s: string) => html.indexOf(s);
		expect(html).toMatch(/<h1 class="font-serif text-2xl[^"]*">/);
		expect(at("Safe to spend")).toBeLessThan(
			at('12<span class="sr-only"> transactions</span> need'),
		);
		expect(
			at('12<span class="sr-only"> transactions</span> need'),
		).toBeLessThan(at(">Budget<"));
		expect(at(">Budget<")).toBeLessThan(at("New here? Things to try"));
	});

	it("gives the top and the Budget list one width on desktop (H6)", async () => {
		const { html } = await home();
		const column = html.indexOf('<div class="lg:max-w-2xl">');
		expect(column).toBeGreaterThan(-1);
		expect(column).toBeLessThan(html.indexOf("Safe to spend"));
		expect(html).not.toContain('<section class="mt-8 lg:max-w-2xl"');
	});
});

describe("GET / with no data", () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM bills"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM budget_amounts"),
		]);
	});

	it("says no budgets are set and hides the band", async () => {
		const { res, html } = await home();
		expect(res.status).toBe(200);
		expect(html).toContain("No budgets set yet.");
		expect(html).not.toContain("need a category");
		expect(html).toContain("$0");
	});

	it("lists every category under Not budgeted, each opening its budget sheet", async () => {
		const { html } = await home();
		expect(html.match(/No budgets/g)?.length).toBe(1);
		expect(html).toMatch(/<h3[^>]*>Not budgeted<\/h3>/);
		expect(html.match(/Add a budget/g)?.length).toBe(5);
		expect(html).toMatch(/<a href="\/budget\/1"/);
	});
});

describe("GET / with no categories", () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM budget_amounts"),
			env.DB.prepare("DELETE FROM categories"),
		]);
	});

	it("shows an empty state where the Budget list would be", async () => {
		const { html } = await home();
		expect(html).toContain("No categories to budget yet.");
		expect(html).toContain("Add a category in Settings to get started.");
		expect(html).toMatch(/<a[^>]*href="\/settings"[^>]*>Open Settings<\/a>/);
	});
});

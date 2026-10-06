import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { budgetForMonth } from "../src/budget";
import { DEFAULT_TIME_ZONE, monthsBefore, todayIn } from "../src/dates";
import { setBudget } from "../src/db/budgets";
import { firstCountedMonth, loadMonth } from "../src/db/month";
import { resetDemo } from "../src/demo/reset";
import { home as homeRoute } from "../src/routes/home";

async function home() {
	const res = await exports.default.fetch("http://tally.test/");
	return { res, html: await res.text() };
}

async function homeAt(month: string) {
	const res = await exports.default.fetch(`http://tally.test/?month=${month}`);
	return { res, html: await res.text() };
}

describe("GET / with the demo seed", () => {
	beforeEach(async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	});

	it("uses a fixed number of database statements as transaction history grows", async () => {
		const requestCount = async () => {
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
			const response = await homeRoute.request("http://tally.test/", {}, {
				...env,
				DB: db,
			} as Env);
			expect(response.status).toBe(200);
			return statements;
		};
		const before = await requestCount();
		await env.DB.prepare(`INSERT INTO transactions (account_id,date,amount_cents,raw_name) VALUES
			(1,'2024-01-01',100,'OLD 1'),(1,'2024-02-01',100,'OLD 2'),(1,'2024-03-01',100,'OLD 3')`).run();
		expect(await requestCount()).toBe(before);
	});

	it("shows a finished month read-only, using that month's budget history", async () => {
		const { html } = await homeAt("2026-09");
		expect(html).toContain("September ended");
		expect(html).not.toContain("Safe to spend");
		expect(html).not.toContain("Adjust");
		expect(html).not.toMatch(/href="\/budget\//);
		expect(html).toContain("Back to October");
		expect(html).toContain('href="/?month=2026-08"');
		expect(html).toContain('href="/?month=2026-10"');
	});

	it("keeps a finished month's budget when the category amount changes later", async () => {
		const data = await loadMonth(env.DB, "2026-09");
		const previous = budgetForMonth(data.amounts, 1, "2026-09");
		if (previous === null) throw new Error("Groceries has no September budget");
		const current = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		await setBudget(env.DB, 1, previous + 12300, current);
		const { html } = await homeAt("2026-09");
		expect(html).toContain(
			`${(previous / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
		);
		expect(html).not.toContain(
			`of $${((previous + 12300) / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
		);
	});

	it("stamps $86 under, then $42 over when unbudgeted spending grows", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM budget_amounts"),
			env.DB.prepare(
				"INSERT INTO budget_amounts (category_id, effective_month, amount_cents) VALUES (1, '2026-09', 100000), (2, '2026-09', 85000)",
			),
			env.DB.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id) VALUES (90001, 1, '2026-09-02', 100000, 'GROCERIES', 1), (90002, 1, '2026-09-03', 73400, 'EATING OUT', 2), (90003, 1, '2026-09-04', 3000, 'UNBUDGETED', NULL)",
			),
		]);
		const under = (await homeAt("2026-09")).html;
		expect(under).toContain("September ended");
		expect(under).toContain(">$86</p>");
		expect(under).toContain("border-ok text-ok");

		await env.DB.prepare(
			"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name) VALUES (90004, 1, '2026-09-05', 12800, 'MORE UNBUDGETED')",
		).run();
		const over = (await homeAt("2026-09")).html;
		expect(over).toContain(">$42</p>");
		expect(over).toContain("border-over text-over");

		await env.DB.prepare(
			"UPDATE transactions SET amount_cents = 8600 WHERE id = 90004",
		).run();
		const zero = (await homeAt("2026-09")).html;
		expect(zero).toContain(">$0</p>");
		expect(zero).toContain("border-ok text-ok");
	});

	it("returns to this month's Home for a future month and a month before history", async () => {
		const future = await homeAt("2099-01");
		expect(future.html).toContain("Safe to spend");
		expect(future.html).not.toContain("January ended");
		const before = await homeAt("1900-01");
		expect(before.html).toContain("Safe to spend");
		expect(before.html).not.toContain("January 1900 ended");
	});

	it("fades the unavailable arrows on this month and the first month with transactions", async () => {
		const currentMonth = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		const { html } = await homeAt(currentMonth);
		expect(html).not.toMatch(/aria-label="Next month,[^"]+"[^>]*href=/);
		const first = await firstCountedMonth(env.DB);
		if (first) {
			const earliest = await homeAt(first);
			expect(earliest.html).not.toMatch(
				/aria-label="Previous month,[^"]+"[^>]*href=/,
			);
		}
	});

	it("links every month dot to its own month and exposes the full accessible name", async () => {
		const currentMonth = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		const viewedMonth = monthsBefore(currentMonth, 1);
		const first = await firstCountedMonth(env.DB);
		if (!first) throw new Error("Demo has no counted transaction month");
		const { html } = await homeAt(viewedMonth);
		const nav = html.match(
			/<nav aria-label="Months"[^>]*>([\s\S]*?)<\/nav>/,
		)?.[1];
		if (!nav) throw new Error("Home has no month strip");
		expect(nav).toContain('<ol class="flex flex-wrap">');
		const links = [
			...nav.matchAll(
				/<a href="\/\?month=(\d{4}-\d{2})"([^>]*)>([\s\S]*?)<\/a>/g,
			),
		];
		const expected: string[] = [];
		for (
			let date = new Date(`${first}-01T00:00:00Z`);
			date <= new Date(`${currentMonth}-01T00:00:00Z`);
			date.setUTCMonth(date.getUTCMonth() + 1)
		) {
			expected.push(
				`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`,
			);
		}
		expect(links.map((link) => link[1])).toEqual(expected);
		for (const link of links) {
			const [, target, attributes, body] = link;
			const monthName = new Date(`${target}-01T00:00:00Z`).toLocaleString(
				"en-US",
				{ month: "long", timeZone: "UTC" },
			);
			expect(body).toContain(`<span class="sr-only">${monthName}`);
			expect(attributes).toContain(
				'class="flex min-h-11 w-11 flex-col items-center gap-0.5 text-sm',
			);
			expect(body).toContain("size-8 rounded-full");
		}
		const selected = links.find((link) => link[1] === viewedMonth);
		expect(selected?.[2]).toContain('aria-current="page"');
		expect(selected?.[3]).toContain("bg-ink");
		const current = links.find((link) => link[1] === currentMonth);
		expect(current?.[3]).toContain(
			"ring-2 ring-accent ring-offset-2 ring-offset-paper",
		);
		expect(current?.[3]).toContain("bg-muted/45");
		expect(current?.[3]).toContain(", this month");
	});

	it("renders an HTML page titled Tally", async () => {
		const { res, html } = await home();
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(html).toContain("<title>Tally</title>");
		expect(html).toContain('<html lang="en">');
	});

	it("leads with safe to spend and the status sentence", async () => {
		const { html } = await home();
		expect(html).toContain("Safe to spend");
		expect(html).toMatch(/Safe to spend<\/p><p[^>]*>\$[\d,]+/);
		expect(html).toContain(
			"Eating Out is $36 over. Everything else is on track.",
		);
	});

	it("links the uncategorized count to the filtered list", async () => {
		const { html } = await home();
		expect(html).toContain('href="/transactions?uncategorized=1"');
		expect(html).toMatch(/12 transactions need\s+a\s+category/);
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
					.match(/Safe to spend<\/p><p[^>]*>\$([\d,]+)/)?.[1]
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
			/12 transactions need a category<\/span><span[^>]*>\$228 of this month&#39;s spending/,
		);
		expect(html).not.toContain("Uncategorized");
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
		expect(at("Safe to spend")).toBeLessThan(at("12 transactions need"));
		expect(at("12 transactions need")).toBeLessThan(at(">Budget<"));
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

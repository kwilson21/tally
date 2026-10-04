import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { todayUtc } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

async function home() {
	const res = await exports.default.fetch("http://tally.test/");
	return { res, html: await res.text() };
}

describe("GET / with the demo seed", () => {
	beforeEach(async () => {
		await resetDemo(env.DB, todayUtc());
	});

	it("renders an HTML page titled Tally", async () => {
		const { res, html } = await home();
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(html).toContain("<title>Tally</title>");
		expect(html).toContain('<html lang="en">');
	});

	it("leads with budget remaining and the status sentence", async () => {
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
		// The demo's only unpaid active due/overdue bills are $142 + $65.
		expect(withoutBills - withBills).toBe(207);
	});

	it("shows spent of budget per category, and marks over budget with a word", async () => {
		const { html } = await home();
		expect(html).toMatch(/\$412\s+of\s+\$700/);
		expect(html).toMatch(/\$286\s+of\s+\$250/);
		// Eating Out is $36 over; its words say by how much (decision 46).
		expect(
			html.match(/ over<span class="sr-only"> budget<\/span>/g)?.length,
		).toBe(1);
		expect(html).toContain("$36 over");
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
			.bind(`${todayUtc().slice(0, 7)}%`)
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
			.bind(`${todayUtc().slice(0, 7)}%`)
			.run();
		expect((await home()).html).toContain("$0.30 more refunded than spent");
	});

	it("puts the number first: the month, budget remaining, the Band, Budget, then Things to try (#92)", async () => {
		const { html } = await home();
		const at = (s: string) => html.indexOf(s);
		expect(html).toMatch(/<h1 class="font-serif text-2xl[^"]*">/);
		expect(at("Budget remaining this month")).toBeLessThan(
			at("12 transactions need"),
		);
		expect(at("12 transactions need")).toBeLessThan(at(">Budget<"));
		expect(at(">Budget<")).toBeLessThan(at("New here? Things to try"));
	});

	it("gives the top and the Budget list one width on desktop (H6)", async () => {
		const { html } = await home();
		const column = html.indexOf('<div class="lg:max-w-2xl">');
		expect(column).toBeGreaterThan(-1);
		expect(column).toBeLessThan(html.indexOf("Budget remaining this month"));
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

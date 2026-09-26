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

	it("leads with safe to spend and the status sentence", async () => {
		const { html } = await home();
		expect(html).toContain("Safe to spend");
		expect(html).toContain("$283");
		expect(html).toContain(
			"Eating Out is $36 over. Everything else is on track.",
		);
	});

	it("links the uncategorized count to the filtered list", async () => {
		const { html } = await home();
		expect(html).toContain('href="/transactions?uncategorized=1"');
		expect(html).toMatch(/12 transactions need\s+a\s+category/);
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
		expect(html).toContain("Uncategorized");
		expect(html).toContain("$228");
	});
});

describe("GET / with no data", () => {
	beforeEach(async () => {
		await env.DB.batch([
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

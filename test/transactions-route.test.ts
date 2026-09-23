import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { todayUtc } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

async function get(path: string, headers: Record<string, string> = {}) {
	const res = await exports.default.fetch(`http://tally.test${path}`, {
		headers,
	});
	return { res, html: await res.text() };
}

const rowCount = (html: string) =>
	(html.match(/<li data-transaction=/g) ?? []).length;

beforeEach(async () => {
	await resetDemo(env.DB, todayUtc());
});

describe("GET /transactions", () => {
	it("renders the list with labeled search, filters, and day groups", async () => {
		const { res, html } = await get("/transactions");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Transactions · Tally</title>");
		expect(html).toMatch(
			/<label[^>]*for="q"[^>]*>Search transactions<\/label>/,
		);
		expect(html).toMatch(/<label[^>]*for="month"/);
		expect(html).toMatch(/<label[^>]*for="category"/);
		expect(html).toMatch(
			/Needs category \(<span id="needs-count">12<\/span>\)/,
		);
		expect(html).toMatch(/Excluded/);
		// Day headings ("Today, Sep 22" or "Sep 21"); which day is newest depends on the seed and today.
		expect(html).toMatch(/<h2[^>]*>(Today, )?[A-Z][a-z]{2} \d{1,2}<\/h2>/);
		expect(rowCount(html)).toBe(35);
	});

	it("filters to what needs a category, with the chip checked", async () => {
		const { html } = await get("/transactions?uncategorized=1");
		expect(rowCount(html)).toBe(12);
		expect(html).toMatch(
			/<input[^>]*name="uncategorized"[^>]*value="1"[^>]*checked/,
		);
	});

	it("filters to excluded only, escaping names", async () => {
		const { html } = await get("/transactions?excluded=1");
		expect(rowCount(html)).toBe(2);
		expect(html).toContain("Transfer to Savings");
		expect(html).toContain("Reimbursement, doctor&#39;s office");
	});

	it("shows an empty state with a way back", async () => {
		const { html } = await get("/transactions?q=zzz");
		expect(html).toContain("No transactions match.");
		expect(html).toMatch(
			/<a[^>]*href="\/transactions"[^>]*>Clear filters<\/a>/,
		);
	});

	it("shows the result count in a stable live region that htmx updates in place", async () => {
		const { html } = await get("/transactions?uncategorized=1");
		expect(html).toMatch(
			/<p id="result-count" aria-live="polite"[^>]*>12 transactions<\/p>/,
		);
		expect(html).toContain(
			'hx-select-oob="#needs-count:innerHTML, #result-count:innerHTML"',
		);
	});

	it("doesn't link rows to the edit panel until it exists (#11)", async () => {
		const { html } = await get("/transactions");
		expect(html).not.toMatch(/href="\/transactions\/\d+/);
	});

	it("keeps an active month with no transactions selected", async () => {
		const { html } = await get("/transactions?month=2020-01");
		expect(html).toMatch(
			/<option value="2020-01" selected[^>]*>January 2020<\/option>/,
		);
		expect(html).toContain("No transactions match.");
	});

	it("is where Home's band link lands", async () => {
		const home = (await get("/")).html;
		const href = home.match(/href="(\/transactions\?[^"]+)"/)?.[1];
		expect(href).toBe("/transactions?uncategorized=1");
		expect(rowCount((await get(href as string)).html)).toBe(12);
	});
});

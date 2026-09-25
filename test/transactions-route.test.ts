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
		expect(rowCount(html)).toBe(25);
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
			/<p id="result-count" aria-live="polite"[^>]*>12 transactions needing a category in [A-Z][a-z]+<\/p>/,
		);
		expect(html).toContain(
			'hx-select-oob="#needs-count:innerHTML, #result-count:innerHTML"',
		);
	});

	it("names the filters in the count, so two filters with the same count still read differently (#56)", async () => {
		// Every earlier month has three transactions in each category.
		const [y, m] = todayUtc().slice(0, 7).split("-").map(Number) as [
			number,
			number,
		];
		const last =
			m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
		const countText = (html: string) =>
			html.match(/<p id="result-count"[^>]*>([^<]+)<\/p>/)?.[1];
		const a = countText(
			(await get(`/transactions?month=${last}&category=1`)).html,
		);
		const b = countText(
			(await get(`/transactions?month=${last}&category=3`)).html,
		);
		expect(a).toMatch(/^3 transactions in Groceries, /);
		expect(b).toMatch(/^3 transactions in Gas, /);
	});

	it("lets the newest filter or page request win (htmx replace sync)", async () => {
		const html = (await get("/transactions")).html;
		expect(html).toMatch(/<form id="filters"[^>]*hx-sync="replace"/);
		expect(html).toMatch(/<a[^>]*rel="next"[^>]*hx-sync="#filters:replace"/);
	});

	it("shows a visible Apply filters button only when JavaScript is off", async () => {
		const html = (await get("/transactions")).html;
		expect(html).toMatch(
			/<noscript><button type="submit"[^>]*>Apply filters<\/button><\/noscript>/,
		);
		expect(html).not.toMatch(/sr-only[^"]*"[^>]*>Apply filters/);
	});

	it("pages through results with real links, 25 at a time", async () => {
		const first = (await get("/transactions")).html;
		expect(first).toMatch(
			/<p id="result-count"[^>]*>Showing 1–25 of 35 transactions in [A-Z][a-z]+<\/p>/,
		);
		expect(first).toMatch(/<nav aria-label="Pages"/);
		expect(first).toContain("Page 1 of 2");
		expect(first).toMatch(
			/<a[^>]*href="\/transactions\?page=2"[^>]*rel="next"[^>]*>Older<\/a>/,
		);
		expect(first).not.toContain(">Newer<");

		const second = (await get("/transactions?page=2")).html;
		expect(rowCount(second)).toBe(10);
		expect(second).toMatch(/Showing 26–35 of 35 transactions/);
		expect(second).toMatch(
			/<a[^>]*href="\/transactions"[^>]*rel="prev"[^>]*>Newer<\/a>/,
		);
		expect(second).not.toContain(">Older<");
	});

	it("keeps the filters in page links and hides the pager on a single page", async () => {
		// All months: 90 history rows + 35 this month = 125, so 5 pages.
		const html = (await get("/transactions?month=all")).html;
		expect(html).toContain("Page 1 of 5");
		expect(html).toMatch(/href="\/transactions\?month=all&amp;page=2"/);
		expect((await get("/transactions?uncategorized=1")).html).not.toContain(
			'aria-label="Pages"',
		);
	});

	it("returns focus to a row after the edit panel is cancelled", async () => {
		const { html } = await get("/transactions?focus=110");
		expect(html).toMatch(/<a href="\/transactions\/110"[^>]*autofocus/);
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

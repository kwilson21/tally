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
	(html.match(/href="\/transactions\/\d+/g) ?? []).length;

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

	it("announces the result count to htmx requests", async () => {
		const { res } = await get("/transactions?uncategorized=1", {
			"HX-Request": "true",
		});
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toEqual({
			announce: "12 transactions",
		});
	});

	it("is where Home's band link lands", async () => {
		const home = (await get("/")).html;
		const href = home.match(/href="(\/transactions\?[^"]+)"/)?.[1];
		expect(href).toBe("/transactions?uncategorized=1");
		expect(rowCount((await get(href as string)).html)).toBe(12);
	});
});

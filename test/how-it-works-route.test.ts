import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import spec from "../docs/superpowers/specs/2026-09-22-tally-design.md?raw";
import { todayUtc } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { formatCents } from "../src/money";
import { destinations } from "../src/routes/destinations";
import { home } from "../src/routes/home";
import { howItWorks } from "../src/routes/how-it-works";
import { transactions } from "../src/routes/transactions";

const BASE = "http://tally.test";
const get = async (path: string) => {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
};
/** Undoes the HTML escaping Hono applies to text, for comparing with plain strings. */
const decodeHtml = (html: string) =>
	html
		.replaceAll("&#39;", "'")
		.replaceAll("&quot;", '"')
		.replaceAll("&amp;", "&");
const notDemo = { ...env, DEMO: "false" } as unknown as Env;

beforeEach(async () => {
	await resetDemo(env.DB, todayUtc());
});

describe("GET /how-it-works in the demo", () => {
	it("has the architecture and the Phase 1 feature sections", async () => {
		const { res, html } = await get("/how-it-works");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>How Tally works · Tally</title>");
		expect(html).toMatch(/<h1[^>]*>How Tally works<\/h1>/);
		for (const id of [
			"architecture",
			"budget",
			"transactions",
			"exclusions",
			"categorization",
		]) {
			expect(html).toMatch(new RegExp(`<section[^>]*id="${id}"`));
		}
		expect(html).toContain('role="img"');
		expect(html).toContain("Income counts only toward Income, not spending.");
		expect(html).toContain("Bills that are due or overdue are also set aside");
		expect(html).toMatch(/including uncategorized and\s+unbudgeted/);
		expect(html).not.toMatch(/small AI/);
	});

	it("works its budget example from the same numbers Home shows", async () => {
		const page = (await get("/how-it-works")).html;
		const match = page.match(/= (-?\$[\d,]+\.\d\d) safe to spend\./);
		expect(match).not.toBeNull();
		const cents = Math.round(
			Number((match?.[1] ?? "").replace(/[$,]/g, "")) * 100,
		);
		const homeHtml = (await get("/")).html;
		expect(homeHtml).toContain(formatCents(cents, { wholeDollars: true }));
	});

	it("explains exclusions with this month's excluded count", async () => {
		const { html } = await get("/how-it-works");
		expect(decodeHtml(html)).toMatch(
			/This month, \d+ transactions? (is|are) excluded, so (it doesn't|they don't) count toward spending or safe to spend\./,
		);
	});

	it("counts this month's transactions and who categorized them", async () => {
		const { html } = await get("/how-it-works");
		expect(html).toMatch(/counted transactions, and 12 need a category\./);
		expect(html).toMatch(/Jev categorized \d+ transactions\./);
		expect(decodeHtml(html)).toContain("12 are waiting for tonight's run.");
		expect(html).toContain("80%");
	});
});

describe("outside the demo", () => {
	it("has no How Tally works page", async () => {
		const res = await howItWorks.request("/how-it-works", {}, notDemo);
		expect(res.status).toBe(404);
	});

	it("shows no Things to try and no How this works link on Home", async () => {
		const html = await (await home.request("/", {}, notDemo)).text();
		expect(html).not.toContain("Things to try");
		expect(html).not.toContain("/how-it-works");
	});

	it("leaves How Tally works off the More page", async () => {
		const html = await (
			await destinations.request("/more", {}, notDemo)
		).text();
		expect(html).not.toContain("/how-it-works");
	});

	it("shows no How this works link on Transactions or the edit sheet", async () => {
		for (const path of ["/transactions", "/transactions/110"]) {
			const html = await (await transactions.request(path, {}, notDemo)).text();
			expect(html).not.toContain("/how-it-works");
		}
	});
});

describe("links in the demo", () => {
	it("Home has Things to try and a link to the budget section", async () => {
		const { html } = await get("/");
		// The page's first heading is its h1; the block's title isn't a heading.
		expect(html.match(/<h[1-6]\b/)?.[0]).toBe("<h1");
		expect(html).toContain("New here? Things to try");
		expect(html).toContain('href="/how-it-works#budget"');
		// Things to try comes before the month, as in the study.
		expect(html.indexOf("Things to try")).toBeLessThan(html.indexOf("<h1"));
	});

	it("Transactions links to its section, and the edit sheet to categorization", async () => {
		expect((await get("/transactions")).html).toContain(
			'href="/how-it-works#transactions"',
		);
		const sheet = (await get("/transactions/110")).html;
		expect(sheet).toContain('href="/how-it-works#categorization"');
		// Under the sheet's title, outside the form, so a tap there never leaves unsaved edits.
		const link = sheet.indexOf('href="/how-it-works#categorization"');
		expect(link).toBeGreaterThan(sheet.indexOf('id="edit-title"'));
		expect(link).toBeLessThan(
			sheet.indexOf("<form", sheet.indexOf('id="edit-title"')),
		);
	});

	it("More lists How Tally works", async () => {
		expect((await get("/more")).html).toMatch(
			/<a href="\/how-it-works"[^>]*>How Tally works<\/a>/,
		);
	});
});

describe("the parts table", () => {
	it("quotes spec §4 word for word, row by row", async () => {
		const section = spec.slice(
			spec.indexOf("## 4. Architecture"),
			spec.indexOf("### 4.1"),
		);
		const rows = [...section.matchAll(/^\| \*\*(.+?)\*\* \| (.+) \|$/gm)].map(
			([, part = "", job = ""]) => [
				part.replaceAll("`", ""),
				job.replaceAll("`", ""),
			],
		);
		expect(rows.length).toBeGreaterThan(10);
		const { html } = await get("/how-it-works");
		const page = [
			...html.matchAll(/<dt[^>]*>([^<]+)<\/dt><dd[^>]*>([^<]+)<\/dd>/g),
		].map(([, part = "", job = ""]) => [decodeHtml(part), decodeHtml(job)]);
		expect(page).toEqual(rows);
	});
});

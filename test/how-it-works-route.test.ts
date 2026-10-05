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
		expect(html).toContain("due and overdue");
		expect(html).toMatch(/including uncategorized and\s+unbudgeted/);
		expect(html).not.toMatch(/small AI/);
	});

	it("keeps its budget example equal to Home", async () => {
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
			/This month, \d+ transactions? (is|are) excluded \([^)]+\), so (it doesn't|they don't) count toward spending or safe to spend\./,
		);
	});

	it("draws each section's diagram from the same numbers as its worked example", async () => {
		const page = decodeHtml((await get("/how-it-works")).html);
		const descOf = (id: string) =>
			page.match(new RegExp(`<desc id="${id}-desc">([^<]+)<`))?.[1] ?? "";
		const example = (re: RegExp) => page.match(re)?.slice(1) ?? [];

		const [safe] = example(/= (-?\$[\d,]+\.\d\d) safe to spend\./);
		expect(descOf("budget-diagram")).toContain(`leaves ${safe} safe to spend.`);

		const [counted, needs] = example(
			/has (\d+) counted transactions, and (\d+) need a category\./,
		);
		expect(descOf("transactions-diagram")).toContain(`so ${counted} count.`);
		expect(descOf("transactions-diagram")).toContain(
			`${needs} of those need a category.`,
		);

		const [excluded, kinds] = example(
			/This month, (\d+) transactions are excluded \(([^)]+)\)/,
		);
		expect(descOf("exclusions-diagram")).toContain(
			`${counted} count toward the budget and ${excluded} are excluded: ${kinds}.`,
		);

		const [jev] = example(/Jev categorized (\d+) transactions\./);
		expect(descOf("categories-diagram")).toContain(
			`Jev ${jev}, and ${needs} wait`,
		);
		const [income] = example(/(\d+) are income, which needs no category\./);
		expect(descOf("categories-diagram")).toContain(
			`${income} are income, which needs no category.`,
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
	it("has How Tally works with household numbers and no architecture", async () => {
		const res = await howItWorks.request("/how-it-works", {}, notDemo);
		const html = await res.text();
		expect(res.status).toBe(200);
		const monthName = new Intl.DateTimeFormat("en-US", {
			month: "long",
			timeZone: "UTC",
		}).format(new Date(`${todayUtc().slice(0, 7)}-01T00:00:00Z`));
		expect(html).toContain(`With your numbers for ${monthName}:`);
		expect(html).not.toContain("In the demo:");
		expect(html).not.toContain("Jev");
		expect(html).not.toContain('id="architecture"');
		expect(html).not.toContain("system-diagram");
		expect(html).not.toContain("Cloudflare Worker (Hono, TypeScript)");
	});

	it("uses a plain sentence instead of transaction examples when the month is empty", async () => {
		const month = todayUtc().slice(0, 7);
		await env.DB.prepare(
			"DELETE FROM transactions WHERE substr(date, 1, 7) = ?",
		)
			.bind(month)
			.run();
		const html = await (
			await howItWorks.request("/how-it-works", {}, notDemo)
		).text();
		expect(
			html.match(
				/(?:There are no transactions this month yet|No bill has been paid yet this month)\./g,
			),
		).toHaveLength(4);
		expect(html).not.toContain("With your numbers: This month has");
		expect(html).not.toContain('id="transactions-diagram-title"');
		expect(html).not.toContain('id="exclusions-diagram-title"');
		expect(html).not.toContain('id="categories-diagram-title"');
	});

	it("uses the household's own paid bill for the Bills example", async () => {
		await env.DB.prepare("UPDATE bills SET name = 'Electricity'").run();
		const html = await (
			await howItWorks.request("/how-it-works", {}, notDemo)
		).text();
		expect(html).toMatch(/With your numbers for [A-Z][a-z]+:/);
		expect(html).toContain("Electricity is");
		expect(html).toContain('id="bills-diagram-title"');
		expect(html).not.toContain("No bill has been paid yet this month.");
	});

	it("uses a plain sentence and no diagram when no bill has been paid", async () => {
		await env.DB.prepare("DELETE FROM bill_payments").run();
		const html = await (
			await howItWorks.request("/how-it-works", {}, notDemo)
		).text();
		expect(html).toContain("No bill has been paid yet this month.");
		expect(html).not.toContain('id="bills-diagram-title"');
	});

	it("uses a plain sentence and no diagram when no budgets are set", async () => {
		await env.DB.prepare("DELETE FROM budget_amounts").run();
		const html = await (
			await howItWorks.request("/how-it-works", {}, notDemo)
		).text();
		expect(html).toContain("No budgets have been set yet.");
		expect(html).not.toContain('id="budget-diagram-title"');
	});

	it("shows no Things to try but does show How this works on Home", async () => {
		const html = await (await home.request("/", {}, notDemo)).text();
		expect(html).not.toContain("Things to try");
		expect(html).toContain('href="/how-it-works#budget"');
	});

	it("lists How Tally works on the More page", async () => {
		const html = await (
			await destinations.request("/more", {}, notDemo)
		).text();
		expect(html).toContain('href="/how-it-works"');
	});

	it("shows How this works on Transactions and the edit sheet", async () => {
		for (const path of ["/transactions", "/transactions/110"]) {
			const html = await (await transactions.request(path, {}, notDemo)).text();
			expect(html).toContain("/how-it-works");
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
		// Things to try comes after the Budget list, so safe to spend leads (#92, decision 46).
		expect(html.indexOf("Things to try")).toBeGreaterThan(
			html.indexOf('id="budget-title"'),
		);
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

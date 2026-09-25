import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
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
			"categorization",
		]) {
			expect(html).toMatch(new RegExp(`<section[^>]*id="${id}"`));
		}
		expect(html).toContain('role="img"');
		// The parts table quotes spec §4.
		expect(html).toContain("Stores all data.");
		expect(html).toContain(
			"Picks a category and flags for each transaction, with a confidence score.",
		);
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

	it("counts this month's transactions and who categorized them", async () => {
		const { html } = await get("/how-it-works");
		expect(html).toMatch(/counted transactions, and 12 need a category\./);
		expect(html).toMatch(/Jev picked \d+ categories on its own\./);
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
		expect(html).toContain("New here? Things to try");
		expect(html).toContain('href="/how-it-works#budget"');
		// Things to try comes before the month, as in the study.
		expect(html.indexOf("Things to try")).toBeLessThan(html.indexOf("<h1"));
	});

	it("Transactions links to its section, and the edit sheet to categorization", async () => {
		expect((await get("/transactions")).html).toContain(
			'href="/how-it-works#transactions"',
		);
		expect((await get("/transactions/110")).html).toContain(
			'href="/how-it-works#categorization"',
		);
	});

	it("More lists How Tally works", async () => {
		expect((await get("/more")).html).toMatch(
			/<a href="\/how-it-works"[^>]*>How Tally works<\/a>/,
		);
	});
});

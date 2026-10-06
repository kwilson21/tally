import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import spec from "../docs/superpowers/specs/2026-09-22-tally-design.md?raw";
import { DEFAULT_TIME_ZONE, monthsBefore, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { formatCents } from "../src/money";
import { accounts } from "../src/routes/accounts";
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
const monthName = () =>
	new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(
		new Date(`${todayIn(DEFAULT_TIME_ZONE).slice(0, 7)}-01T00:00:00Z`),
	);

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
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

	it('explains Store names, where the Why? after "Tally\'s guess" lands, without naming the AI', async () => {
		const { html } = await get("/how-it-works");
		expect(decodeHtml(html)).not.toMatch(/merchant names later/i);
		expect(decodeHtml(html)).toContain(
			"AI helps with names and categories: Jev picks categories today, and Workers AI suggests merchant names today.",
		);
		const names =
			html.match(/<section[^>]*id="names"[\s\S]*?<\/section>/)?.[0] ?? "";
		expect(decodeHtml(names)).toContain("sparkles icon and a dashed underline");
		expect(decodeHtml(names)).toContain(
			"nothing is renamed until you choose it",
		);
		expect(decodeHtml(names)).toContain("Suggest store names");
		expect(decodeHtml(names)).toContain('says "From your bank"');
		expect(decodeHtml(names)).toContain("the bank's own names still show");
		expect(names).not.toMatch(/jev|workers ai/i);
		expect(decodeHtml(names)).toMatch(
			/In the demo, <\/span>(?:No merchant names are waiting for a choice|\d+ merchant names? (?:are|is) waiting for a choice)\./,
		);
	});

	it("counts older pending merchant names without assigning them to this month", async () => {
		await env.DB.prepare(
			"DELETE FROM merchants WHERE suggestion_status = 'pending'",
		).run();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('OLD SHOP 123', 'Old Shop', 'pending')",
		).run();
		await env.DB.prepare(
			"INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name) VALUES ('old-shop-review', 1, '2025-01-10', 650, 'OLD SHOP 123')",
		).run();

		const demo = decodeHtml((await get("/how-it-works")).html);
		const family = decodeHtml(
			await (await howItWorks.request("/how-it-works", {}, notDemo)).text(),
		);
		const names = (html: string) =>
			html.match(/<section[^>]*id="names"[\s\S]*?<\/section>/)?.[0] ?? "";
		expect(names(demo)).toContain(
			"In the demo, </span>1 merchant name is waiting for a choice.",
		);
		expect(names(family)).toContain(
			"With your numbers, </span>1 merchant name is waiting for a choice.",
		);
		expect(names(demo)).not.toMatch(/for \w+:/);
		expect(names(family)).not.toMatch(/for \w+:/);
	});

	it("explains suggested categories in the Categories section", async () => {
		const { html } = await get("/how-it-works");
		const categories =
			html.match(/<section[^>]*id="categorization"[\s\S]*?<\/section>/)?.[0] ??
			"";
		expect(categories).toContain("suggested category");
		expect(categories).toContain("nothing is created until a person says so");
		expect(html).not.toContain('href="/how-it-works#categorization"');
	});

	it("explains Trends: its rules, and an example from the demo's own numbers", async () => {
		const { html } = await get("/how-it-works");
		const trends =
			html.match(/<section[^>]*id="trends"[\s\S]*?<\/section>/)?.[0] ?? "";
		expect(trends).toContain("Trends compares this month with last month");
		expect(trends).toContain("under budget 3 or more months running");
		expect(trends).toContain("up 3 or more months running");
		expect(trends).toMatch(/\(\w{3} 1(–\d+)? against \w{3} 1(–\d+)?\)/);
		expect(trends).toContain("not AI");
		expect(decodeHtml(trends)).toMatch(
			/In the demo for \w+: <\/span>Groceries stayed under its budget in May, June, July, August and September, so it's going well\./,
		);
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

	it("points to the Show choice, not an Excluded filter, for finding excluded transactions (#210)", async () => {
		const html = decodeHtml((await get("/how-it-works")).html);
		expect(html).toContain(
			"Choose Excluded in the Show choice on Transactions to see only the excluded ones.",
		);
		expect(html).not.toContain("The Excluded filter");
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
		expect(descOf("transactions-diagram")).toContain(`${counted} counted`);
		expect(descOf("transactions-diagram")).toContain(
			`${needs} of those need a category.`,
		);

		const [excluded, kinds] = example(
			/This month, (\d+) transactions are excluded \(([^)]+)\)/,
		);
		expect(descOf("exclusions-diagram")).toContain(
			`${counted} counted, 0 held for review, and ${excluded} excluded (${kinds}).`,
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
	it("says both AI jobs are live and gives a household example when no names wait", async () => {
		await env.DB.prepare(
			"DELETE FROM merchants WHERE suggestion_status = 'pending'",
		).run();
		const html = decodeHtml(
			await (await howItWorks.request("/how-it-works", {}, notDemo)).text(),
		);
		expect(html).toContain(
			"AI helps with categories and store names, and a person can always change them.",
		);
		const names =
			html.match(/<section[^>]*id="names"[\s\S]*?<\/section>/)?.[0] ?? "";
		expect(names).toContain("With your numbers,");
		expect(names).toContain("No merchant names are waiting for a choice.");
		expect(names).not.toMatch(/jev|workers ai/i);
	});

	it("has How Tally works with household numbers and no architecture", async () => {
		const res = await howItWorks.request("/how-it-works", {}, notDemo);
		const html = await res.text();
		expect(res.status).toBe(200);
		expect(html).toContain(`With your numbers for ${monthName()}:`);
		expect(html).not.toContain("In the demo");
		expect(html).not.toContain('id="architecture"');
		expect(html).not.toContain("system-diagram");
		expect(html).not.toContain("Cloudflare Worker (Hono, TypeScript)");
	});

	it("gives Trends the household's own numbers, or a plain sentence before there's a month to compare", async () => {
		const own = await (
			await howItWorks.request("/how-it-works", {}, notDemo)
		).text();
		const section = (html: string) =>
			html.match(/<section[^>]*id="trends"[\s\S]*?<\/section>/)?.[0] ?? "";
		expect(section(own)).toMatch(/With your numbers for \w+: /);
		expect(decodeHtml(section(own))).toContain("so it's going well.");

		// With history that starts last month there is nothing to compare yet.
		const last = monthsBefore(todayIn(DEFAULT_TIME_ZONE).slice(0, 7), 1);
		await env.DB.prepare("DELETE FROM transactions WHERE date < ?")
			.bind(`${last}-02`)
			.run();
		const early = await (
			await howItWorks.request("/how-it-works", {}, notDemo)
		).text();
		expect(section(early)).toContain(
			"Trends fill in as months pass, so there is nothing to compare yet.",
		);
		expect(section(early)).not.toContain("With your numbers");
	});

	it("uses a plain sentence instead of transaction examples when the month is empty", async () => {
		const month = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
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
		expect(html).not.toContain("This month has");
		expect(html).not.toContain('id="transactions-diagram-title"');
		expect(html).not.toContain('id="exclusions-diagram-title"');
		expect(html).not.toContain('id="categories-diagram-title"');
	});

	it("uses the household's own paid bill for the Bills example", async () => {
		await env.DB.prepare("UPDATE bills SET name = 'Electricity'").run();
		const html = await (
			await howItWorks.request("/how-it-works", {}, notDemo)
		).text();
		expect(html).toContain(`With your numbers for ${monthName()}:`);
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

	it("uses a plain sentence and no diagram when no budgets, spending or bills are set", async () => {
		await env.DB.prepare("DELETE FROM budget_amounts").run();
		await env.DB.prepare("DELETE FROM transactions").run();
		await env.DB.prepare("UPDATE bills SET active = 0").run();
		const html = await (
			await howItWorks.request("/how-it-works", {}, notDemo)
		).text();
		expect(html).toContain("No budgets have been set yet.");
		expect(html).not.toContain('id="budget-diagram-title"');
	});

	it("never names Jev (decision 64)", async () => {
		const html = await (
			await howItWorks.request("/how-it-works", {}, notDemo)
		).text();
		expect(html).not.toMatch(/jev/i);
		expect(decodeHtml(html)).toContain("Tally, if 80% or more sure");
	});

	it("shows the calculation when there's spending but no budget", async () => {
		await env.DB.prepare("DELETE FROM budget_amounts").run();
		const html = await (
			await howItWorks.request("/how-it-works", {}, notDemo)
		).text();
		expect(html).toContain("No budgets have been set yet.");
		expect(html).toContain('id="budget-diagram-title"');
		expect(html).toMatch(/safe to spend\./);
	});

	it("keeps the transaction examples when this month's only transaction counts in an earlier month", async () => {
		const month = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		const { results } = await env.DB.prepare(
			"SELECT id FROM transactions WHERE substr(date, 1, 7) = ? ORDER BY id",
		)
			.bind(month)
			.all<{ id: number }>();
		const keep = results[0]?.id;
		expect(keep).toBeDefined();
		await env.DB.prepare(
			"DELETE FROM transactions WHERE substr(date, 1, 7) = ? AND id != ?",
		)
			.bind(month, keep)
			.run();
		// It refunds a purchase from an earlier month, so it counts there instead.
		const earlier = await env.DB.prepare(
			"SELECT id FROM transactions WHERE substr(date, 1, 7) < ? AND excluded = 0 AND is_split = 0 ORDER BY date DESC LIMIT 1",
		)
			.bind(month)
			.first<{ id: number }>();
		await env.DB.prepare(
			"UPDATE transactions SET refund_of_id = ?, excluded = 0, is_split = 0, amount_cents = -500 WHERE id = ?",
		)
			.bind(earlier?.id, keep)
			.run();
		const html = await (
			await howItWorks.request("/how-it-works", {}, notDemo)
		).text();
		expect(html).toContain('id="transactions-diagram-title"');
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

	it("explains where merchant rules can be reviewed and removed", async () => {
		const html = (await get("/how-it-works")).html;
		const categorization =
			html.match(/<section[^>]*id="categorization"[\s\S]*?<\/section>/)?.[0] ??
			"";
		expect(categorization).toContain(
			"See every rule in Settings under Tally&#39;s rules.",
		);
		expect(categorization).toContain(
			"Removing a rule doesn&#39;t change transactions it already sorted.",
		);
	});
});

describe("the Net worth section (spec §9, feature 7; decision 65)", () => {
	/** The Net worth section's markup, or "" if the page has none. */
	const sectionOf = (html: string) =>
		html.split('id="net-worth"')[1]?.split("</section>")[0] ?? "";
	const family = async () =>
		(await howItWorks.request("/how-it-works", {}, notDemo)).text();

	it("is a section in the demo and the family app, with its rules in words", async () => {
		for (const html of [(await get("/how-it-works")).html, await family()]) {
			expect(html).toMatch(/<section[^>]*id="net-worth"/);
			const text = decodeHtml(sectionOf(html));
			expect(text).toMatch(/<h2[^>]*>Net worth<\/h2>/);
			// What counts: debt subtracts; Cash and disconnected banks are left out.
			expect(text).toContain("minus what you owe");
			expect(text).toMatch(/credit card and loan balances are subtracted/);
			expect(text).toContain("Cash account");
			expect(text).toContain("disconnected bank");
			// One balance a day, in the household's day.
			expect(text).toContain("one balance per account for that day");
			expect(text).toContain("time zone");
			// Why the line starts when every account has a balance.
			expect(text).toContain("first day every account has a balance");
			expect(text).toContain(
				"Until every account has a balance there is no line, only a note saying it is waiting.",
			);
			expect(text).toContain("another bank");
			// The sentence under the number is written by code.
			expect(text).toContain("Up $3,600 since May.");
		}
	});

	it("works its example from the household's own balances, equal to Accounts' headline", async () => {
		const { html } = await get("/how-it-works");
		const section = decodeHtml(sectionOf(html));
		expect(section).toContain(`In the demo for ${monthName()}: `);
		// $4,210.55 + $12,400.00 in accounts, $842.17 owed.
		expect(section).toContain(
			"$16,610.55 in accounts − $842.17 owed = $15,768.38 net worth.",
		);
		expect(decodeHtml((await get("/accounts")).html)).toContain("$15,768");
	});

	it("says 'With your numbers' outside the demo, and leaves a disconnected bank out of the example", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE institution_name = 'Northline Card Services'",
		).run();
		const section = decodeHtml(sectionOf(await family()));
		expect(section).toContain(`With your numbers for ${monthName()}: `);
		expect(section).toContain(
			"$16,610.55 in accounts and nothing owed, so net worth is $16,610.55.",
		);
	});

	it("uses one plain sentence, with no example, when there are no accounts to add up", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM balance_history"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
		]);
		const section = sectionOf(await family());
		expect(section).toContain("There are no accounts to add up yet.");
		expect(section).not.toContain("With your numbers");
		expect(section).not.toContain("in accounts");
	});

	it("never names Jev, in the demo or the family app", async () => {
		expect(sectionOf((await get("/how-it-works")).html)).not.toMatch(/jev/i);
		expect(sectionOf(await family())).not.toMatch(/jev/i);
	});

	it("is where Accounts' Why? link goes, in the demo and the family app", async () => {
		for (const [accountsHtml, howHtml] of [
			[(await get("/accounts")).html, (await get("/how-it-works")).html],
			[
				await (await accounts.request("/accounts", {}, notDemo)).text(),
				await family(),
			],
		] as const) {
			const href = accountsHtml.match(/href="(\/how-it-works#[^"]+)"/)?.[1];
			expect(href).toBe("/how-it-works#net-worth");
			// The anchor is a real section id on the page it points to.
			const id = (href ?? "").split("#")[1];
			expect(howHtml).toMatch(new RegExp(`<section[^>]*id="${id}"`));
		}
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

describe("the held-for-review rule (spec §6, decision 70)", () => {
	const sectionOf = (html: string, id: string) =>
		decodeHtml(
			html.match(
				new RegExp(`<section[^>]*id="${id}"[\\s\\S]*?</section>`),
			)?.[0] ?? "",
		).replace(/\s+/g, " ");
	const family = async () =>
		(await howItWorks.request("/how-it-works", {}, notDemo)).text();

	it("is stated in the spec, and the Transactions section says it in the spec's words", async () => {
		// Spec §6 says Spent, Uncategorized, and Safe to spend; the page says them as the person reads them.
		expect(spec).toContain(
			"is held out of Spent, Uncategorized, and Safe to spend until Jev confidently categorizes it as non-income or a person marks it reviewed as a refund or other non-income credit (decision 70)",
		);
		for (const html of [(await get("/how-it-works")).html, await family()]) {
			const text = sectionOf(html, "transactions");
			expect(text).toContain(
				"An unreviewed bank credit that isn't income is held out of spending, uncategorized, and safe to spend until Tally confidently categorizes it as non-income or a person marks it reviewed as a refund or other non-income credit.",
			);
			// So the first rule no longer says every non-excluded transaction counts.
			expect(text).toContain(
				"not a split parent (its parts count instead) or a credit held for review (below)",
			);
		}
	});

	it("is pointed to from Excluding, where the held slice is drawn, and never names Jev", async () => {
		for (const html of [(await get("/how-it-works")).html, await family()]) {
			expect(sectionOf(html, "exclusions")).toContain(
				"A credit held for review isn't excluded: it waits until Tally confidently sorts it as non-income or a person reviews it, and once a person marks it as income it counts toward Income instead, unless it's excluded too (see Transactions).",
			);
		}
		expect(sectionOf(await family(), "transactions")).not.toMatch(/jev/i);
	});
});

describe("new category suggestions in the Categories section (spec §7, #51)", () => {
	const sectionOf = (html: string) =>
		(
			html.split('id="categorization"')[1]?.split("</section>")[0] ?? ""
		).replace(/\s+/g, " ");
	const family = async () =>
		(await howItWorks.request("/how-it-works", {}, notDemo)).text();
	const NOTHING =
		"A suggested category is only an idea; nothing is created until a person says so.";

	it("explains the suggestion and says nothing is created until a person decides", async () => {
		for (const html of [(await get("/how-it-works")).html, await family()]) {
			const text = decodeHtml(sectionOf(html));
			expect(text).toContain(NOTHING);
		}
	});

	it("never names Jev in the family app", async () => {
		expect(sectionOf(await family())).not.toMatch(/jev/i);
	});
});

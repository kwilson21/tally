import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import spec from "../docs/superpowers/specs/2026-09-22-tally-design.md?raw";
import { DEFAULT_TIME_ZONE, monthsBefore, todayIn } from "../src/dates";
import { saveSplit } from "../src/db/transactions";
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
	it("lists the Cloudflare Workflows row after Cron Triggers, in the owner's words (decision 136)", async () => {
		const html = decodeHtml((await get("/how-it-works")).html);
		expect(html).toContain("Cloudflare Workflows");
		expect(html).toContain(
			"Sorts transactions with Jev in small steps and keeps each answer for a few days, so a step that has to run again doesn't ask twice.",
		);
		expect(html.indexOf("Cloudflare Workflows")).toBeGreaterThan(
			html.indexOf("Cron Triggers"),
		);
	});

	it("describes bill payments as one matched payment, with more linked by hand for a bill paid in parts", async () => {
		const html = decodeHtml((await get("/how-it-works")).html);
		expect(html).toContain("Tally matches each bill occurrence to one payment");
		expect(html).toContain("A bill paid in parts takes more");
		expect(html).not.toContain("at most one payment");
		expect(html).toContain("A payment can pay only one bill occurrence.");
		expect(html).not.toContain("one payment pays exactly one occurrence");
		expect(html).not.toContain("exactly one bill occurrence");
		expect(html).not.toContain("Each bill gets at most one payment per period");
	});

	it("states the possible-bill rule the finder applies: the latest charge repeats an earlier one 25–35 days before it, within 10%", async () => {
		const html = decodeHtml((await get("/how-it-works")).html);
		expect(html).toContain(
			"Tally suggests a possible bill when a merchant's latest money-out charge in the last 3 months repeats an earlier one 25–35 days before it, within 10% of that earlier charge's amount.",
		);
		expect(html).not.toContain("are 25–35 days apart");
	});

	it("names planned expenses in the budget section: its list, the diagram's Planned box and the worked example", async () => {
		const html = decodeHtml((await get("/how-it-works")).html);
		const budget =
			html.match(/<section[^>]*id="budget"[\s\S]*?<\/section>/)?.[0] ?? "";
		expect(budget).toContain(
			"A planned one-time expense is set aside for its whole month",
		);
		// The demo's two plans: Lawn service ($90, this month) and Car registration ($180, last month, unpaid).
		expect(budget).toContain("minus $270.00 for planned expenses");
		expect(budget).toContain("$270 is set aside for planned expenses");
	});

	it("gives a linked refund its exception in the spec's words, when its purchase is excluded", async () => {
		const html = decodeHtml((await get("/how-it-works")).html);
		expect(html).toContain(
			"A refund linked to its purchase counts in that purchase's month and category while the purchase counts; if the purchase is excluded, the refund counts on its own date and category.",
		);
	});

	it("says in the Bills section, right after the finding-bills rule, that card payments and moves are never suggested while they're left out of the budget", async () => {
		const sentence =
			"Card payments and moves between your own accounts are never suggested while they're left out of the budget: what you bought on the card already counts, and saving each month is what the savings goal on Home is for.";
		const demoHtml = decodeHtml((await get("/how-it-works")).html);
		const familyHtml = decodeHtml(
			await (await howItWorks.request("/how-it-works", {}, notDemo)).text(),
		);
		for (const html of [demoHtml, familyHtml]) {
			const bills =
				html.match(/<section[^>]*id="bills"[\s\S]*?<\/section>/)?.[0] ?? "";
			expect(bills).toContain(sentence);
			expect(bills).toMatch(
				/Tally suggests a possible bill[\s\S]*?<\/li>\s*<li>Card payments and moves between your own accounts are never suggested while they're left out of the budget:/,
			);
		}
	});

	it("says in the Bills section that a steady loan payment is suggested, and a payee already linked to a bill is not, until two monthly payments in a row go unlinked", async () => {
		const loan =
			"A steady loan payment, such as a car, mortgage or student loan that your bank marks as one, is suggested even while it's left out of the budget.";
		const linked =
			"A merchant whose payment is already linked to a bill isn't suggested until two monthly payments in a row are left unlinked.";
		const demoHtml = decodeHtml((await get("/how-it-works")).html);
		const familyHtml = decodeHtml(
			await (await howItWorks.request("/how-it-works", {}, notDemo)).text(),
		);
		for (const html of [demoHtml, familyHtml]) {
			const bills =
				html.match(/<section[^>]*id="bills"[\s\S]*?<\/section>/)?.[0] ?? "";
			expect(bills).toContain(loan);
			expect(bills).toContain(linked);
		}
	});

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
		expect(html).toContain("due or overdue and not yet paid");
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
		expect(decodeHtml(names)).toContain("in Settings under Suggestions");
		expect(decodeHtml(names)).not.toContain("Merchant names");
		expect(decodeHtml(names)).toMatch(
			/In the demo, <\/span>(?:No merchant names are waiting for a choice|\d+ merchant names? (?:are|is) waiting for a choice)\./,
		);
	});

	it("counts older pending merchant names without assigning them to this month", async () => {
		await env.DB.prepare(
			"DELETE FROM merchants WHERE suggestion_status = 'pending'",
		).run();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('OLD SHOP 123', 'Old Shop Market', 'pending')",
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

	it("explains the rule offer, and names no count of a store's categories", async () => {
		const { html } = await get("/how-it-works");
		const categories =
			html.match(/<section[^>]*id="categorization"[\s\S]*?<\/section>/)?.[0] ??
			"";
		expect(categories).toContain(
			"picks the same category for the same merchant three times",
		);
		expect(categories).toContain("Yes makes it the merchant");
		expect(categories).not.toContain("two or more categories");
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
		const match = page.match(
			/Your budgets have (\$[\d,]+(?:\.\d\d)?) left\. Safe to spend is (\$[\d,]+(?:\.\d\d)?) less:/,
		);
		expect(match).not.toBeNull();
		const cents = (value: string) =>
			Math.round(Number(value.replace(/[$,]/g, "")) * 100);
		const safeCents = cents(match?.[1] ?? "$0") - cents(match?.[2] ?? "$0");
		const homeHtml = (await get("/")).html;
		const shown = homeHtml.match(
			/class="font-serif text-6xl[^"]*"><span class="whitespace-nowrap">([−-]?)\$([\d,]+)/,
		);
		expect(shown).not.toBeNull();
		// Home's headline is formatCents in whole dollars, so the example is rounded the same way.
		expect(`${shown?.[1] ?? ""}$${shown?.[2]}`).toBe(
			formatCents(safeCents, { wholeDollars: true }).replace("-", "−"),
		);
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
			page.match(
				new RegExp(`<(?:desc|span) id="${id}-desc"[^>]*>([^<]+)<`),
			)?.[1] ?? "";
		const example = (re: RegExp) => page.match(re)?.slice(1) ?? [];

		const [budgetsLeft, less] = example(
			/Your budgets have (\$[\d,]+(?:\.\d\d)?) left\. Safe to spend is (\$[\d,]+(?:\.\d\d)?) less:/,
		);
		const amountCents = (value: string) =>
			Math.round(Number(value.replace(/[$,]/g, "")) * 100);
		const safe = formatCents(
			amountCents(budgetsLeft ?? "$0") - amountCents(less ?? "$0"),
		);
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
		expect(html).toMatch(/counted transactions, and 10 need a category\./);
		expect(html).toMatch(/Jev categorized \d+ transactions\./);
		expect(decodeHtml(html)).toContain("10 are waiting for tonight's run.");
		expect(html).toContain("80%");
	});
});

describe("the budget guide with no activity", () => {
	const budgetSection = (html: string) =>
		html.match(/<section[^>]*id="budget"[\s\S]*?<\/section>/)?.[0] ?? "";

	it("shows the worked example for a household whose only data is a savings goal", async () => {
		const month = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM bills"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM budget_amounts"),
			env.DB.prepare("DELETE FROM savings_goal_amounts"),
		]);
		await env.DB.prepare(
			"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES (?, 50000)",
		)
			.bind(month)
			.run();

		const html = decodeHtml(
			await (await howItWorks.request("/how-it-works", {}, notDemo)).text(),
		);
		const section = budgetSection(html);
		expect(section).toContain("With your numbers");
		expect(section).toContain("Savings goal");
		expect(section).toContain("$500.00");
	});

	it("keeps the empty state when the household has no budget data or goal", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM bills"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM budget_amounts"),
			env.DB.prepare("DELETE FROM savings_goal_amounts"),
			env.DB.prepare("DELETE FROM planned_expenses"),
		]);
		const html = decodeHtml(
			await (await howItWorks.request("/how-it-works", {}, notDemo)).text(),
		);
		const section = budgetSection(html);
		expect(section).toContain("No budgets have been set yet.");
		expect(section).not.toContain("With your numbers");
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
		await env.DB.prepare("DELETE FROM planned_expenses").run();
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
	it("Home has no Things to try (they live in Start here, spec §9) and keeps its link to the budget section", async () => {
		const { html } = await get("/");
		// The page's first heading is its h1.
		expect(html.match(/<h[1-6]\b/)?.[0]).toBe("<h1");
		expect(html).not.toContain("Things to try");
		expect(html).not.toContain("New here?");
		expect(html).toContain('href="/how-it-works#budget"');
	});

	it("Transactions links to its section, and the edit sheet to categorization", async () => {
		expect((await get("/transactions")).html).toContain(
			'href="/how-it-works#transactions"',
		);
		const sheet = (await get("/transactions/110")).html;
		expect(sheet).toContain('href="/how-it-works#categorization"');
		// The panel has no How this works link of its own (P120 B, decision 111, audit E5); its Why? links stay.
		const panel = sheet.slice(sheet.indexOf('id="edit-title"'));
		expect(panel).not.toContain('aria-label="How this works: categories"');
	});

	it("More lists How Tally works", async () => {
		expect((await get("/more")).html).toMatch(
			/<a href="\/how-it-works"[\s\S]*?>How Tally works<\/span>/,
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

	it("says a merchant rule is set by the edit panel's tick, and removed by unticking it (#491, #353)", async () => {
		const html = (await get("/how-it-works")).html;
		const categorization =
			html.match(/<section[^>]*id="categorization"[\s\S]*?<\/section>/)?.[0] ??
			"";
		expect(categorization).toContain(
			"set by ticking &quot;Use this category for … from now on&quot; in the edit panel.",
		);
		expect(categorization).toContain("to remove a rule, untick it and save.");
		expect(categorization).not.toContain("remove it in Settings");
		expect(categorization).not.toContain("Always for this merchant");
	});

	it("says a what-it-was line is written only when it can say more than the store's name (decision 103)", async () => {
		const html = (await get("/how-it-works")).html;
		const categorization =
			html.match(/<section[^>]*id="categorization"[\s\S]*?<\/section>/)?.[0] ??
			"";
		expect(categorization).toContain(
			"Tally writes “What it was” only when it can say more than the store&#39;s name.",
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
			// The demo's banner also links to How Tally works (Start here), so the Why? link is the one that isn't that.
			const hrefs = [...accountsHtml.matchAll(/href="(\/how-it-works#[^"]+)"/g)]
				.map((m) => m[1])
				.filter((href) => href !== "/how-it-works#start-here");
			expect(hrefs).toEqual(["/how-it-works#net-worth"]);
			// The anchor is a real section id on the page it points to.
			const id = (hrefs[0] ?? "").split("#")[1];
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
		// Only the architecture table: other sections (Bills' statuses, #341) are definition lists too.
		const architecture =
			html.match(/<section[^>]*id="architecture"[\s\S]*?<\/section>/)?.[0] ??
			"";
		const page = [
			...architecture.matchAll(/<dt[^>]*>([^<]+)<\/dt><dd[^>]*>([^<]+)<\/dd>/g),
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

describe("a payment for a planned expense counts while excluded, as a bill's does (#202)", () => {
	const sectionOf = (html: string, id: string) =>
		decodeHtml(
			html.match(
				new RegExp(`<section[^>]*id="${id}"[\\s\\S]*?</section>`),
			)?.[0] ?? "",
		).replace(/\s+/g, " ");
	const family = async () =>
		(await howItWorks.request("/how-it-works", {}, notDemo)).text();

	it("says in Transactions that a counted transaction is not excluded unless it pays a bill or a planned expense", async () => {
		for (const html of [(await get("/how-it-works")).html, await family()]) {
			const text = sectionOf(html, "transactions");
			expect(text).toContain(
				"A counted transaction is in the month, not excluded (unless it pays a bill or a planned expense), and not a split parent (its parts count instead) or a credit held for review (below).",
			);
			expect(text).not.toContain("unless it pays a bill)");
		}
	});

	it("says in Excluding that a payment linked to a bill or a planned expense always counts", async () => {
		for (const html of [(await get("/how-it-works")).html, await family()]) {
			const text = sectionOf(html, "exclusions");
			expect(text).toContain(
				"An excluded transaction doesn't count toward spending, uncategorized, or safe to spend, unless it pays a bill or a planned expense: a payment linked to either always counts.",
			);
			expect(text).not.toContain("a payment linked to a bill always counts");
		}
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

describe("the Bills section's four statuses (decision 99, #341)", () => {
	const billsSection = (html: string) =>
		decodeHtml(html).match(/<section[^>]*id="bills"[\s\S]*?<\/section>/)?.[0] ??
		"";
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-10T16:00:00Z"));
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await env.DB.prepare("DELETE FROM bills").run();
		const [paid, earlier] = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE amount_cents > 0 ORDER BY id LIMIT 2",
			).all<{ id: number }>()
		).results;
		// Electric overdue (Oct 3), Internet due in a week (Oct 14), Gym upcoming (Oct 25, September paid), Water paid (Oct 3).
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9721,'Electric',14200,3,'monthly',5,'STATUS ELECTRIC FIXTURE'),(9722,'Internet',6500,14,'monthly',5,'STATUS INTERNET FIXTURE'),(9723,'Gym',3000,25,'monthly',5,'STATUS GYM FIXTURE'),(9724,'Water',4820,3,'monthly',5,'STATUS WATER FIXTURE')",
			),
			env.DB.prepare(
				"UPDATE transactions SET date = '2026-10-03' WHERE id = ?",
			).bind(paid?.id ?? 0),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9723,'2026-09',?,'user','linked')",
			).bind(earlier?.id ?? 0),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9724,'2026-10',?,'user','linked')",
			).bind(paid?.id ?? 0),
		]);
	});
	afterEach(() => vi.useRealTimers());

	it("explains each status in plain words, with one of this household's bills as the example", async () => {
		const demoHtml = (await get("/how-it-works")).html;
		const familyHtml = await (
			await howItWorks.request("/how-it-works", {}, notDemo)
		).text();
		for (const html of [demoHtml, familyHtml]) {
			const bills = billsSection(html);
			for (const term of [
				"Overdue",
				"Due in the next 7 days",
				"Upcoming",
				"Paid this month",
			])
				expect(bills).toContain(`<dt class="font-semibold">${term}</dt>`);
			expect(bills).toContain("For example: Electric, due Oct 3.");
			expect(bills).toContain("For example: Internet, due Oct 14.");
			expect(bills).toContain("For example: Gym, due Oct 25.");
			expect(bills).toContain("For example: Water, due Oct 3, paid Oct 3.");
			expect(bills).toContain(
				"A payment is linked to the occurrence Bills shows.",
			);
		}
	});

	it("says a weekly or every-two-weeks miss is overdue only within the month it was due", async () => {
		// billOccurrence drops an earlier month's weekly miss from Overdue, so the page must say the same.
		const html = billsSection(
			await (await howItWorks.request("/how-it-works", {}, notDemo)).text(),
		);
		expect(html).toContain(
			"A weekly or every-two-weeks bill stays overdue until it's paid, within the month it was due.",
		);
		expect(html).not.toContain(
			"A weekly or every-two-weeks bill stays overdue until it's paid. ",
		);
	});

	it("says so plainly for a status no bill has", async () => {
		await env.DB.prepare("DELETE FROM bills").run();
		const html = billsSection(
			await (await howItWorks.request("/how-it-works", {}, notDemo)).text(),
		);
		expect(html).toContain("No bill is overdue right now.");
		expect(html).toContain("No bill is due in the next 7 days right now.");
		expect(html).toContain("No bill is upcoming right now.");
		expect(html).toContain("No bill has been paid yet this month.");
	});
});

describe("Start here, the demo banner and the page's order (spec §8.8, §9; P124 A)", () => {
	const thisMonth = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
	/** The newest bank line of this month with the flag, read the way Start here reads it. */
	const latestId = async (flag: "flag_income" | "flag_transfer") =>
		(
			await env.DB.prepare(
				`SELECT id FROM transactions WHERE ${flag} = 1 AND parent_id IS NULL AND substr(date, 1, 7) = ? ORDER BY date DESC, id DESC LIMIT 1`,
			)
				.bind(thisMonth)
				.first<{ id: number }>()
		)?.id;
	const startHere = (html: string) =>
		decodeHtml(
			html.match(/<section[^>]*id="start-here"[\s\S]*?<\/section>/)?.[0] ?? "",
		);

	it("puts the demo banner's Start here link above the sidebar on every page, and no banner in the family app", async () => {
		for (const path of ["/", "/transactions", "/how-it-works"]) {
			const { html } = await get(path);
			expect(html).toContain("Demo data. Nothing here is real. ·");
			const link = html.indexOf('href="/how-it-works#start-here"');
			expect(link).toBeGreaterThan(-1);
			expect(link).toBeLessThan(html.indexOf("<aside"));
		}
		const family = await (await home.request("/", {}, notDemo)).text();
		expect(family).not.toContain("Demo data. Nothing here is real.");
		expect(family).not.toContain("#start-here");
	});

	it("opens How Tally works with Start here under its title, then the intro, then the feature sections in their order, and How it's built last, in the demo", async () => {
		const { html } = await get("/how-it-works");
		const at = (needle: string) => html.indexOf(needle);
		const ids = [
			"budget",
			"transactions",
			"exclusions",
			"categorization",
			"names",
			"bills",
			"trends",
			"what-ai-did",
			"net-worth",
			"architecture",
		];
		const positions = ids.map((id) => at(`id="${id}"`));
		expect(positions.every((position) => position > -1)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
		expect(at("<h1")).toBeLessThan(at('id="start-here"'));
		expect(at('id="start-here"')).toBeLessThan(
			at("Tally is a small family budgeting app"),
		);
		expect(at("Tally is a small family budgeting app")).toBeLessThan(
			positions[0] ?? -1,
		);
		expect(html).not.toContain("It runs on a made-up household");
	});

	it("leaves Start here and How it's built out of the family app's How Tally works, whose intro sits right under the title", async () => {
		const html = await (
			await howItWorks.request("/how-it-works", {}, notDemo)
		).text();
		expect(html).not.toContain('id="start-here"');
		expect(html).not.toContain('id="architecture"');
		expect(html).toMatch(
			/<\/h1>\s*<p class="mt-4 text-lg">\s*Tally is a small family budgeting app/,
		);
	});

	it("says what the made-up family's bank sent this month, in the demo's current month", async () => {
		const { html } = await get("/how-it-works");
		expect(startHere(html)).toContain(
			`The Riveras are a made-up family. Here's what their bank sent this ${monthName()}, and what Tally wrote down.`,
		);
	});

	it("strikes three of this month's bank lines and writes Tally's row under each: the latest paycheck, the latest transfer, then transaction 110", async () => {
		const { html } = await get("/how-it-works");
		const section = startHere(html);
		const lines = [
			...section.matchAll(
				/<s class="decoration-muted">([^<]+)<\/s>[\s\S]*?data-transaction="(\d+)"/g,
			),
		].map((m) => [m[1], Number(m[2])]);
		expect(lines).toEqual([
			["ACME CORP PAYROLL", await latestId("flag_income")],
			["ONLINE TRANSFER TO SAV ...5678", await latestId("flag_transfer")],
			["SQ *LOCAL BAKERY 4432", 110],
		]);
		// Each struck line reads as "The bank sent …" to a screen reader; the strike itself is only drawn.
		expect(section.match(/The bank sent /g)).toHaveLength(3);
	});

	it("shows Safe to spend exactly as Home does for the same day, under a decorative double rule", async () => {
		const home = (await get("/")).html;
		const amount = home.match(
			/lg:text-7xl[^"]*">(?:<span[^>]*>)?([^<]+)</,
		)?.[1];
		expect(amount).toBeTruthy();
		const { html } = await get("/how-it-works");
		expect(startHere(html)).toContain(`tabular-nums">${amount}</p>`);
		expect(html.match(/<div[^>]*border-double[^>]*>/)?.[0] ?? "").toContain(
			'aria-hidden="true"',
		);
		expect(startHere(html)).toContain(
			`What's left of ${monthName()}'s budget after its spending so far, bills due and savings.`,
		);
	});

	it("links to the list without Tally, and has the three things to try, moved here from Home, each linking to where it's done", async () => {
		const { html } = await get("/how-it-works");
		const links = [
			...startHere(html).matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g),
		].map((m) => [m[1], m[2]]);
		expect(links).toEqual([
			["/transactions?raw=1", "See every line without Tally"],
			["/transactions?uncategorized=1", "Give a transaction a category"],
			["/transactions/110?uncategorized=1", "Set a rule for a merchant"],
			["/transactions/110?uncategorized=1", "Rename a merchant"],
		]);
	});
});

describe("Start here's month and count (#502)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/** The raw list's result count text, as a visitor reads it. */
	const resultCount = (html: string) =>
		decodeHtml(
			html
				.match(/<p id="result-count"[^>]*>([\s\S]*?)<\/p>/)?.[1]
				?.replace(/<[^>]+>/g, "") ?? "",
		);
	const startHere = (html: string) =>
		decodeHtml(
			html.match(/<section[^>]*id="start-here"[\s\S]*?<\/section>/)?.[0] ?? "",
		);
	/** The seed's month: the month of transaction 110, which Start here's lines are from. */
	const storyMonth = async () =>
		(
			await env.DB.prepare(
				"SELECT substr(date, 1, 7) AS month FROM transactions WHERE id = 110",
			).first<{ month: string }>()
		)?.month;
	/** Resets the demo on October 31 (its seed is October's), then moves the clock to November 1. */
	const toNovemberFirst = async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-31T16:00:00Z"));
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		vi.setSystemTime(new Date("2026-11-01T16:00:00Z"));
	};
	const startHereHtml = async () =>
		startHere((await get("/how-it-works")).html);

	it("on November 1 names October for the bank lines and November for Safe to spend, which equals Home's", async () => {
		await toNovemberFirst();
		const home = (await get("/")).html;
		const amount = home.match(
			/lg:text-7xl[^"]*">(?:<span[^>]*>)?([^<]+)</,
		)?.[1];
		expect(amount).toBeTruthy();
		const section = await startHereHtml();
		expect(section).toContain(
			"Here's what their bank sent this October, and what Tally wrote down.",
		);
		expect(section.match(/<s class="decoration-muted">/g)).toHaveLength(3);
		expect(section).toContain("Three lines of ");
		expect(section).toContain("What's left of November's budget");
		expect(section).toContain(`tabular-nums">${amount}</p>`);
		expect(section).toContain("/transactions?raw=1&month=2026-10");
	});

	it("says 'Three lines of N so far', with N the raw list's own count, and drops that heading and the Without Tally sentence once the month has no transfer", async () => {
		const month = await storyMonth();
		const listed = await get("/transactions?raw=1");
		const n = Number(
			resultCount(listed.html).match(/(\d+) transactions?\b/)?.[1],
		);
		expect(n).toBeGreaterThan(0);
		const section = await startHereHtml();
		expect(section).toContain(`Three lines of ${n} so far`);
		expect(section).toContain("Without Tally, the paycheck and the transfer");

		await env.DB.prepare(
			"UPDATE transactions SET flag_transfer = 0 WHERE flag_transfer = 1 AND substr(date, 1, 7) = ?",
		)
			.bind(month)
			.run();
		const after = await startHereHtml();
		expect(after).not.toContain("Three lines of");
		expect(after).not.toContain("Without Tally, the paycheck");
	});

	it("keeps transaction 110 in Start here after a visitor splits it: struck text, Split transaction, and no link", async () => {
		const split = await saveSplit(
			env.DB,
			110,
			[
				{ categoryId: 1, amountCents: 700 },
				{ categoryId: 4, amountCents: 500 },
			],
			"person@example.com",
		);
		expect(split.saved).toBe(true);
		const section = await startHereHtml();
		expect(section).toMatch(
			/<s class="decoration-muted">SQ \*LOCAL BAKERY 4432<\/s>[\s\S]*?data-transaction="110"/,
		);
		const start = section.indexOf('data-transaction="110"');
		const row = section.slice(start, section.indexOf("</li>", start));
		expect(row).toContain("Split transaction");
		expect(row).not.toContain("<a ");
	});

	it("writes 'SQ *LOCAL BAKERY 4432' once in Start here, struck, with Needs category under it", async () => {
		const section = await startHereHtml();
		expect(section.split("SQ *LOCAL BAKERY 4432")).toHaveLength(2);
		const start = section.indexOf("SQ *LOCAL BAKERY 4432");
		expect(section.slice(start, section.indexOf("</li>", start))).toContain(
			"Needs category",
		);
	});
});

describe("each section's exact rules fold under its picture (decision 126, P137 A, #644)", () => {
	const SECTIONS = [
		"budget",
		"transactions",
		"exclusions",
		"categorization",
		"names",
		"bills",
		"trends",
		"what-ai-did",
		"net-worth",
	];
	/** The section's markup, or "" if the page has none. */
	const sectionOf = (html: string, id: string) =>
		html.match(
			new RegExp(`<section[^>]*id="${id}"[\\s\\S]*?<\\/section>`),
		)?.[0] ?? "";
	/** The section's one fold, from its <details> to its </details>. */
	const foldOf = (section: string) =>
		section.match(/<details[\s\S]*<\/details>/)?.[0] ?? "";
	const pages = [
		["the demo", async () => (await get("/how-it-works")).html],
		[
			"the family app",
			async () =>
				await (await howItWorks.request("/how-it-works", {}, notDemo)).text(),
		],
	] as const;

	describe.each(pages)("in %s", (_name, load) => {
		it.each(SECTIONS)(
			"%s has one closed fold, as its last child, after its picture and example",
			async (id) => {
				const section = sectionOf(await load(), id);
				expect(section, "the section renders").not.toBe("");
				expect(section.match(/<details/g)?.length ?? 0, "one fold").toBe(1);
				expect(section, "closed by default").not.toMatch(
					/<details[^>]* open[ >=]/,
				);
				expect(section, "the fold is the last child").toMatch(
					/<div class="mt-3"><details class="group border-b border-rule"[^>]*>[\s\S]*<\/details><\/div><\/section>$/,
				);
				const fold = foldOf(section);
				const at = section.indexOf("<details");
				for (const picture of ['role="img"', "bg-band"]) {
					const last = section.lastIndexOf(picture);
					if (last !== -1)
						expect(last, `${picture} comes before the fold`).toBeLessThan(at);
				}
				expect(
					section.replace(fold, ""),
					"no rules outside the fold",
				).not.toMatch(/<(ul|ol|li)[ >]/);
				expect(fold, "the rules list is in the fold").toMatch(
					/<(ul class="mt-3 list-disc space-y-1 pl-5"|ol class="mt-3 list-decimal space-y-1 pl-5")>/,
				);
			},
		);

		it.each(SECTIONS)(
			"%s's fold says 'The exact rules' and then its rule count, which is the rules inside it",
			async (id) => {
				const fold = foldOf(sectionOf(await load(), id));
				const summary = fold.slice(
					fold.indexOf("<summary"),
					fold.indexOf("</summary>"),
				);
				const label = summary.indexOf("The exact rules");
				const count = summary.match(/(\d+) (rules?)</);
				expect(label, "the label").toBeGreaterThanOrEqual(0);
				expect(count, "the rule count").not.toBeNull();
				expect(label, "the label comes first").toBeLessThan(count?.index ?? -1);
				const body = fold.slice(fold.indexOf("</summary>"));
				const rules =
					(body.match(/<li[ >]/g) ?? []).length +
					(body.match(/<p[ >]/g) ?? []).length;
				expect(rules, "rules inside the fold").toBeGreaterThan(0);
				expect(Number(count?.[1]), "the count matches the rules").toBe(rules);
				expect(count?.[2]).toBe(rules === 1 ? "rule" : "rules");
			},
		);

		it("keeps Categories' four steps and five rule paragraphs in the fold, in order", async () => {
			const section = decodeHtml(sectionOf(await load(), "categorization"));
			const fold = decodeHtml(foldOf(section));
			const rules = [
				"A person's choice, which nothing overwrites.",
				"A merchant rule:",
				"A bill: a payment linked",
				"AI model, which each night picks",
				"After a person picks the same category",
				"A trip looks mixed when",
				"See every rule in Settings",
				"A suggested category is only an idea",
				"With Fill in details on",
			];
			let previous = -1;
			for (const rule of rules) {
				expect(section.split(rule), `${rule} appears once`).toHaveLength(2);
				const at = fold.indexOf(rule);
				expect(at, `${rule} is in the fold`).toBeGreaterThan(previous);
				previous = at;
			}
			expect(fold.match(/<ol class="mt-3 list-decimal/g)).toHaveLength(1);
		});

		it("keeps Bills' intro and four groups where they are, before its picture and the fold", async () => {
			const section = decodeHtml(sectionOf(await load(), "bills"));
			const intro = section.indexOf(
				"Bills puts each active bill in one of four groups:",
			);
			const groups = section.indexOf("<dl");
			const picture = section.indexOf('role="img"');
			const fold = section.indexOf("<details");
			expect(intro).toBeGreaterThanOrEqual(0);
			expect(groups).toBeGreaterThan(intro);
			// Bills' picture renders only with a paid bill, so the order is checked when it does.
			if (picture !== -1) expect(picture).toBeGreaterThan(groups);
			expect(fold).toBeGreaterThan(groups);
			expect(foldOf(section)).not.toContain("<dl");
		});

		it("leaves Architecture as it was, with no fold", async () => {
			const html = await load();
			const architecture = sectionOf(html, "architecture");
			if (architecture !== "") expect(architecture).not.toContain("<details");
		});
	});

	it("keeps each fold last in the family app with no data, after the empty-state sentences", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM bills"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM budget_amounts"),
			env.DB.prepare("DELETE FROM savings_goal_amounts"),
			env.DB.prepare("DELETE FROM planned_expenses"),
			env.DB.prepare("DELETE FROM balance_history"),
			env.DB.prepare("DELETE FROM accounts"),
		]);
		const html = await (
			await howItWorks.request("/how-it-works", {}, notDemo)
		).text();
		for (const id of SECTIONS) {
			const section = sectionOf(html, id);
			expect(section, `${id} renders`).not.toBe("");
			expect(section.match(/<details/g)?.length ?? 0, `${id} one fold`).toBe(1);
			expect(section, `${id}'s fold is last`).toMatch(
				/<div class="mt-3"><details class="group border-b border-rule"[^>]*>[\s\S]*<\/details><\/div><\/section>$/,
			);
		}
		const budget = sectionOf(html, "budget");
		expect(budget).toContain("No budgets have been set yet.");
		expect(budget.indexOf("No budgets have been set yet.")).toBeLessThan(
			budget.indexOf("<details"),
		);
		expect(sectionOf(html, "transactions")).toContain(
			"There are no transactions this month yet.",
		);
		expect(sectionOf(html, "net-worth")).toContain(
			"There are no accounts to add up yet.",
		);
	});
});

describe("How Tally works' Your first week (P125 E, #591)", () => {
	const demoBindings = { ...env, DEMO: "true" } as unknown as Env;
	const familyPage = async () =>
		decodeHtml(
			await (await howItWorks.request("/how-it-works", {}, notDemo)).text(),
		);
	const writeRecord = (value: unknown) =>
		env.DB.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('first_tally', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
			.bind(JSON.stringify(value))
			.run();
	/** The first connected bank, named as the test's line reads it (its name is the stroke-one line's). */
	const nameFirstBank = (name: string) =>
		env.DB.prepare(
			"UPDATE plaid_items SET institution_name = ? WHERE id = (SELECT MIN(id) FROM plaid_items WHERE disconnected_at IS NULL)",
		)
			.bind(name)
			.run();

	it("in the family app, names the five strokes with the day each was drawn, and how a first budget is suggested", async () => {
		await nameFirstBank("Chase");
		await writeRecord({
			strokes: { bank: "2026-10-12", pay: "2026-10-13", bills: null },
			budgets: {},
		});
		const html = await familyPage();
		expect(html).toContain('id="first-week"');
		expect(html).toContain("Link your bank: Chase, linked · Oct 12");
		expect(html).toContain("Your pay: no paycheck found · Oct 13");
		expect(html).toContain("Your bills: done");
		expect(html).toContain("Your budgets: One tap, or one at a time");
		expect(html).toContain(
			"A first budget is suggested from what your bank shows a category spent in up to its last three full months",
		);
		expect(html).not.toContain(
			"Tally set up your household before this page existed.",
		);
	});

	it("gives each drawn stroke its line on what it did, beside its day, and an undrawn stroke its question note", async () => {
		await nameFirstBank("Chase");
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name) VALUES ('ACME CORP PAYROLL', 'Acme Corp') ON CONFLICT(raw_name) DO UPDATE SET display_name = excluded.display_name",
		).run();
		await writeRecord({
			strokes: {
				bank: "2026-10-12",
				pay: "2026-10-13",
				bills: "2026-10-13",
				budgets: "2026-10-13",
				count: "2026-10-14",
			},
			pay: {
				"ACME CORP PAYROLL": {
					yes: { "1": { date: "2026-10-03", cents: 245000 } },
					at: 0,
				},
			},
			bills: { kept: 8, cents: 206200 },
			budgets: Object.fromEntries(
				Array.from({ length: 12 }, (_, i) => [
					String(i + 1),
					{ kind: "suggested", cents: 10000 },
				]),
			),
			night: { brought: 3, needYou: 1 },
		});
		const html = await familyPage();
		expect(html).toContain("Link your bank: Chase, linked · Oct 12");
		expect(html).toContain("Your pay: Acme Corp · Oct 13");
		expect(html).toContain("Your bills: 8 kept · Oct 13");
		expect(html).toContain("Your budgets: 12 budgets · Oct 13");
		expect(html).toContain(
			"Tally kept count on its own: 3 new transactions, 1 needs you · Oct 14",
		);
		expect(html).not.toContain("done Oct");
		expect(html).not.toContain("Overnight");
	});

	it("gives an undrawn stroke its question note and no line", async () => {
		await nameFirstBank("Chase");
		await writeRecord({
			strokes: { bank: "2026-10-12" },
			budgets: {},
		});
		const html = await familyPage();
		expect(html).toContain("Your pay: One question");
		expect(html).toContain("Your budgets: One tap, or one at a time");
		expect(html).not.toContain("Your pay: no paycheck");
	});

	it("keeps the bank line on the first bank after it is disconnected and a second is linked (#714)", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET institution_name = 'Chase' WHERE id = (SELECT MIN(id) FROM plaid_items)",
		).run();
		await writeRecord({
			strokes: { bank: "2026-10-12", pay: "2026-10-13" },
			budgets: {},
		});
		// Disconnecting keeps the row, so the first bank stays the lowest id; the second bank links after it.
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id = (SELECT MIN(id) FROM plaid_items)",
		).run();
		await env.DB.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Wells Fargo', 'owner', 'item-wells-714')",
		)
			.bind(new Uint8Array([1, 2, 3]))
			.run();
		const html = await familyPage();
		expect(html).toContain("Link your bank: Chase, linked · Oct 12");
		expect(html).not.toContain("Wells Fargo, linked");
	});

	it("mid-setup, with no record, reads every stroke as not drawn, with its note", async () => {
		await env.DB.prepare(
			"DELETE FROM household_settings WHERE key = 'first_tally'",
		).run();
		const html = await familyPage();
		expect(html).toContain("Link your bank: About a minute");
		expect(html).toContain("Your pay: One question");
		expect(html).toContain("Tomorrow · Tally keeps count on its own: Later");
	});

	it("for a household set up before the feature shipped, shows the steps without days, under the sentence", async () => {
		await writeRecord({
			strokes: {
				bank: null,
				pay: null,
				bills: null,
				budgets: null,
				count: null,
			},
			budgets: {},
		});
		const html = await familyPage();
		expect(html).toContain("Link your bank: done");
		expect(html).not.toContain("Link your bank: done Oct");
		expect(html).toContain(
			"Tally set up your household before this page existed.",
		);
	});

	it("is not shown in the demo", async () => {
		const html = decodeHtml(
			await (
				await howItWorks.request("/how-it-works", {}, demoBindings)
			).text(),
		);
		expect(html).not.toContain('id="first-week"');
	});
});

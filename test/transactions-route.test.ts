import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { SHOW_LABELS, SHOWS } from "../src/transactions/filters";
import { FilterSelect } from "../src/views/filter-select";

async function get(path: string, headers: Record<string, string> = {}) {
	const res = await exports.default.fetch(`http://tally.test${path}`, {
		headers,
	});
	return { res, html: await res.text() };
}

const rowCount = (html: string) =>
	(html.match(/<li data-transaction=/g) ?? []).length;

/** The aria-live result count's text. */
const countOf = (html: string) =>
	html.match(/<p id="result-count"[^>]*>([^<]+)<\/p>/)?.[1];

/** The text of each option of the select with this id, as the page renders it (entities decoded). */
function optionsOf(html: string, id: string) {
	const select = html.match(
		new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`),
	)?.[1];
	return [...(select ?? "").matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map(
		(m) => ({
			text: (m[2] ?? "").replaceAll("&amp;", "&"),
			value: /value="([^"]*)"/.exec(m[1] ?? "")?.[1],
			selected: /\bselected\b/.test(m[1] ?? ""),
		}),
	);
}

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
});

describe("GET /transactions", () => {
	it.each([
		["monthly", null, "2026-08"],
		["yearly", 8, "2026"],
	] as const)(
		"shows the Counts in caption in list and detail for a %s bill",
		async (frequency, anchor, period) => {
			await env.DB.batch([
				env.DB.prepare(
					"INSERT INTO bills(id,name,amount_cents,due_day,frequency,anchor_month,merchant_raw_name) VALUES(95,'Caption',1000,31,?,?, 'CAPTION')",
				).bind(frequency, anchor),
				env.DB.prepare(
					"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id) SELECT 905,id,'2026-09-02',1000,'CAPTION',1 FROM accounts LIMIT 1",
				),
				env.DB.prepare(
					"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(95,?,905,'user','linked')",
				).bind(period),
			]);
			expect((await get("/transactions?month=2026-08")).html).toContain(
				"Counts in August",
			);
			expect((await get("/transactions/905")).html).toContain(
				"Counts in August",
			);
			await env.DB.prepare(
				"UPDATE transactions SET excluded=1 WHERE id=905",
			).run();
			expect((await get("/transactions/905")).html).not.toContain(
				"Counts in August",
			);
		},
	);
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
		const { html } = await get("/transactions?show=excluded");
		expect(rowCount(html)).toBe(2);
		expect(html).toContain("Transfer to Savings");
		expect(html).toContain("Reimbursement, doctor&#39;s office");
	});

	it("still shows the excluded ones for the old Excluded chip's link, with Show Excluded chosen", async () => {
		const old = (await get("/transactions?excluded=1")).html;
		const now = (await get("/transactions?show=excluded")).html;
		expect(rowCount(old)).toBe(2);
		expect(old).toContain("Transfer to Savings");
		expect(old).toMatch(
			/<option value="excluded" selected[^>]*>Excluded<\/option>/,
		);
		expect(countOf(old)).toBe(countOf(now));
		expect(countOf(old)).toMatch(/^2 excluded transactions in /);
	});

	it("shows the search empty state with a way back", async () => {
		const { html } = await get("/transactions?q=zzz");
		expect(html).toContain("No transactions match these filters.");
		expect(html).toMatch(
			/<a[^>]*href="\/transactions"[^>]*>Clear filters<\/a>/,
		);
	});

	it("keeps the search empty state when needs category is combined with search", async () => {
		const { html } = await get("/transactions?uncategorized=1&q=zzz");
		expect(html).toContain("No transactions match these filters.");
		expect(html).toMatch(
			/<a[^>]*href="\/transactions"[^>]*>Clear filters<\/a>/,
		);
		expect(html).not.toContain("Every transaction has a category.");
	});

	it("shows the done empty state when no transaction needs a category", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 1 WHERE category_id IS NULL",
		).run();
		const { html } = await get("/transactions?uncategorized=1");
		expect(html).toContain("Every transaction has a category.");
		expect(html).toContain("New ones appear here as they come in.");
		expect(html).not.toContain("Clear filters");
	});

	it("shows the result count in a stable live region that htmx updates in place", async () => {
		const { html } = await get("/transactions?uncategorized=1");
		expect(html).toMatch(
			/<p id="result-count" aria-live="polite"[^>]*>12 transactions needing a category in [A-Z][a-z]+<\/p>/,
		);
		expect(html).toContain(
			'hx-select-oob="#needs-count:innerHTML, #result-count:innerHTML, #add-cash:outerHTML, #select-toggle:outerHTML,',
		);
	});

	it("names the filters in the count, so two filters with the same count still read differently (#56)", async () => {
		// Every earlier month has three transactions in each category.
		const [y, m] = todayIn(DEFAULT_TIME_ZONE)
			.slice(0, 7)
			.split("-")
			.map(Number) as [number, number];
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

	it("names an archived category a bookmarked link still filters by", async () => {
		await env.DB.prepare(
			"UPDATE categories SET archived = 1 WHERE id = 1",
		).run();
		const { html } = await get("/transactions?month=all&category=1");
		expect(html).toMatch(
			/<p id="result-count"[^>]*>\d+ transactions in Groceries, across all months<\/p>/,
		);
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
			/<p id="result-count"[^>]*>Showing 1–25 of 39 transactions in [A-Z][a-z]+<\/p>/,
		);
		expect(first).toMatch(/<nav aria-label="Pages"/);
		expect(first).toContain("Page 1 of 2");
		expect(first).toMatch(
			/<a[^>]*href="\/transactions\?page=2"[^>]*rel="next"[^>]*>Older<\/a>/,
		);
		expect(first).not.toContain(">Newer<");

		const second = (await get("/transactions?page=2")).html;
		expect(rowCount(second)).toBe(14);
		expect(second).toMatch(/Showing 26–39 of 39 transactions/);
		expect(second).toMatch(
			/<a[^>]*href="\/transactions"[^>]*rel="prev"[^>]*>Newer<\/a>/,
		);
		expect(second).not.toContain(">Older<");
	});

	it("centres the page label between two equal sides, so it stays put from page to page", async () => {
		for (const path of [
			"/transactions",
			"/transactions?page=2",
			"/transactions?month=all&page=3",
		]) {
			const { html } = await get(path);
			// Three grid tracks, the middle one auto: an empty Newer or Older slot still holds its side.
			expect(html).toContain(
				'<nav aria-label="Pages" class="mt-4 grid grid-cols-[1fr_auto_1fr] items-center border-t border-rule pt-2">',
			);
			expect(html).toMatch(
				/<span class="text-sm text-muted">\s*Page \d+ of \d+\s*<\/span><span class="justify-self-end">/,
			);
		}
		// The words meet the rule's ends: the page links cancel their own 8px inset, keeping the 44px target.
		const { html } = await get("/transactions?month=all&page=2");
		expect(html).toMatch(
			/<a[^>]*rel="prev"[^>]*class="inline-flex min-h-11 items-center px-2 -mx-2"/,
		);
		expect(html).toMatch(
			/<a[^>]*rel="next"[^>]*class="inline-flex min-h-11 items-center px-2 -mx-2"/,
		);
	});

	it("holds the title row to the list's width on desktop, with Select flush to the amounts' edge", async () => {
		const { html } = await get("/transactions");
		expect(html).toMatch(
			/<div class="flex items-center justify-between gap-3 lg:max-w-3xl"><h1 id="transactions-title"/,
		);
		const select = html.match(/<a[^>]*id="select-toggle"[^>]*>/)?.[0] ?? "";
		// -mr-2 cancels the text button's 8px inset; px-2 and min-h-11 stay, so the target is still 44px.
		expect(select).toMatch(/class="[^"]*\bmin-h-11\b[^"]*\bpx-2\b[^"]*-mr-2/);
	});

	it("lines Organize by merchant up with the count above it", async () => {
		const { html } = await get("/transactions?uncategorized=1");
		const organize =
			html.match(/<a[^>]*href="\/transactions\/organize"[^>]*>/)?.[0] ?? "";
		expect(organize).toMatch(/class="[^"]*\bmin-h-11\b[^"]*\bpx-2\b[^"]*-ml-2/);
	});

	it("keeps the filters in page links and hides the pager on a single page", async () => {
		// All months include the demo's lookalike bill charge, so there are 6 pages.
		const html = (await get("/transactions?month=all")).html;
		expect(html).toContain("Page 1 of 6");
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
		expect(html).toContain("No transactions match these filters.");
	});

	it("is where Home's band link lands", async () => {
		const home = (await get("/")).html;
		const href = home.match(/href="(\/transactions\?[^"]+)"/)?.[1];
		expect(href).toBe("/transactions?uncategorized=1");
		expect(rowCount((await get(href as string)).html)).toBe(12);
	});
});

// The Account and Show choices (#210, spec §8.4; P63 A and P64 B).
describe("GET /transactions: Account and Show", () => {
	it("has a labeled Account choice beside Month and Category, one entry per account, Cash reading 'Cash'", async () => {
		const { html } = await get("/transactions");
		expect(html).toMatch(
			/<label[^>]*for="account"[^>]*class="[^"]*sr-only[^"]*"[^>]*>Account<\/label>/,
		);
		expect(html).toMatch(/<select id="account" name="account"/);
		expect(optionsOf(html, "account")).toEqual([
			{ text: "All accounts", value: "", selected: false },
			{ text: "Checking ••1234", value: "1", selected: false },
			{ text: "Savings ••5678", value: "2", selected: false },
			{ text: "Credit card ••9012", value: "3", selected: false },
			{ text: "Cash", value: "4", selected: false },
		]);
		// Beside Month and Category, in the same row of choices.
		const month = html.indexOf('<select id="month"');
		const category = html.indexOf('<select id="category"');
		const account = html.indexOf('<select id="account"');
		const show = html.indexOf('<select id="show"');
		expect(month).toBeLessThan(category);
		expect(category).toBeLessThan(account);
		expect(account).toBeLessThan(show);
		expect(html.slice(month, show)).not.toContain("</div>");
	});

	it("marks a disconnected bank's accounts 'Disconnected' in the choice, and still filters by them", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id = 2",
		).run();
		const { html } = await get("/transactions?month=all&account=3");
		const card = optionsOf(html, "account").find((o) => o.value === "3");
		expect(card).toEqual({
			text: "Credit card ••9012 · Disconnected",
			value: "3",
			selected: true,
		});
		// Only the disconnected bank's accounts are marked.
		expect(
			optionsOf(html, "account").filter((o) => o.text.includes("Disconnected")),
		).toHaveLength(1);
		expect(rowCount(html)).toBeGreaterThan(0);
		// The count names the account itself, not its bank's state.
		expect(countOf(html)).toMatch(/in Credit card ••9012, across all months$/);
	});

	it("tells two accounts with the same name and ending apart, in the choice and in the count", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO plaid_items(id, access_token_encrypted, institution_name, linked_by) VALUES (8, X'', 'Second Bank', 'demo')",
			),
			env.DB.prepare(
				"INSERT INTO accounts(id, plaid_item_id, name, mask, type, subtype) VALUES (80, 8, 'Checking', '1234', 'depository', 'checking')",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id) VALUES (906,80,'2026-09-02',1200,'SECOND BANK COFFEE',1)",
			),
		]);
		const { html } = await get("/transactions?month=all&account=80");
		const labels = optionsOf(html, "account").map((o) => o.text);
		expect(labels).toContain("Checking ••1234 (First Harbor Bank)");
		expect(labels).toContain("Checking ••1234 (Second Bank)");
		expect(new Set(labels).size).toBe(labels.length);
		expect(countOf(html)).toBe(
			"1 transaction in Checking ••1234 (Second Bank), across all months",
		);
		expect(html).toMatch(/second bank coffee/i);
		const first = (await get("/transactions?month=all&account=1")).html;
		expect(countOf(first)).toMatch(
			/in Checking ••1234 \(First Harbor Bank\), across all months$/,
		);
	});

	it("draws all four choices with the FilterSelect the catalog shows", async () => {
		const { html } = await get("/transactions?month=all&account=4&show=income");
		const drawn = (
			id: string,
			name: string,
			label: string,
			options: unknown[],
			selected: string | number | null,
		) =>
			String(
				FilterSelect({
					id,
					name,
					label,
					options: options as { value: string | number; label: string }[],
					selected,
				}),
			);
		// The Show choice is the one whose options the page fully decides.
		expect(html).toContain(
			drawn(
				"show",
				"show",
				"Show",
				SHOWS.map((s) => ({ value: s, label: SHOW_LABELS[s] })),
				"income",
			),
		);
		for (const [id, label] of [
			["month", "Month"],
			["category", "Category"],
			["account", "Account"],
			["show", "Show"],
		]) {
			expect(html).toContain(
				`<label for="${id}" class="sr-only">${label}</label>`,
			);
			expect(html).toMatch(
				new RegExp(
					`<select id="${id}" name="${id}" class="min-h-11 max-w-full rounded-full border border-rule bg-paper px-4 text-base text-ink">`,
				),
			);
		}
	});

	it("lists only that account's rows and the count names it", async () => {
		const { html } = await get("/transactions?month=all&account=4");
		expect(rowCount(html)).toBe(1);
		expect(html).toContain("Farmers market");
		expect(countOf(html)).toBe("1 transaction in Cash, across all months");
		expect(optionsOf(html, "account").find((o) => o.selected)?.value).toBe("4");

		const card = (await get("/transactions?account=3")).html;
		expect(countOf(card)).toMatch(
			/^\d+ transactions in Credit card ••9012, [A-Z][a-z]+( \d{4})?$/,
		);
		expect(card).not.toContain("Farmers market");
	});

	it("names the category and the account together", async () => {
		const { html } = await get("/transactions?month=all&account=4&category=1");
		expect(countOf(html)).toBe(
			"1 transaction in Groceries, Cash, across all months",
		);
	});

	it("says so for an account that isn't there, still announcing it", async () => {
		const { html } = await get("/transactions?account=999");
		expect(countOf(html)).toMatch(/^0 transactions in account 999, /);
		expect(html).toContain("No transactions match these filters.");
	});

	it("has a labeled Show choice with All, Spending, Income, Refunds and Excluded, replacing the Excluded chip", async () => {
		const { html } = await get("/transactions");
		expect(html).toMatch(
			/<label[^>]*for="show"[^>]*class="[^"]*sr-only[^"]*"[^>]*>Show<\/label>/,
		);
		expect(html).toMatch(/<select id="show" name="show"/);
		expect(optionsOf(html, "show")).toEqual([
			{ text: "All", value: "all", selected: true },
			{ text: "Spending", value: "spending", selected: false },
			{ text: "Income", value: "income", selected: false },
			{ text: "Refunds", value: "refunds", selected: false },
			{ text: "Excluded", value: "excluded", selected: false },
		]);
		// "Needs category" is the only chip left in the filters.
		const filters = html.match(/<form id="filters"[\s\S]*?<\/form>/)?.[0] ?? "";
		expect(filters).not.toContain('name="excluded"');
		expect(filters.match(/type="checkbox"/g)).toHaveLength(1);
		expect(filters).toMatch(/name="uncategorized"/);
	});

	it("Show Income lists only rows flagged income, and the count names the type", async () => {
		const { html } = await get("/transactions?month=all&show=income");
		const n = rowCount(html);
		expect(n).toBeGreaterThan(0);
		expect(html).toContain("Paycheck, Acme Corp");
		expect(countOf(html)).toMatch(
			new RegExp(
				`^(Showing 1–25 of \\d+|${n}) income transactions across all months$`,
			),
		);
		expect(optionsOf(html, "show").find((o) => o.selected)?.value).toBe(
			"income",
		);
		const month = (await get("/transactions?show=income")).html;
		expect(countOf(month)).toMatch(
			/^\d+ income transactions in [A-Z][a-z]+( \d{4})?$/,
		);
	});

	it("Show Refunds lists a credit nobody has identified and a refund nobody linked", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,credit_reviewed) SELECT 880,id,date('now','-1 day'),-1234,'MYSTERY CREDIT',NULL FROM accounts WHERE id=1",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,credit_reviewed,credit_reviewed_by) SELECT 881,id,date('now','-1 day'),-4321,'UNLINKED REFUND',1,'user' FROM accounts WHERE id=1",
			),
		]);
		const { html } = await get("/transactions?month=all&show=refunds");
		expect(html).toContain("Mystery credit");
		expect(html).toContain("Unlinked refund");
		expect(html).not.toContain("Paycheck, Acme Corp");
		expect(countOf(html)).toMatch(/refund transactions across all months$/);
	});

	it("Show Spending names the type and leaves out income", async () => {
		const { html } = await get("/transactions?month=all&show=spending");
		expect(html).not.toContain("Paycheck, Acme Corp");
		expect(countOf(html)).toMatch(
			/^(Showing 1–25 of \d+|\d+) spending transactions across all months$/,
		);
	});

	it("announces a change of type or account even when the number stays the same", async () => {
		const texts = new Set<string | undefined>();
		for (const query of [
			"month=all&account=4",
			"month=all&account=4&show=spending",
			"month=all&account=4&show=all&category=1",
		]) {
			texts.add(countOf((await get(`/transactions?${query}`)).html));
		}
		expect(texts.size).toBe(3);
	});

	it("keeps the account and type in page links, the row links and Select", async () => {
		const html = (await get("/transactions?month=all&show=spending")).html;
		expect(html).toMatch(
			/href="\/transactions\?month=all&amp;show=spending&amp;page=2"/,
		);
		expect(html).toMatch(
			/href="\/transactions\/\d+\?month=all&amp;show=spending"/,
		);
		expect(html).toMatch(
			/href="\/transactions\?month=all&amp;show=spending&amp;select=1"/,
		);
		const byAccount = (await get("/transactions?month=all&account=3")).html;
		expect(byAccount).toMatch(
			/href="\/transactions\/\d+\?month=all&amp;account=3"/,
		);
	});

	it("gets the empty state, not 'every transaction has a category', when Show or Account narrows a clear Needs category", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 1 WHERE category_id IS NULL",
		).run();
		const done = (await get("/transactions?uncategorized=1")).html;
		expect(done).toContain("Every transaction has a category.");
		for (const query of ["show=spending", "show=excluded", "account=3"]) {
			const { html } = await get(`/transactions?uncategorized=1&${query}`);
			expect(html, query).toContain("No transactions match these filters.");
			expect(html, query).not.toContain("Every transaction has a category.");
		}
	});
});

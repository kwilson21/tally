import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, monthLabel, todayIn } from "../src/dates";
import { saveAiSwitches } from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";
import { SHOW_LABELS, SHOWS } from "../src/transactions/filters";
import { FilterSelect } from "../src/views/filter-select";

async function get(path: string, headers: Record<string, string> = {}) {
	const res = await exports.default.fetch(`http://tally.test${path}`, {
		headers,
	});
	return { res, html: await res.text() };
}

async function post(path: string, fields: Record<string, string>) {
	const res = await exports.default.fetch(`http://tally.test${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"HX-Request": "true",
			Origin: "http://tally.test",
		},
		body: new URLSearchParams(fields),
	});
	return { res, html: await res.text() };
}

const rowCount = (html: string) =>
	(html.match(/<li data-transaction=/g) ?? []).length;

/** The aria-live result count's text, without the tags of its tabular figures (#676). */
const countOf = (html: string) =>
	html
		.match(/<p id="result-count"[^>]*>([\s\S]*?)<\/p>/)?.[1]
		?.replace(/<[^>]+>/g, "");

describe("saving a transaction whose category matches its merchant rule", () => {
	it("sets a newly checked rule and recategorizes eligible transactions", async () => {
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name) VALUES ('RULE NEW ROUTE')",
		).run();
		await env.DB.prepare(
			"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (99004, 1, '2026-10-01', -100, 'RULE NEW ROUTE', 'RULE NEW ROUTE', 1, 'jev'), (99005, 1, '2026-10-02', -100, 'RULE NEW ROUTE', 'RULE NEW ROUTE', NULL, NULL)",
		).run();
		const { res } = await post("/transactions/99004", {
			back: "/transactions",
			category: "4",
			always: "1",
			always_was: "0",
			rule_category_was: "",
			merchant: "RULE NEW ROUTE",
			merchant_was: "RULE NEW ROUTE",
			note: "",
			excluded: "0",
			income: "0",
			creditReviewed: "1",
			creditReviewedVisible: "1",
		});
		expect(res.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT default_category_id FROM merchants WHERE raw_name = 'RULE NEW ROUTE'",
			).first(),
		).toEqual({ default_category_id: 4 });
		expect(
			await env.DB.prepare(
				"SELECT category_id FROM transactions WHERE id = 99005",
			).first(),
		).toEqual({ category_id: 4 });
	});

	it("leaves an existing rule alone on an unchecked note-only save", async () => {
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, default_category_id) VALUES ('RULE NOTE ROUTE', 2)",
		).run();
		await env.DB.prepare(
			"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (99006, 1, '2026-10-01', -100, 'RULE NOTE ROUTE', 'RULE NOTE ROUTE', 3, 'user'), (99007, 1, '2026-10-02', -100, 'RULE NOTE ROUTE', 'RULE NOTE ROUTE', 2, 'merchant_rule')",
		).run();
		const { res } = await post("/transactions/99006", {
			back: "/transactions",
			category: "3",
			always_was: "0",
			rule_category_was: "2",
			merchant: "RULE NOTE ROUTE",
			merchant_was: "RULE NOTE ROUTE",
			note: "keep rule",
			excluded: "0",
			income: "0",
			creditReviewed: "1",
			creditReviewedVisible: "1",
		});
		expect(res.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT default_category_id FROM merchants WHERE raw_name = 'RULE NOTE ROUTE'",
			).first(),
		).toEqual({ default_category_id: 2 });
		expect(
			await env.DB.prepare(
				"SELECT category_id FROM transactions WHERE id = 99007",
			).first(),
		).toEqual({ category_id: 2 });
	});

	it("changes the rule to the picked category when a matching rule's tick stays checked (decision 101)", async () => {
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, default_category_id) VALUES ('RULE ROUTE', 1)",
		).run();
		await env.DB.prepare(
			"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (99001, 1, '2026-10-01', -100, 'RULE ROUTE', 'RULE ROUTE', 1, 'merchant_rule'), (99002, 1, '2026-10-02', -100, 'RULE ROUTE', 'RULE ROUTE', 1, 'merchant_rule')",
		).run();
		const { res } = await post("/transactions/99001", {
			back: "/transactions",
			category: "3",
			always: "1",
			always_was: "1",
			rule_category_was: "1",
			merchant: "RULE ROUTE",
			merchant_was: "RULE ROUTE",
			note: "",
			excluded: "0",
			income: "0",
			creditReviewed: "1",
			creditReviewedVisible: "1",
		});
		expect(res.status).toBe(200);
		// The ticked row says "Use this category ... from now on", so the picked category becomes the rule, and the
		// store's other transactions that a person hasn't chosen follow it, as a fresh tick does.
		expect(
			await env.DB.prepare(
				"SELECT default_category_id FROM merchants WHERE raw_name = 'RULE ROUTE'",
			).first(),
		).toEqual({ default_category_id: 3 });
		expect(
			await env.DB.prepare(
				"SELECT category_id, category_source FROM transactions WHERE id = 99001",
			).first(),
		).toEqual({ category_id: 3, category_source: "user" });
		expect(
			await env.DB.prepare(
				"SELECT category_id, category_source FROM transactions WHERE id = 99002",
			).first(),
		).toEqual({ category_id: 3, category_source: "merchant_rule" });
	});

	it("saves unrelated changes when a paused rule has no posted category", async () => {
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, default_category_id) VALUES ('RULE PAUSED ROUTE', 1)",
		).run();
		await env.DB.prepare(
			"UPDATE categories SET archived = 1 WHERE id = 1",
		).run();
		await env.DB.prepare(
			"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (99003, 1, '2026-10-01', -100, 'RULE PAUSED ROUTE', 'RULE PAUSED ROUTE', 1, 'merchant_rule')",
		).run();
		const { res } = await post("/transactions/99003", {
			back: "/transactions",
			category: "",
			always: "1",
			always_was: "1",
			rule_category_was: "1",
			merchant: "RULE PAUSED ROUTE",
			merchant_was: "RULE PAUSED ROUTE",
			note: "paused note",
			excluded: "0",
			income: "0",
			creditReviewed: "1",
			creditReviewedVisible: "1",
		});
		expect(res.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT category_id, note FROM transactions WHERE id = 99003",
			).first(),
		).toEqual({ category_id: 1, note: "paused note" });
		expect(
			await env.DB.prepare(
				"SELECT default_category_id FROM merchants WHERE raw_name = 'RULE PAUSED ROUTE'",
			).first(),
		).toEqual({ default_category_id: 1 });
	});
});

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
	it("ends each row that opens in its arrow, and says Needs category in words (P118 A)", async () => {
		const { html } = await get("/transactions");
		expect(html).toMatch(
			/<a href="\/transactions\/\d+[^"]*" class="[^"]*\brow-opens\b/,
		);
		expect(html).toContain('data-icon="chevron-right"');
		expect(html).toContain("Needs category");
		expect(html).not.toContain("rounded-control bg-band px-2 text-sm text-ink");
	});

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
			// Excluded but still paying the bill, it still counts, in the bill's month (spec §8.5).
			await env.DB.prepare(
				"UPDATE transactions SET excluded=1 WHERE id=905",
			).run();
			const panel = (await get("/transactions/905")).html;
			expect(panel).toContain("Counts in August");
			expect(panel).toContain("It pays a bill, so it counts in the budget.");
			// Unlinked and excluded, it counts nowhere.
			await env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=95").run();
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
		// The count's figure is tabular, and its words ("Needs category") sit outside the span (decision 128, #676).
		expect(html).toMatch(
			/Needs category \(<span class="tabular-nums" id="needs-count">10<\/span>\)/,
		);
		expect(html).toMatch(/Excluded/);
		// Day headings ("Today, Sep 22" or "Sep 21"); which day is newest depends on the seed and today.
		expect(html).toMatch(/<h2[^>]*>(Today, )?[A-Z][a-z]{2} \d{1,2}<\/h2>/);
		expect(rowCount(html)).toBe(25);
	});

	it("filters to what needs a category, with the chip checked", async () => {
		const { html } = await get("/transactions?uncategorized=1");
		expect(rowCount(html)).toBe(10);
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
			/<p id="result-count" aria-live="polite"[^>]*><span class="tabular-nums">10<\/span> transactions needing a category in [A-Z][a-z]+<\/p>/,
		);
		expect(html).toContain(
			'hx-select-oob="#needs-count:innerHTML, #result-count:innerHTML, #organize-link:innerHTML, #add-cash:outerHTML, #select-toggle:outerHTML,',
		);
	});

	it("keeps a hyphenated search's words out of the count's tabular figures, which hold only the number (#676)", async () => {
		const { html } = await get("/transactions?q=sign-in");
		const open = html.match(/<p id="result-count"[^>]*>/)?.[0] ?? "";
		expect(open).not.toContain("tabular-nums");
		const inner =
			html.match(/<p id="result-count"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
		const n = inner.match(/<span class="tabular-nums">(\d+)<\/span>/)?.[1];
		expect(n).toBeDefined();
		expect(countOf(html)?.replaceAll("&quot;", '"')).toMatch(
			new RegExp(`^${n} transactions matching "sign-in" in [A-Z][a-z]+$`),
		);
		expect(inner).toContain(
			`<span class="tabular-nums">${n}</span> transactions matching &quot;sign-in&quot;`,
		);
		const tabular = [
			...inner.matchAll(/<span class="tabular-nums">([^<]*)<\/span>/g),
		].map((m) => m[1]);
		expect(tabular).toEqual([n]);
	});

	it("names the filters in the count, so two filters with the same count still read differently (#56)", async () => {
		// Every earlier month has three transactions in each category.
		const [y, m] = todayIn(DEFAULT_TIME_ZONE)
			.slice(0, 7)
			.split("-")
			.map(Number) as [number, number];
		const last =
			m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
		const a = countOf(
			(await get(`/transactions?month=${last}&category=1`)).html,
		);
		const b = countOf(
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
		expect(countOf(html)).toMatch(
			/^\d+ transactions in Groceries, all months$/,
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
		// Pinned to October 20 (#322): the Costco split of the 18th and the three Daycare Fridays are in the count, and the
		// Target refund is not (it counts in September with its purchase), 34 in all.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-20T15:00:00Z"));
		try {
			await resetDemo(env.DB, "2026-10-20");
			const first = (await get("/transactions")).html;
			expect(first).toMatch(
				/<p id="result-count"[^>]*>Showing <span class="tabular-nums">1–25 of 34<\/span> transactions in [A-Z][a-z]+<\/p>/,
			);
			expect(first).toMatch(/<nav aria-label="Pages"/);
			expect(first).toContain("Page 1 of 2");
			expect(first).toMatch(
				/<a[^>]*href="\/transactions\?page=2"[^>]*rel="next"[^>]*>Older<\/a>/,
			);
			expect(first).not.toContain(">Newer<");

			const second = (await get("/transactions?page=2")).html;
			expect(rowCount(second)).toBe(9);
			expect(second).toMatch(
				/Showing <span class="tabular-nums">26–34 of 34<\/span> transactions/,
			);
			expect(second).toMatch(
				/<a[^>]*href="\/transactions"[^>]*rel="prev"[^>]*>Newer<\/a>/,
			);
			expect(second).not.toContain(">Older<");
		} finally {
			vi.useRealTimers();
		}
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
		const title =
			html.match(/<h1[^>]*id="transactions-title"[^>]*>/)?.[0] ?? "";
		expect(title).toMatch(/class="[^"]*\bmin-w-0\b[^"]*\bwrap-anywhere\b/);
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

	it("is where Home's band link lands: Organize, and the Needs category filter lists the 10", async () => {
		const home = (await get("/")).html;
		const href = home.match(/href="(\/transactions\/organize)"/)?.[1];
		expect(href).toBe("/transactions/organize");
		expect((await get(href as string)).html).toMatch(/<h1[^>]*>Organize<\/h1>/);
		expect(rowCount((await get("/transactions?uncategorized=1")).html)).toBe(
			10,
		);
	});
});

// The Account and Show choices (#210, spec §8.4; P63 A and P64 B).
describe("GET /transactions: a search looks in every month (#211)", () => {
	const today = todayIn(DEFAULT_TIME_ZONE);
	const THIS = today.slice(0, 7);
	const THIS_NAME = monthLabel(THIS, today);
	const [year, monthNumber] = THIS.split("-").map(Number) as [number, number];
	const LAST =
		monthNumber === 1
			? `${year - 1}-12`
			: `${year}-${String(monthNumber - 1).padStart(2, "0")}`;
	/** htmx's headers for a request made from the page at `from`. */
	const fromPage = (from: string) => ({
		"HX-Request": "true",
		"HX-Current-URL": `http://tally.test${from}`,
	});
	/** The count's text, with the quotes Hono escapes put back. */
	const countText = (html: string) => countOf(html)?.replaceAll("&quot;", '"');
	/** The transaction ids in the list, in order. */
	const rowIds = (html: string) =>
		[...html.matchAll(/<li data-transaction="(\d+)"/g)].map((m) =>
			Number(m[1]),
		);
	const selectedMonth = (html: string) =>
		optionsOf(html, "month").find((option) => option.selected)?.value;
	/** The "Only …" link under the count, as its text and address. */
	const onlyLink = (html: string) => {
		const match = html.match(/<a ([^>]*)>(Only [^<]+)<\/a>/);
		return match
			? {
					text: match[2],
					href: /href="([^"]*)"/
						.exec(match[1] ?? "")?.[1]
						?.replaceAll("&amp;", "&"),
				}
			: null;
	};

	it("looks in every month for a search typed into an empty box on this month, and says so", async () => {
		const { res, html } = await get(
			`/transactions?q=trader&month=${THIS}`,
			fromPage("/transactions"),
		);
		expect(countText(html)).toMatch(
			/^\d+ transactions? matching "trader" in all months$/,
		);
		expect(selectedMonth(html)).toBe("all");
		// The address names the month the list shows, so a reload shows the same list.
		expect(res.headers.get("HX-Push-Url")).toBe(
			"/transactions?q=trader&month=all",
		);
		expect(onlyLink(html)).toEqual({
			text: `Only ${THIS_NAME}`,
			href: "/transactions?q=trader",
		});
	});

	it("keeps the other parts of the address when it changes the month", async () => {
		const { res } = await get(
			`/transactions?q=trader&month=${THIS}&select=1`,
			fromPage("/transactions"),
		);
		expect(res.headers.get("HX-Push-Url")).toBe(
			"/transactions?q=trader&month=all&select=1",
		);
	});

	it("keeps the month a search names once it has text, so a month picked while typing stays", async () => {
		const { res, html } = await get(
			`/transactions?q=trader&month=${LAST}`,
			fromPage("/transactions?q=trad&month=all"),
		);
		expect(countText(html)).toMatch(
			new RegExp(
				`^\\d+ transactions? matching "trader" in ${monthLabel(LAST, today)}$`,
			),
		);
		expect(selectedMonth(html)).toBe(LAST);
		expect(res.headers.get("HX-Push-Url")).toBeNull();
		expect(onlyLink(html)).toBeNull();
	});

	it("keeps a month picked earlier, even this month, when typing starts from an empty box (#211)", async () => {
		// The address after picking September and then October, which is this month.
		const { res, html } = await get(
			`/transactions?q=costco&month=${THIS}`,
			fromPage(`/transactions?q=&month=${THIS}`),
		);
		expect(countText(html)).toMatch(new RegExp(`in ${THIS_NAME}$`));
		expect(selectedMonth(html)).toBe(THIS);
		expect(res.headers.get("HX-Push-Url")).toBeNull();
	});

	it("leaves this month out of the address when no month was picked, so typing from an empty box looks in every month", async () => {
		// A category picked from the default list: the form sends this month, which the address leaves out.
		const { res } = await get(
			`/transactions?category=1&month=${THIS}`,
			fromPage("/transactions"),
		);
		expect(res.headers.get("HX-Push-Url")).toBe("/transactions?category=1");
		const { html } = await get(
			`/transactions?q=trader&month=${THIS}&category=1`,
			fromPage("/transactions?category=1"),
		);
		expect(selectedMonth(html)).toBe("all");
	});

	it("narrows to this month when the Only link is followed, and drops the link", async () => {
		const { html } = await get(
			`/transactions?q=trader&month=${THIS}`,
			fromPage("/transactions?q=trader&month=all"),
		);
		expect(countText(html)).toMatch(new RegExp(`in ${THIS_NAME}$`));
		expect(selectedMonth(html)).toBe(THIS);
		expect(onlyLink(html)).toBeNull();
	});

	it("goes back to this month when the search box is emptied", async () => {
		const { res, html } = await get(
			`/transactions?month=${LAST}`,
			fromPage("/transactions?q=trader&month=all"),
		);
		expect(countText(html)).toMatch(new RegExp(`in ${THIS_NAME}$`));
		expect(selectedMonth(html)).toBe(THIS);
		expect(res.headers.get("HX-Push-Url")).toBe("/transactions");
	});

	it("pushes an address without the saved row's focus or its save time", async () => {
		// A Likely sheet's close after a save: the list it returns to names the saved row and when, and the address it
		// pushes is the clean one, the same as the close's own back address.
		const { res } = await get(
			`/transactions?focus=1&saved=1&saved-at=${Date.now()}&month=${LAST}`,
			fromPage("/transactions?q=trader&month=all"),
		);
		expect(res.headers.get("HX-Push-Url")).toBe("/transactions");
	});

	it("keeps All months for a category picked when no search was typed", async () => {
		const { res, html } = await get(
			"/transactions?month=all&category=1",
			fromPage("/transactions?month=all"),
		);
		expect(countText(html)).toMatch(
			/^\d+ transactions? in Groceries, all months$/,
		);
		expect(selectedMonth(html)).toBe("all");
		expect(res.headers.get("HX-Push-Url")).toBeNull();
		expect(onlyLink(html)).toBeNull();
	});

	it("uses the month the address names when there is no page to come from (a reload or no JavaScript)", async () => {
		const { res, html } = await get(`/transactions?q=trader&month=${THIS}`);
		expect(countText(html)).toMatch(new RegExp(`in ${THIS_NAME}$`));
		expect(selectedMonth(html)).toBe(THIS);
		expect(res.headers.get("HX-Push-Url")).toBeNull();
		expect(onlyLink(html)).toBeNull();
	});

	it("offers Only this month under the count only while a search runs in every month", async () => {
		const { html } = await get(
			"/transactions?month=all",
			fromPage("/transactions?month=all"),
		);
		expect(onlyLink(html)).toBeNull();
		expect(countText(html)).toMatch(/ in all months$/);
	});

	it("replaces the Month choice out of band, so it shows the month the list shows", async () => {
		const { html } = await get("/transactions");
		expect(html).toContain("#month:outerHTML");
		expect(html).not.toContain("#month:innerHTML");
	});

	it("sends Only October with a count-focus marker, and pushes the clean address", async () => {
		const { html } = await get(
			"/transactions?q=trader&month=all",
			fromPage("/transactions?q=trader&month=all"),
		);
		const link = html.match(/<a ([^>]*)>Only [^<]+<\/a>/)?.[1] ?? "";
		expect(link).toContain("focus=count");
		expect(link).toContain('hx-push-url="/transactions?q=trader"');
		expect(link).toContain("#result-count:outerHTML");
	});

	it("moves focus to the count when Only October asks for it, and not otherwise", async () => {
		const { html } = await get(
			`/transactions?q=trader&month=${THIS}&focus=count`,
			fromPage("/transactions?q=trader&month=all"),
		);
		expect(html).toMatch(
			/<p id="result-count"[^>]*tabindex="-1"[^>]*autofocus/,
		);
		const plain = (
			await get(
				`/transactions?q=trader&month=${THIS}`,
				fromPage("/transactions?q=trader&month=all"),
			)
		).html;
		expect(plain).not.toMatch(/<p id="result-count"[^>]*autofocus/);
	});

	it("names no amount when a plain number matched a name as well as an amount, and names the amount when it matched only amounts (#211)", async () => {
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id) VALUES (99330, 1, '${THIS}-01', -1000, 'STORE 42 CAFE', 1)`,
			),
			env.DB.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id) VALUES (99331, 1, '${THIS}-02', -4250, 'BIG PURCHASE', 1)`,
			),
		]);
		const mixed = await get(
			`/transactions?q=42&month=${THIS}`,
			fromPage("/transactions"),
		);
		// Typed into an empty box on this month, so every month is searched. The demo's own rows may match
		// too, so only the note is pinned: no amount, since STORE 42 CAFE matched by its name.
		expect(countText(mixed.html)).toMatch(
			/^\d+ transactions matching "42" in all months$/,
		);
		// A number the demo's rows don't use: when only its amount matches, the count names the amount.
		await env.DB.prepare(
			`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id) VALUES (99332, 1, '${THIS}-03', -913750, 'NINE ROW', 1)`,
		).run();
		const amountsOnly = await get(
			`/transactions?q=9137&month=${THIS}`,
			fromPage("/transactions"),
		);
		expect(countText(amountsOnly.html)).toBe(
			'1 transaction matching "9137" (amounts $9,137.00 to $9,137.99) in all months',
		);
	});

	it("says (category) only when a row in that category matched, not when a merchant's name does", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO categories (id, name, icon, color, sort_order) VALUES (99310, 'Zebra Care', 'gas', 'cat-slate', 99)",
			),
			env.DB.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id) VALUES (99311, 1, '${THIS}-01', -1200, 'ZEBRA SHOP', 1)`,
			),
		]);
		const merchantOnly = await get(
			"/transactions?q=zebra&month=all",
			fromPage("/transactions?q=zebra&month=all"),
		);
		expect(countText(merchantOnly.html)).toBe(
			'1 transaction matching "zebra" in all months',
		);
		await env.DB.prepare(
			`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id) VALUES (99312, 1, '${THIS}-02', -1300, 'NOT THE NAME', 99310)`,
		).run();
		const byCategory = await get(
			"/transactions?q=zebra&month=all",
			fromPage("/transactions?q=zebra&month=all"),
		);
		expect(countText(byCategory.html)).toBe(
			'2 transactions matching "zebra" (category) in all months',
		);
		await env.DB.prepare(
			"UPDATE categories SET archived = 1 WHERE id = 99310",
		).run();
		const archived = await get(
			"/transactions?q=zebra&month=all",
			fromPage("/transactions?q=zebra&month=all"),
		);
		expect(countText(archived.html)).toBe(
			'2 transactions matching "zebra" (category) in all months',
		);
	});

	it("finds September's Costco rows from October's empty box, and Only October narrows to October's", async () => {
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id) VALUES (99320, 1, '${THIS}-02', -4111, 'COSTCO ROWTEST OCT', 1)`,
			),
			env.DB.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id) VALUES (99321, 1, '${LAST}-02', -4222, 'COSTCO ROWTEST SEP', 1)`,
			),
		]);
		const everyMonth = await get(
			`/transactions?q=costco&month=${THIS}`,
			fromPage("/transactions"),
		);
		expect(rowIds(everyMonth.html)).toEqual(
			expect.arrayContaining([99320, 99321]),
		);
		const onlyOctober = await get(
			`/transactions?q=costco&month=${THIS}`,
			fromPage("/transactions?q=costco&month=all"),
		);
		expect(rowIds(onlyOctober.html)).toContain(99320);
		expect(rowIds(onlyOctober.html)).not.toContain(99321);
	});

	it("searches only the notes a row shows: a guessed note hidden by the details switch doesn't match (#314)", async () => {
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, note, note_guessed) VALUES (99340, 1, '${THIS}-05', -2500, 'TARGET 00412', 1, 'Birthday gift', 1)`,
			),
			env.DB.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, note, note_guessed) VALUES (99341, 1, '${THIS}-05', -2600, 'TARGET 00413', 1, 'Birthday kept', 0)`,
			),
		]);
		const search = `/transactions?q=birthday&month=${THIS}`;
		await saveAiSwitches(env.DB, { details: false });
		const hidden = await get(search);
		expect(rowIds(hidden.html)).not.toContain(99340);
		expect(rowIds(hidden.html)).toContain(99341);
		await saveAiSwitches(env.DB, { details: true });
		const shown = await get(search);
		expect(rowIds(shown.html)).toContain(99340);
		expect(rowIds(shown.html)).toContain(99341);
	});
});

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
		expect(countOf(html)).toMatch(/in Credit card ••9012, all months$/);
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
			"1 transaction in Checking ••1234 (Second Bank), all months",
		);
		expect(html).toMatch(/second bank coffee/i);
		const first = (await get("/transactions?month=all&account=1")).html;
		expect(countOf(first)).toMatch(
			/in Checking ••1234 \(First Harbor Bank\), all months$/,
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
					`<select id="${id}" name="${id}" class="min-h-11 w-full max-w-full appearance-none truncate rounded-full border border-rule bg-paper pl-4 pr-10 text-base text-ink">`,
				),
			);
		}
	});

	it("lists only that account's rows and the count names it", async () => {
		const { html } = await get("/transactions?month=all&account=4");
		expect(rowCount(html)).toBe(1);
		expect(html).toContain("Farmers market");
		expect(countOf(html)).toBe("1 transaction in Cash, all months");
		expect(optionsOf(html, "account").find((o) => o.selected)?.value).toBe("4");

		const card = (await get("/transactions?account=3")).html;
		expect(countOf(card)).toMatch(
			/^\d+ transactions in Credit card ••9012, [A-Z][a-z]+( \d{4})?$/,
		);
		expect(card).not.toContain("Farmers market");
	});

	it("names the category and the account together", async () => {
		const { html } = await get("/transactions?month=all&account=4&category=1");
		expect(countOf(html)).toBe("1 transaction in Groceries, Cash, all months");
	});

	it("says so for an account that isn't there, still announcing it", async () => {
		const { html } = await get("/transactions?account=999");
		expect(countOf(html)).toMatch(/^0 transactions in account 999, /);
		expect(html).toContain("No transactions match these filters.");
		// The choice shows the filter the list is using, not "All accounts".
		const choice = html.slice(
			html.indexOf('<select id="account"'),
			html.indexOf("</select>", html.indexOf('<select id="account"')),
		);
		expect(choice).toMatch(
			/<option value="999" selected[^>]*>account 999<\/option>/,
		);
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
				`^(Showing 1–25 of \\d+|${n}) income transactions in all months$`,
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
		expect(countOf(html)).toMatch(/refund transactions in all months$/);
	});

	it("Show Spending names the type and leaves out income", async () => {
		const { html } = await get("/transactions?month=all&show=spending");
		expect(html).not.toContain("Paycheck, Acme Corp");
		expect(countOf(html)).toMatch(
			/^(Showing 1–25 of \d+|\d+) spending transactions in all months$/,
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

// P124 A (decision 111): How this works is at the foot of the list, under a short rule, after the results and the pager.
describe("How this works at the foot of Transactions", () => {
	const FOOT =
		/<div class="mt-8"><div class="w-12 border-t border-muted"><\/div><div class="mt-2"><a href="\/how-it-works#transactions" aria-label="How this works: transactions" class="[^"]*">How this works<\/a><\/div><\/div>/;

	beforeEach(async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	});

	it.each([
		["the list", "/transactions"],
		["Select mode", "/transactions?select=1"],
	])(
		"is the last thing on the list page, after the rows and pager, in %s",
		async (_, path) => {
			const { html } = await get(path);
			const foot = html.search(FOOT);
			expect(foot).toBeGreaterThan(html.indexOf('aria-label="Results"'));
			// Nothing opens after it before the sheet, but the keys' details on desktop (decision 118, not a section).
			expect(
				html
					.slice(foot, html.indexOf('id="sheet"'))
					.replace(
						/<div class="mt-2 hidden lg:block">[\s\S]*?<\/details><\/div>/,
						"",
					),
			).not.toMatch(/<(section|ul|li|h[1-6]|p|form)\b/);
		},
	);

	// In Select mode it comes after the selection bar, inside the form's bottom padding, so the fixed bar never covers it.
	it("sits after the selection bar, inside the Select form, so Tab order and the bar stay as they are", async () => {
		const { html } = await get("/transactions?select=1");
		const foot = html.search(FOOT);
		expect(foot).toBeGreaterThan(html.indexOf('id="selection-bar"'));
		expect(html.slice(foot, html.indexOf('id="sheet"'))).toContain("</form>");
	});
});

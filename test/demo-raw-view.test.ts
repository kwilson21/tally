import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { transactions } from "../src/routes/transactions";

// The demo's "See it without AI" (spec §8.6, decisions 68, 73, 79; P44 A): two links under the
// Transactions title switch the list between what Tally made of it and the bank's raw data (?raw=1).
// Only the list changes. The family app shows no links and ignores ?raw=1.

const family = { ...env, DEMO: "false" } as unknown as Env;

async function demo(path: string) {
	const res = await exports.default.fetch(`http://tally.test${path}`);
	return { res, html: await res.text() };
}

async function familyApp(path: string) {
	const res = await transactions.request(path, {}, family);
	return { res, html: await res.text() };
}

/** Each listed transaction: its id and the markup of its row. */
const rowsOf = (html: string) =>
	[...html.matchAll(/<li data-transaction="(\d+)">([\s\S]*?)<\/li>/g)].map(
		(m) => ({ id: Number(m[1]), html: m[2] ?? "" }),
	);

/** The text a person reads in a piece of markup. */
const textOf = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&")
		.replace(/\s+/g, " ")
		.trim();

/** The aria-live result count's text. */
const countOf = (html: string) =>
	textOf(html.match(/<p id="result-count"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "");

const viewNav = (html: string) =>
	html.match(/<nav[^>]*aria-label="View"[^>]*>[\s\S]*?<\/nav>/)?.[0];

const linkIn = (nav: string, words: string) =>
	[...nav.matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)]
		.map((m) => m[0])
		.find((a) => textOf(a) === words);

const NOTE =
	"No clean names or categories, and the transfer to Savings and the paycheck both count in Spent.";

/**
 * Two rows as a sync leaves them when Plaid's own categories decided something (spec §8.5): a paycheck
 * Plaid marked as income, and a transfer Plaid marked and left out of the budget.
 */
async function addPlaidMarked() {
	const today = todayIn(DEFAULT_TIME_ZONE);
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, plaid_category, flag_income)
			 SELECT 9001, id, ?, -300000, 'PLAID PAYROLL 0412', 'INCOME', 1 FROM accounts LIMIT 1`,
		).bind(today),
		env.DB.prepare(
			`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, plaid_category, flag_transfer, excluded, excluded_source)
			 SELECT 9002, id, ?, 12000, 'PLAID XFER OUT 7731', 'TRANSFER_OUT', 1, 1, 'plaid' FROM accounts LIMIT 1`,
		).bind(today),
	]);
}

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
});

describe("the list, straight from the bank (?raw=1, in the demo)", () => {
	it("counts the split purchase parent once: 38 transactions, not 37", async () => {
		const { html: raw } = await demo("/transactions?raw=1");
		expect(countOf(raw)).toMatch(
			/^Showing 1–25 of 38 transactions in [A-Z][a-z]+, as the bank sends them$/,
		);
		const month = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		const { html: normal } = await demo(`/transactions?month=${month}`);
		expect(countOf(normal)).toMatch(/^Showing 1–25 of 39 transactions in /);
	});

	it("shows a split purchase once as the bank sent it and counts it once", async () => {
		const seed = await env.DB.prepare(
			"SELECT id, amount_cents FROM transactions WHERE parent_id IS NULL AND is_split = 1 AND raw_name = 'COSTCO WHSE #0431' AND amount_cents = 18742",
		).first<{ id: number; amount_cents: number }>();
		expect(seed).toBeDefined();
		const parts = await env.DB.prepare(
			"SELECT id FROM transactions WHERE parent_id = ?",
		)
			.bind(seed?.id)
			.all<{ id: number }>();
		const realTotal = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE parent_id IS NULL",
		).first<{ n: number }>();
		const month = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		const raw = await demo(
			`/transactions?raw=1&month=${month}&q=COSTCO+WHSE+%230431`,
		);
		const rows = rowsOf(raw.html);
		const seedRows = rows.filter((row) => row.id === seed?.id);
		expect(seedRows).toHaveLength(1);
		expect(textOf(seedRows[0]?.html ?? "")).toContain("COSTCO WHSE #0431");
		expect(textOf(seedRows[0]?.html ?? "")).toContain("$187.42");
		expect(
			parts.results.every((part) => !rows.some((row) => row.id === part.id)),
		).toBe(true);
		const normalMonth = await demo(
			`/transactions?month=${month}&show=spending&q=COSTCO+WHSE+%230431`,
		);
		const normalRows = rowsOf(normalMonth.html);
		expect(normalRows.some((row) => row.id === seed?.id)).toBe(false);
		expect(
			parts.results.every((part) =>
				normalRows.some((row) => row.id === part.id),
			),
		).toBe(true);
		const normalCostco = await demo(
			`/transactions?month=${month}&show=spending&q=COSTCO+WHSE`,
		);
		expect(countOf(normalCostco.html)).toContain(
			"2 spending transactions matching",
		);
		const full = await demo("/transactions?raw=1&month=all");
		expect(countOf(full.html)).toContain(`of ${realTotal?.n} transactions`);
	});

	it("applies raw filters to the split parent and normal filters to its parts", async () => {
		const parent = await env.DB.prepare(
			"SELECT id FROM transactions WHERE parent_id IS NULL AND is_split = 1 AND raw_name = 'COSTCO WHSE #0431' AND amount_cents = 18742",
		).first<{ id: number }>();
		expect(parent).toBeDefined();
		const parts = await env.DB.prepare(
			"SELECT id FROM transactions WHERE parent_id = ?",
		)
			.bind(parent?.id)
			.all<{ id: number }>();
		await env.DB.prepare(
			"UPDATE transactions SET category_id = NULL WHERE id = ? OR parent_id = ?",
		)
			.bind(parent?.id, parent?.id)
			.run();
		const emptyParent = await env.DB.prepare(
			"SELECT category_id AS categoryId FROM transactions WHERE id = ?",
		)
			.bind(parent?.id)
			.first<{ categoryId: number | null }>();
		expect(emptyParent?.categoryId).toBeNull();
		expect(parts.results).toHaveLength(2);
		const query = `&month=${todayIn(DEFAULT_TIME_ZONE).slice(0, 7)}&q=COSTCO+WHSE+%230431`;
		const assertRawParent = async (filter: string) => {
			const { html } = await demo(`/transactions?raw=1${filter}${query}`);
			const rows = rowsOf(html);
			expect(rows.map((row) => row.id)).toEqual([parent?.id]);
			expect(textOf(rows[0]?.html ?? "")).toContain("$187.42");
			expect(countOf(html)).toMatch(/(?:^|\D)1 (?:spending )?transaction/);
		};
		const assertNormalParts = async (filter: string) => {
			const { html } = await demo(`/transactions?${filter}${query}`);
			const rows = rowsOf(html);
			expect(rows.some((row) => row.id === parent?.id)).toBe(false);
			expect(
				parts.results.every((part) => rows.some((row) => row.id === part.id)),
			).toBe(true);
			expect(countOf(html)).toContain(
				`${parts.results.length} spending transactions matching`,
			);
		};

		await assertRawParent("&show=spending");
		await assertNormalParts("show=spending");

		// The parent is uncategorized in the bank row; make its parts uncategorized too so the normal
		// Needs category view can verify that it continues to list the parts.
		await assertRawParent("&uncategorized=1");
		{
			const { html } = await demo(`/transactions?uncategorized=1${query}`);
			const rows = rowsOf(html);
			expect(rows.some((row) => row.id === parent?.id)).toBe(false);
			expect(
				parts.results.every((part) => rows.some((row) => row.id === part.id)),
			).toBe(true);
			expect(countOf(html)).toContain(
				`${parts.results.length} transactions needing a category matching`,
			);
		}

		const category = await env.DB.prepare(
			"SELECT id FROM categories ORDER BY id LIMIT 1",
		).first<{ id: number }>();
		await env.DB.prepare(
			"UPDATE transactions SET category_id = ? WHERE id = ? OR parent_id = ?",
		)
			.bind(category?.id, parent?.id, parent?.id)
			.run();
		await assertRawParent(`&category=${category?.id}`);
		{
			const { html } = await demo(
				`/transactions?category=${category?.id}${query}`,
			);
			const rows = rowsOf(html);
			expect(rows.some((row) => row.id === parent?.id)).toBe(false);
			expect(
				parts.results.every((part) => rows.some((row) => row.id === part.id)),
			).toBe(true);
			expect(countOf(html)).toContain(
				`${parts.results.length} transactions matching`,
			);
		}
	});

	it("does not show a person's note", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET note = 'private note' WHERE id = 1",
		).run();
		expect(
			(await demo("/transactions?raw=1&month=all&q=AMAZON")).html,
		).not.toContain("private note");
	});

	it("lists each transaction under the bank's own text with no category and no Excluded or income mark", async () => {
		const { html } = await demo("/transactions?raw=1");
		const rows = rowsOf(html);
		expect(rows.length).toBeGreaterThan(10);
		for (const row of rows) {
			const raw = await env.DB.prepare(
				"SELECT raw_name FROM transactions WHERE id = ?",
			)
				.bind(row.id)
				.first<{ raw_name: string }>();
			const words = textOf(row.html);
			expect(words, `row ${row.id}`).toContain(raw?.raw_name);
			// Every row says Needs category, the paycheck too.
			expect(words, `row ${row.id}`).toContain("Needs category");
			expect(words, `row ${row.id}`).not.toContain("Excluded");
			expect(words, `row ${row.id}`).not.toContain("Income");
			expect(words, `row ${row.id}`).not.toContain("Split");
		}
	});

	it("shows the transfer to Savings and the paycheck as spending would look", async () => {
		const transfer = rowsOf(
			(await demo("/transactions?raw=1&month=all&q=ONLINE+TRANSFER")).html,
		);
		expect(transfer.length).toBeGreaterThan(0);
		for (const row of transfer) {
			const words = textOf(row.html);
			expect(words).toContain("ONLINE TRANSFER TO SAV ...5678");
			expect(words).toContain("Needs category");
			expect(words).not.toContain("Transfer to Savings");
			expect(words).not.toContain("Excluded");
		}
		const pay = rowsOf(
			(await demo("/transactions?raw=1&month=all&q=ACME+CORP+PAYROLL")).html,
		);
		expect(pay.length).toBeGreaterThan(0);
		for (const row of pay) {
			const words = textOf(row.html);
			expect(words).toContain("ACME CORP PAYROLL");
			expect(words).toContain("Needs category");
			expect(words).not.toContain("Paycheck, Acme Corp");
			expect(words).not.toContain("Income");
		}
	});

	it("shows the transfer in the Excluded filter as bank text without its mark", async () => {
		const { html } = await demo(
			"/transactions?raw=1&month=all&show=excluded&q=ONLINE+TRANSFER",
		);
		const rows = rowsOf(html);
		expect(rows.length).toBeGreaterThan(0);
		expect(textOf(rows[0]?.html ?? "")).toContain(
			"ONLINE TRANSFER TO SAV ...5678",
		);
		expect(textOf(rows[0]?.html ?? "")).not.toContain("Excluded");
	});

	it("takes away what Plaid marked at sync too", async () => {
		await addPlaidMarked();
		// As today, Tally shows those marks.
		const made = rowsOf((await demo("/transactions?q=PLAID")).html);
		expect(made.map((r) => r.id).sort()).toEqual([9001, 9002]);
		expect(textOf(made.find((r) => r.id === 9001)?.html ?? "")).toContain(
			"Income",
		);
		expect(textOf(made.find((r) => r.id === 9002)?.html ?? "")).toContain(
			"Excluded",
		);
		// Straight from the bank, they are bank text with Needs category.
		const raw = rowsOf((await demo("/transactions?raw=1&q=PLAID")).html);
		expect(raw.map((r) => r.id).sort()).toEqual([9001, 9002]);
		const pay = textOf(raw.find((r) => r.id === 9001)?.html ?? "");
		const out = textOf(raw.find((r) => r.id === 9002)?.html ?? "");
		expect(pay).toContain("PLAID PAYROLL 0412");
		expect(out).toContain("PLAID XFER OUT 7731");
		for (const words of [pay, out]) {
			expect(words).toContain("Needs category");
			expect(words).not.toContain("Income");
			expect(words).not.toContain("Excluded");
		}
	});

	it("shows a categorized transaction without its category", async () => {
		const row = rowsOf(
			(await demo("/transactions?raw=1&month=all&q=TRADER+JOE")).html,
		)[0];
		const words = textOf(row?.html ?? "");
		expect(words).toContain("TRADER JOE'S #552");
		expect(words).not.toContain("Groceries");
		expect(words).toContain("Needs category");
	});

	it("without ?raw=1 the list is as today", async () => {
		await addPlaidMarked();
		const transfer = rowsOf(
			(await demo("/transactions?month=all&q=ONLINE+TRANSFER")).html,
		);
		expect(transfer.length).toBeGreaterThan(0);
		for (const row of transfer) {
			const words = textOf(row.html);
			expect(words).toContain("Transfer to Savings");
			expect(words).toContain("Excluded");
			expect(words).not.toContain("ONLINE TRANSFER TO SAV");
		}
		const joes = rowsOf(
			(await demo("/transactions?month=all&q=TRADER+JOE")).html,
		);
		expect(textOf(joes[0]?.html ?? "")).toContain("Groceries");
		const { html } = await demo("/transactions");
		expect(countOf(html)).not.toContain("as the bank sends them");
		expect(html).not.toContain(NOTE);
	});

	it("says it is as the bank sends them, then why the numbers differ, under the count", async () => {
		const raw = (await demo("/transactions?raw=1")).html;
		expect(countOf(raw)).toMatch(
			/^(Showing 1–25 of \d+|\d+) transactions? in [A-Z][a-z]+, as the bank sends them$/,
		);
		// The count is the live region, so the swap is announced; the one muted line follows it.
		expect(raw).toMatch(/<p id="result-count"[^>]*aria-live="polite"/);
		const afterCount = raw.split('id="result-count"')[1] ?? "";
		expect(textOf(afterCount.slice(0, afterCount.indexOf("<ul")))).toContain(
			NOTE,
		);
		expect(raw.match(/as the bank sends them/g)).toHaveLength(1);
		expect(raw.split(NOTE)).toHaveLength(2);
	});

	it("is the same list as today, the same rows in the same order", async () => {
		// One merchant over every month, so the whole list fits on a page.
		const made = rowsOf(
			(await demo("/transactions?month=all&q=COSTCO+WHSE")).html,
		);
		const raw = rowsOf(
			(await demo("/transactions?raw=1&month=all&q=COSTCO+WHSE")).html,
		);
		// Each split's parts are replaced by their bank transaction in the raw view.
		const splits = await env.DB.prepare(
			"SELECT id, parent_id AS parentId FROM transactions WHERE parent_id IS NOT NULL",
		).all<{ id: number; parentId: number }>();
		const parentByPart = new Map(
			splits.results.map((part) => [part.id, part.parentId]),
		);
		expect(parentByPart.size).toBeGreaterThan(0);
		expect(made.some((row) => parentByPart.has(row.id))).toBe(true);
		expect(new Set(raw.map((row) => row.id))).toEqual(
			new Set(made.map((row) => parentByPart.get(row.id) ?? row.id)),
		);
	});

	it("keeps ?raw=1 across the list's own links: filters, paging, Select and each row", async () => {
		const { html } = await demo("/transactions?raw=1&month=all");
		// The filter form sends it with every change, with or without htmx.
		expect(html).toMatch(
			/<form id="filters"[\s\S]*?<input type="hidden" name="raw" value="1"[^>]*\/?>/,
		);
		// Paging.
		expect(html).toMatch(
			/<a href="\/transactions\?[^"]*raw=1[^"]*"[^>]*>Older/,
		);
		expect(html).toMatch(/hx-get="\/transactions\?[^"]*raw=1[^"]*"/);
		const pageTwo = await demo("/transactions?raw=1&month=all&page=2");
		const rawTotal = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE parent_id IS NULL",
		).first<{ n: number }>();
		expect(countOf(pageTwo.html)).toContain(
			`of ${rawTotal?.n} transactions across all months`,
		);
		expect(rowsOf(pageTwo.html)).toHaveLength(25);
		// Select, and a row's edit panel.
		expect(html).toMatch(
			/href="\/transactions\?month=all&amp;raw=1&amp;select=1" id="select-toggle"/,
		);
		expect(rowsOf(html)[0]?.html).toMatch(
			/href="\/transactions\/\d+\?[^"]*raw=1"/,
		);
		// Without it, none of them carry it; only the link to the bank's view does.
		const made = (await demo("/transactions?month=all")).html;
		expect(made.replace(viewNav(made) ?? "", "")).not.toContain("raw=1");
	});

	it("keeps the list straight from the bank behind an open edit panel, and back from it", async () => {
		const { html } = await demo("/transactions/5?raw=1");
		const rows = rowsOf(html);
		expect(rows.length).toBeGreaterThan(10);
		for (const row of rows)
			expect(textOf(row.html), `row ${row.id}`).toContain("Needs category");
		expect(html).toMatch(/<a [^>]*href="\/transactions\?raw=1"[^>]*>Cancel</);
	});
});

describe("the two links under the title", () => {
	it("are named Tidied by Tally and Straight from the bank, 44px tall, in a nav labelled View", async () => {
		const { html } = await demo("/transactions");
		const nav = viewNav(html);
		expect(nav).toBeDefined();
		const links = [...(nav ?? "").matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map(
			(m) => m[0],
		);
		expect(links.map(textOf)).toEqual([
			"Tidied by Tally",
			"Straight from the bank",
		]);
		for (const link of links) expect(link).toContain("min-h-11");
		// The dot between them is for the eye only.
		expect(nav).toMatch(/<span[^>]*aria-hidden="true"[^>]*>\s*·\s*<\/span>/);
		// Under the Transactions title, before the filters.
		expect(html.indexOf("Transactions</h1>")).toBeLessThan(
			html.indexOf('aria-label="View"'),
		);
		expect(html.indexOf('aria-label="View"')).toBeLessThan(
			html.indexOf('id="filters"'),
		);
	});

	it("mark Tidied by Tally as the current one on the normal list: ink, semibold, not underlined", async () => {
		const nav = viewNav((await demo("/transactions")).html) ?? "";
		const tidied = linkIn(nav, "Tidied by Tally") ?? "";
		const bank = linkIn(nav, "Straight from the bank") ?? "";
		expect(tidied).toContain('aria-current="page"');
		expect(tidied).toContain("text-ink");
		expect(tidied).toContain("font-semibold");
		expect(tidied).toContain("no-underline");
		expect(bank).not.toContain("aria-current");
		// The other one is an ordinary terracotta link.
		expect(bank).not.toContain("text-ink");
		expect(bank).not.toContain("no-underline");
		expect(tidied).toContain('href="/transactions"');
		expect(bank).toContain('href="/transactions?raw=1"');
	});

	it("mark Straight from the bank as the current one on ?raw=1", async () => {
		const nav = viewNav((await demo("/transactions?raw=1")).html) ?? "";
		const tidied = linkIn(nav, "Tidied by Tally") ?? "";
		const bank = linkIn(nav, "Straight from the bank") ?? "";
		expect(bank).toContain('aria-current="page"');
		expect(bank).toContain("font-semibold");
		expect(tidied).not.toContain("aria-current");
		expect(tidied).toContain('href="/transactions"');
	});

	it("keep the filters when switching, and start again at the first page", async () => {
		const nav =
			viewNav(
				(await demo("/transactions?month=all&q=ONLINE&page=2&select=1")).html,
			) ?? "";
		expect(linkIn(nav, "Straight from the bank")).toContain(
			'href="/transactions?q=ONLINE&amp;month=all&amp;raw=1"',
		);
		const back =
			viewNav(
				(await demo("/transactions?raw=1&month=all&q=ONLINE&show=excluded"))
					.html,
			) ?? "";
		expect(linkIn(back, "Tidied by Tally")).toContain(
			'href="/transactions?q=ONLINE&amp;month=all&amp;show=excluded"',
		);
	});

	it("are plain links: no script, and they follow a filter change out of band", async () => {
		const { html } = await demo("/transactions?raw=1");
		const nav = viewNav(html) ?? "";
		expect(nav).not.toContain("hx-");
		expect(nav).not.toContain("onclick");
		expect(nav).toContain('id="view-links"');
		// A filter change swaps the links with the rest, so they keep the filters it chose.
		expect(html).toMatch(/hx-select-oob="[^"]*#view-links:outerHTML/);
	});
});

describe("Home", () => {
	it("is the same with and without ?raw=1: its numbers don't change, only the list switches", async () => {
		const plain = await demo("/");
		const raw = await demo("/?raw=1");
		expect(plain.res.status).toBe(200);
		expect(raw.html).toBe(plain.html);
		expect(plain.html).toContain("Safe to spend");
	});
});

describe("the family app", () => {
	it("shows no links and no note", async () => {
		const { res, html } = await familyApp("/transactions");
		expect(res.status).toBe(200);
		expect(html).not.toContain('aria-label="View"');
		expect(html).not.toContain("Tidied by Tally");
		expect(html).not.toContain("Straight from the bank");
		expect(html).not.toContain("as the bank sends them");
		expect(html).not.toContain(NOTE);
	});

	it("ignores ?raw=1: the same page, with Tally's names, categories and marks", async () => {
		const plain = await familyApp("/transactions?month=all&q=ONLINE+TRANSFER");
		const raw = await familyApp(
			"/transactions?month=all&q=ONLINE+TRANSFER&raw=1",
		);
		expect(raw.html).toBe(plain.html);
		expect(raw.html).not.toContain("raw=1");
		const row = rowsOf(raw.html)[0];
		expect(textOf(row?.html ?? "")).toContain("Transfer to Savings");
		expect(textOf(row?.html ?? "")).toContain("Excluded");
		expect(countOf(raw.html)).not.toContain("as the bank sends them");
	});

	it("ignores ?raw=1 in the edit panel's address too", async () => {
		const plain = await familyApp("/transactions/5");
		const raw = await familyApp("/transactions/5?raw=1");
		expect(raw.html).toBe(plain.html);
	});
});

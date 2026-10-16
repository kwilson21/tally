import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { saveAiSwitches } from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";

// The edit panel leads with its category (P120 B, decision 111): the name is the one headline, the category
// is open while it needs one and folds to a row once it's set, and Exclude and Count as income are switches.

const BASE = "http://tally.test";

async function get(path: string) {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
}

async function post(path: string, fields: Record<string, string>) {
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			"HX-Request": "true",
		},
		body: new URLSearchParams(fields).toString(),
	});
	return { res, html: await res.text() };
}

/** The panel from its headline on: the sheet, without the page around it. */
const panelOf = (html: string) => html.slice(html.indexOf('id="edit-title"'));

/** The category block: from its wrapper to the merchant rule tick that follows the choices. */
function categoryBlock(html: string) {
	const start = html.indexOf('id="edit-category"');
	const end = html.indexOf('name="always"', start);
	return html.slice(start, end);
}

/** The Exclude switch's muted line: the text its span holds, from its id to the span's close. */
function excludeHintOf(html: string) {
	const start = html.indexOf(">", html.indexOf('id="edit-exclude-hint"')) + 1;
	return html.slice(start, html.indexOf("</span>", start));
}

/** The whole `<input …>` tag that carries `name`. */
function inputTag(html: string, name: string) {
	const at = html.indexOf(`name="${name}"`);
	const start = html.lastIndexOf("<input", at);
	return html.slice(start, html.indexOf(">", at) + 1);
}

let bakery: number;
beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	await saveAiSwitches(env.DB, { details: false });
	bakery = (
		await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).first<{ id: number }>()
	)?.id as number;
});

/** Local Bakery picked by Tally as Groceries, 92% sure: a categorized transaction. */
async function pickedByTally() {
	await env.DB.prepare(
		"UPDATE transactions SET category_id = (SELECT id FROM categories WHERE name = 'Groceries'), category_source = 'jev', category_confidence = 0.92 WHERE id = ?",
	)
		.bind(bakery)
		.run();
}

/** Local Bakery pays a bill: a linked bill payment, which counts whatever its exclusion. */
async function payBill() {
	await env.DB.prepare(
		"INSERT INTO bills(id,name,amount_cents,due_day,frequency,anchor_month,merchant_raw_name) VALUES(9501,'Power',1200,31,'monthly',NULL,'BAKERY BILL FIXTURE')",
	).run();
	await env.DB.prepare(
		"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9501,?,?,'user','linked')",
	)
		.bind(todayIn(DEFAULT_TIME_ZONE).slice(0, 7), bakery)
		.run();
}

/** Local Bakery pays a planned expense: a plan linked to it, which counts whatever its exclusion. */
async function payPlan() {
	await env.DB.prepare(
		"INSERT INTO planned_expenses(name,amount_cents,month,transaction_id,created_by) VALUES('Car registration',1200,?,?,'demo')",
	)
		.bind(todayIn(DEFAULT_TIME_ZONE).slice(0, 7), bakery)
		.run();
}

describe("the edit panel's head (P120 B)", () => {
	it("headlines the name in serif at 3xl, with the amount in ink under it, then the day and the account", async () => {
		const html = (await get(`/transactions/${bakery}`)).html;
		const h2 = html.match(/<h2 id="edit-title"[^>]*>/)?.[0] ?? "";
		expect(h2).toContain("font-serif text-3xl font-semibold tracking-tight");
		expect(h2).not.toContain("text-4xl");
		const panel = panelOf(html);
		const amount = panel.indexOf(
			'<span class="text-lg font-semibold text-ink">',
		);
		expect(amount).toBeGreaterThan(0);
		expect(panel.indexOf("font-serif text-4xl")).toBe(-1);
		expect(amount).toBeLessThan(panel.indexOf("· "));
		expect(panel.indexOf("· ")).toBeLessThan(
			panel.indexOf('id="edit-category"'),
		);
	});
});

describe("the category leads the panel (P120 B)", () => {
	it("opens an uncategorized transaction's category as a two-column grid with New category last", async () => {
		const block = categoryBlock((await get(`/transactions/${bakery}`)).html);
		expect(block).toContain("<fieldset");
		expect(block).toContain('class="grid grid-cols-2 gap-2"');
		expect(block).not.toContain("<details");
		const values = [...block.matchAll(/name="category" value="([^"]+)"/g)].map(
			(m) => m[1],
		);
		expect(values.at(-1)).toBe("new");
	});

	it("folds a categorized transaction's category into one closed row, named and sourced", async () => {
		await pickedByTally();
		const block = categoryBlock((await get(`/transactions/${bakery}`)).html);
		const details =
			block.match(/<details class="group border-b border-rule"[^>]*>/)?.[0] ??
			"";
		expect(details).not.toContain(" open");
		const summary = block.slice(
			block.indexOf("<summary"),
			block.indexOf("</summary>"),
		);
		// One phrase, in order: the name, the choice, then its source (a screen reader's order too).
		const label = summary.indexOf("Category");
		const choice = summary.indexOf("Groceries");
		const source = summary.indexOf("Picked by Tally · 92% sure");
		expect(label).toBeGreaterThan(-1);
		expect(choice).toBeGreaterThan(label);
		expect(source).toBeGreaterThan(choice);
		// What's inside still posts while it's closed.
		expect(block).toContain('class="grid grid-cols-2 gap-2"');
	});

	it("names the saved category's source only while the posted choice is that category", async () => {
		await pickedByTally();
		const ids = await env.DB.prepare(
			"SELECT (SELECT id FROM categories WHERE name = 'Gas') AS gas, (SELECT id FROM categories WHERE name = 'Groceries') AS groceries",
		).first<{ gas: number; groceries: number }>();
		// Another choice posted (a redraw after a refused save): the row shows it, and says nothing about the saved pick.
		const other = await post(`/transactions/${bakery}/category/lock`, {
			category: String(ids?.gas),
			back: "/transactions",
		});
		expect(other.html).toContain("Gas");
		expect(other.html).not.toContain("Picked by Tally");
		// The saved category posted again keeps its source line.
		const same = await post(`/transactions/${bakery}/category/lock`, {
			category: String(ids?.groceries),
			back: "/transactions",
		});
		expect(same.html).toContain("Picked by Tally · 92% sure");
	});

	it("opens the folded row when New category is chosen", async () => {
		await pickedByTally();
		const { html } = await post(`/transactions/${bakery}/category/lock`, {
			category: "new",
			new_category_name: "",
			back: "/transactions",
		});
		const details =
			html.match(/<details class="group border-b border-rule"[^>]*>/)?.[0] ??
			"";
		expect(details).toContain(" open");
	});

	it("never hides a category error inside a closed row", async () => {
		await pickedByTally();
		const { res, html } = await post(`/transactions/${bakery}`, {
			category: "99",
			name_pick: "own",
			merchant: "Local Bakery",
			note: "",
			back: "/transactions",
			income: "0",
			creditReviewed: "0",
		});
		expect(res.status).toBe(422);
		const block = categoryBlock(html);
		expect(block).toContain('id="category-error" role="alert"');
		for (const tag of block.match(/<details[^>]*>/g) ?? []) {
			expect(tag).toContain(" open");
		}
	});

	it("names the posted rule's category on a lock redraw, not its id", async () => {
		const merchantKey = (
			await env.DB.prepare(
				"SELECT COALESCE(NULLIF(merchant_name, ''), raw_name) AS key FROM transactions WHERE id = ?",
			)
				.bind(bakery)
				.first<{ key: string }>()
		)?.key;
		const groceries = (
			await env.DB.prepare(
				"SELECT id FROM categories WHERE name = 'Groceries'",
			).first<{ id: number }>()
		)?.id;
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, default_category_id) VALUES (?, ?) ON CONFLICT(raw_name) DO UPDATE SET default_category_id = excluded.default_category_id",
		)
			.bind(merchantKey, groceries)
			.run();
		// The rule tick was drawn with the store's rule (always_was), so a redraw keeps naming it by its category.
		const { html } = await post(`/transactions/${bakery}/category/lock`, {
			category: String(groceries),
			always: "1",
			always_was: "1",
			rule_category_was: String(groceries),
			back: "/transactions",
		});
		expect(html).toContain(
			"Local Bakery is always Groceries. Untick it and save to remove the rule.",
		);
		expect(html).not.toContain(`is always ${groceries}.`);
	});

	it("keeps an archived saved category folded, named and sourced", async () => {
		await pickedByTally();
		await env.DB.prepare(
			"UPDATE categories SET archived = 1 WHERE name = 'Groceries'",
		).run();
		const block = categoryBlock((await get(`/transactions/${bakery}`)).html);
		expect(block).toContain('<details class="group border-b border-rule"');
		const details =
			block.match(/<details class="group border-b border-rule"[^>]*>/)?.[0] ??
			"";
		expect(details).not.toContain(" open");
		const summary = block.slice(
			block.indexOf("<summary"),
			block.indexOf("</summary>"),
		);
		const label = summary.indexOf("Category");
		const choice = summary.indexOf("Groceries");
		const source = summary.indexOf("Picked by Tally · 92% sure");
		expect(label).toBeGreaterThan(-1);
		expect(choice).toBeGreaterThan(label);
		expect(source).toBeGreaterThan(choice);
	});

	it("saves a note on an archived category without changing its category", async () => {
		await pickedByTally();
		await env.DB.prepare(
			"UPDATE categories SET archived = 1 WHERE name = 'Groceries'",
		).run();
		const groceries = (
			await env.DB.prepare(
				"SELECT id FROM categories WHERE name = 'Groceries'",
			).first<{ id: number }>()
		)?.id;
		// No category posts: the archived one isn't offered, so the save leaves the transaction's category as it is.
		const { res } = await post(`/transactions/${bakery}`, {
			note: "Kept as Groceries",
			back: "/transactions",
		});
		expect(res.status).toBe(200);
		const row = await env.DB.prepare(
			"SELECT category_id AS categoryId FROM transactions WHERE id = ?",
		)
			.bind(bakery)
			.first<{ categoryId: number | null }>();
		expect(row?.categoryId).toBe(groceries);
	});
});

describe("Exclude and Count as income are switches (P120 B)", () => {
	it("draws each as a switch that posts 1, with its words and its hint", async () => {
		const panel = panelOf((await get(`/transactions/${bakery}`)).html);
		const excluded = inputTag(panel, "excluded");
		expect(excluded).toContain('role="switch"');
		expect(excluded).toContain('value="1"');
		expect(panel).toContain("Exclude from budget");
		expect(panel).toContain("It won&#39;t count in Spent or any budget.");
		const income = inputTag(panel, "income");
		expect(income).toContain('role="switch"');
		expect(income).toContain('value="1"');
		expect(panel).toContain("Count as income");
	});

	it("says on Exclude's line that a bill payment counts, excluded or not", async () => {
		await payBill();
		for (const excluded of [0, 1]) {
			await env.DB.prepare("UPDATE transactions SET excluded = ? WHERE id = ?")
				.bind(excluded, bakery)
				.run();
			const panel = panelOf((await get(`/transactions/${bakery}`)).html);
			expect(excludeHintOf(panel)).toBe(
				"It pays a bill, so it counts in the budget.",
			);
			expect(excludeHintOf(panel)).not.toContain("won&#39;t count");
		}
	});

	it("says on Exclude's line that a planned expense's payment counts, excluded or not", async () => {
		await payPlan();
		for (const excluded of [0, 1]) {
			await env.DB.prepare("UPDATE transactions SET excluded = ? WHERE id = ?")
				.bind(excluded, bakery)
				.run();
			const panel = panelOf((await get(`/transactions/${bakery}`)).html);
			expect(excludeHintOf(panel)).toBe(
				"It pays a planned expense, so it counts in the budget.",
			);
			expect(excludeHintOf(panel)).not.toContain("won&#39;t count");
		}
	});

	it("has no How this works link in the panel (audit E5)", async () => {
		const panel = panelOf((await get(`/transactions/${bakery}`)).html);
		expect(panel).not.toContain(">How this works</a>");
	});
});

describe("Reviewed as a refund is a switch (decision 111)", () => {
	it("draws the credit's review as a switch with its label, posting 1 and on when reviewed", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents = -500, flag_income = 0, income_source = NULL, credit_reviewed = 1, credit_reviewed_by = 'user' WHERE id = ?",
		)
			.bind(bakery)
			.run();
		const panel = panelOf((await get(`/transactions/${bakery}`)).html);
		const review = inputTag(panel, "creditReviewed");
		expect(review).toContain('role="switch"');
		expect(review).toContain('id="edit-credit-reviewed"');
		expect(review).toContain('value="1"');
		expect(review).toContain("checked");
		expect(panel).toContain('id="edit-credit-reviewed-label"');
		expect(panel).toContain(
			">Reviewed as a refund or other non-income credit</span>",
		);
	});

	it("draws no review switch for a purchase, which is not a credit", async () => {
		const panel = panelOf((await get(`/transactions/${bakery}`)).html);
		expect(panel).not.toContain('name="creditReviewed"');
	});

	it("saves the ticked switch as the review it records", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents = -500, flag_income = 0, income_source = NULL, credit_reviewed = 0, credit_reviewed_by = NULL WHERE id = ?",
		)
			.bind(bakery)
			.run();
		const groceries = (
			await env.DB.prepare(
				"SELECT id FROM categories WHERE name = 'Groceries'",
			).first<{ id: number }>()
		)?.id;
		const { res } = await post(`/transactions/${bakery}`, {
			category: String(groceries),
			name_pick: "own",
			merchant: "Local Bakery",
			note: "",
			back: "/transactions",
			income: "0",
			income_was: "0",
			creditReviewed: "1",
			creditReviewedVisible: "1",
			creditReviewed_was: "0",
		});
		expect(res.status).toBeLessThan(400);
		expect(
			await env.DB.prepare(
				"SELECT credit_reviewed, credit_reviewed_by FROM transactions WHERE id = ?",
			)
				.bind(bakery)
				.first(),
		).toMatchObject({ credit_reviewed: 1, credit_reviewed_by: "user" });
	});
});

describe("Organize's category sheet uses the same grid (#498)", () => {
	it("draws its choices as the two-column grid, not a wrapping row", async () => {
		const { html } = await post("/transactions/select/category", {
			ids: String(bakery),
			back: "/transactions?month=all",
		});
		const sheet = html.slice(html.indexOf('id="select-category-title"'));
		expect(sheet).toContain('class="grid grid-cols-2 gap-2"');
		expect(sheet).not.toContain("flex flex-wrap gap-2");
	});
});

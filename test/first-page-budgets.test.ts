import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_TIME_ZONE,
	daysBefore,
	monthName,
	monthsBefore,
	todayIn,
} from "../src/dates";
import { markStroke, readFirstTally } from "../src/db/first-tally";
import { resetDemo } from "../src/demo/reset";
import { readMonthSummary } from "../src/month-summary";
import { firstPage } from "../src/routes/first-page";
import { safeToSpendText } from "../src/views/home-top";

// The budgets step of the question page (P125 E, spec §6 and §8.8, decision 114, #590): once pay and bills are done,
// each category with no budget this month is offered Tally's suggestion, all at once or one at a time, and the step
// ends by ruling off the month's Safe to spend. Four categories are in play: A has two full months of spending, B has
// two smaller ones, C has none, and D's average is over the largest budget. Amounts are integer cents.

const db = env.DB;
const BASE = "http://tally.test";
const TODAY = todayIn(DEFAULT_TIME_ZONE);
const CUR = TODAY.slice(0, 7);
/** The two full months Tally has here: the history starts on the 1st of the earlier one. */
const MONTH_2 = monthsBefore(CUR, 2);
const MONTH_1 = monthsBefore(CUR, 1);
const STROKE_ONE = daysBefore(TODAY, 2);

/** The app with the page mounted, as the family app serves it, with a verified identity. */
function app() {
	const router = new Hono<{ Bindings: Env; Variables: { actor: string } }>();
	router.use("*", async (c, next) => {
		c.set("actor", "person@example.com");
		await next();
	});
	router.route("/", firstPage);
	return {
		fetch(path: string, init?: RequestInit) {
			return router.fetch(
				new Request(BASE + path, init),
				{ ...env, DB: db, DEMO: "false" } as unknown as Env,
				{ waitUntil() {}, passThroughOnException() {}, props: {} },
			);
		},
	};
}

const family = app();

async function get(path: string) {
	const res = await family.fetch(path);
	return { res, html: await res.text() };
}

async function post(path: string, fields: [string, string][], htmx = true) {
	const res = await family.fetch(path, {
		method: "POST",
		redirect: "manual",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			...(htmx ? { "HX-Request": "true" } : {}),
		},
		body: new URLSearchParams(fields).toString(),
	});
	return { res, html: await res.text() };
}

/** The hidden fields a form submits under one name, unescaped as the browser sends them. */
function hiddenFields(html: string, name: string): [string, string][] {
	return [
		...html.matchAll(new RegExp(`name="${name}" value="([^"]*)"`, "g")),
	].map(([, value]): [string, string] => [
		name,
		(value ?? "")
			.replaceAll("&#39;", "'")
			.replaceAll("&quot;", '"')
			.replaceAll("&amp;", "&"),
	]);
}

/** The page's words: a link's tags leave no space behind, other tags a space. */
const textOf = (html: string) =>
	html
		.replace(/<\/?a\b[^>]*>/g, "")
		.replace(/<[^>]+>/g, " ")
		.replaceAll("&#39;", "'")
		.replaceAll("&quot;", '"')
		.replaceAll("&amp;", "&")
		.replace(/\s+/g, " ");

/** The heading that takes focus (its autofocus), or null when none does. */
const focusedHeading = (html: string) =>
	/<h2[^>]*autofocus[^>]*>([^<]*)<\/h2>/.exec(html)?.[1] ?? null;

const trigger = (res: Response) =>
	JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
		toast?: { message: string; type: string };
		announce?: string;
	};

let seq = 0;
/** One expense on the one connected bank (account 1); amount_cents is money out, as Plaid sends it. */
async function spend(
	categoryId: number | null,
	cents: number,
	date: string,
	over: Record<string, unknown> = {},
) {
	seq += 1;
	const row: Record<string, unknown> = {
		account_id: 1,
		plaid_transaction_id: `budgets-${seq}`,
		date,
		amount_cents: cents,
		raw_name: `SHOP ${seq}`,
		category_id: categoryId,
		category_source: categoryId === null ? null : "user",
		category_confidence: 90,
		income_confidence: 0,
		flag_income: 0,
		...over,
	};
	const columns = Object.keys(row);
	await db
		.prepare(
			`INSERT INTO transactions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
		)
		.bind(...Object.values(row))
		.run();
}

/** The four categories in play, in the order the step asks them, and their names. */
let A = 0;
let B = 0;
let C = 0;
let D = 0;
let nameA = "";
let nameB = "";
let nameC = "";
let nameD = "";

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await db.prepare("DELETE FROM transactions").run();
	await db.prepare("DELETE FROM bill_payments").run();
	await db.prepare("DELETE FROM bills").run();
	await db.prepare("DELETE FROM merchants").run();
	await db.prepare("DELETE FROM accounts").run();
	await db.prepare("DELETE FROM plaid_items").run();
	await db.prepare("DELETE FROM budget_amounts").run();
	// The demo's savings goal and planned expenses would set money aside from Safe to spend; these tests keep it to budgets.
	await db.prepare("DELETE FROM savings_goal_amounts").run();
	await db.prepare("DELETE FROM planned_expenses").run();
	await db
		.prepare("DELETE FROM household_settings WHERE key = 'first_tally'")
		.run();
	seq = 0;
	await db
		.prepare(
			"INSERT INTO plaid_items (id, plaid_item_id, access_token_encrypted, institution_name, linked_by, last_synced_at, history_complete_at) VALUES (1, 'item-1', X'00', 'Chase', 'person', ?1, ?1)",
		)
		.bind(TODAY)
		.run();
	await db
		.prepare(
			"INSERT INTO accounts (id, plaid_item_id, plaid_account_id, name, type) VALUES (1, 1, 'acc-1', 'Checking', 'depository')",
		)
		.run();
	await markStroke(db, "bank", STROKE_ONE);
	// Only four categories are in play; the rest are archived, so the step doesn't ask about them.
	await db.prepare("UPDATE categories SET archived = 1").run();
	const ids = await db
		.prepare("SELECT id, name FROM categories ORDER BY id LIMIT 4")
		.all<{ id: number; name: string }>();
	const [a, b, c, d] = ids.results;
	A = a?.id ?? 0;
	B = b?.id ?? 0;
	C = c?.id ?? 0;
	D = d?.id ?? 0;
	nameA = a?.name ?? "";
	nameB = b?.name ?? "";
	nameC = c?.name ?? "";
	nameD = d?.name ?? "";
	for (const [index, id] of [A, B, C, D].entries()) {
		await db
			.prepare(
				"UPDATE categories SET archived = 0, sort_order = ? WHERE id = ?",
			)
			.bind(index + 1, id)
			.run();
	}
	// A: $610 in the first full month, $674 in the second, so its suggestion is $650.
	await spend(A, 61000, `${MONTH_2}-01`);
	await spend(A, 67400, `${MONTH_1}-01`);
	// B: $100 then $200, so its suggestion is $150.
	await spend(B, 10000, `${MONTH_2}-01`);
	await spend(B, 20000, `${MONTH_1}-01`);
	// D: about $1,000,001 a month, so its rounded suggestion is over the largest budget.
	await spend(D, 100000100, `${MONTH_2}-01`);
	await spend(D, 100000100, `${MONTH_1}-01`);
});

/** The keep-all values the page shows: one per suggestion, as the page's own form posts them. */
const keepFields = (html: string) => hiddenFields(html, "keep");

describe("the budgets question, keep all or one at a time", () => {
	it("offers keep all for the suggestions, with their total, and a quiet One at a time", async () => {
		const { html } = await get("/first-page");
		const text = textOf(html);
		expect(text).toContain("Keep all 2 budgets, $800 a month?");
		expect(text).toContain("Keep all 2");
		expect(text).toContain("One at a time");
		expect(html).toContain('href="/first-page?budgets=one"');
		expect(text).toContain(
			`Your bank shows what each category spent in ${monthName(MONTH_2)} and ${monthName(MONTH_1)}.`,
		);
	});

	it("keep all writes each suggestion from this month on, keeps each answer, and says how many", async () => {
		const { html } = await get("/first-page");
		const res = await post("/first-page/budgets", [
			...keepFields(html),
			["answer", "all"],
		]);
		expect(res.res.status).toBe(200);
		const rows = await db
			.prepare(
				"SELECT category_id AS id, effective_month AS month, amount_cents AS cents FROM budget_amounts ORDER BY category_id",
			)
			.all<{ id: number; month: string; cents: number }>();
		expect(rows.results).toEqual([
			{ id: A, month: CUR, cents: 65000 },
			{ id: B, month: CUR, cents: 15000 },
		]);
		const record = await readFirstTally(db);
		expect(record?.budgets[String(A)]).toEqual({
			kind: "suggested",
			cents: 65000,
		});
		expect(record?.budgets[String(B)]).toEqual({
			kind: "suggested",
			cents: 15000,
		});
		expect(trigger(res.res).announce).toBe("Kept 2 budgets.");
		expect(trigger(res.res).toast?.type).toBe("success");
		expect(textOf(res.html)).toContain("Budgets · 2 kept, $800 a month");
	});

	it("keep all keeps only the suggestions the page showed, and asks a changed one again", async () => {
		const { html } = await get("/first-page");
		const shown = keepFields(html);
		// B's suggestion moves after the page drew: its shown value no longer matches, so only A is kept.
		await spend(B, 90000, `${MONTH_1}-02`);
		const res = await post("/first-page/budgets", [
			...shown,
			["answer", "all"],
		]);
		const rows = await db
			.prepare("SELECT category_id AS id FROM budget_amounts")
			.all<{ id: number }>();
		expect(rows.results.map((row) => row.id)).toEqual([A]);
		expect(trigger(res.res).announce).toContain("Kept 1 budget.");
		expect(trigger(res.res).announce).toContain(
			"1 changed since the page drew, so it's asked again below.",
		);
	});

	it("draws no budgets stroke while a category with no history is still to answer", async () => {
		const { html } = await get("/first-page");
		await post("/first-page/budgets", [...keepFields(html), ["answer", "all"]]);
		const record = await readFirstTally(db);
		expect(record?.strokes.budgets).toBeUndefined();
	});

	it("asks each category in turn with its months and its Yes amount, after One at a time", async () => {
		const { html } = await get("/first-page?budgets=one");
		const text = textOf(html);
		expect(focusedHeading(html)).toBe(
			`Make $650 a month your ${nameA} budget?`,
		);
		expect(text).toContain(
			`Your bank shows ${nameA} spent $610 in ${monthName(MONTH_2)} and $674 in ${monthName(MONTH_1)}.`,
		);
		expect(text).toContain("Yes, $650");
		expect(text).toContain("Another amount");
		expect(text).toContain("Skip this one");
		expect(text).not.toContain("Keep all");
	});

	it("keeps a Yes, announces it, and asks the next category at once", async () => {
		const res = await post("/first-page/budgets", [
			["category", String(A)],
			["shown", "65000"],
			["answer", "yes"],
		]);
		expect(trigger(res.res).announce).toBe(`${nameA}: $650 a month.`);
		expect((await readFirstTally(db))?.budgets[String(A)]).toEqual({
			kind: "suggested",
			cents: 65000,
		});
		expect(focusedHeading(res.html)).toBe(
			`Make $150 a month your ${nameB} budget?`,
		);
		expect(textOf(res.html)).toContain("Budgets · 1 kept, $650 a month");
	});

	it("resumes at the next unanswered category after a reload, with no keep all", async () => {
		await post("/first-page/budgets", [
			["category", String(A)],
			["shown", "65000"],
			["answer", "yes"],
		]);
		const { html } = await get("/first-page");
		expect(textOf(html)).not.toContain("Keep all");
		expect(textOf(html)).toContain(`Make $150 a month your ${nameB} budget?`);
	});

	it("keeps a skip as given, writes no budget for it, and moves on", async () => {
		const res = await post("/first-page/budgets", [
			["category", String(A)],
			["answer", "skip"],
		]);
		expect(trigger(res.res).announce).toBe(`${nameA}: no budget yet.`);
		const record = await readFirstTally(db);
		expect(record?.budgets[String(A)]).toEqual({
			kind: "skipped",
			cents: null,
		});
		const rows = await db
			.prepare("SELECT COUNT(*) AS n FROM budget_amounts WHERE category_id = ?")
			.bind(A)
			.first<{ n: number }>();
		expect(rows?.n).toBe(0);
		expect(focusedHeading(res.html)).toBe(
			`Make $150 a month your ${nameB} budget?`,
		);
	});

	it("saves another amount typed through the MoneyInput, and says what it saved", async () => {
		const res = await post("/first-page/budgets", [
			["category", String(B)],
			["budget", "120"],
			["answer", "another"],
		]);
		expect(trigger(res.res).announce).toBe(`${nameB}: $120 a month.`);
		const row = await db
			.prepare(
				"SELECT amount_cents AS cents FROM budget_amounts WHERE category_id = ?",
			)
			.bind(B)
			.first<{ cents: number }>();
		expect(row?.cents).toBe(12000);
		expect((await readFirstTally(db))?.budgets[String(B)]).toEqual({
			kind: "another",
			cents: 12000,
		});
	});

	it("refuses an amount that is not dollars, with its error in the field, and keeps nothing", async () => {
		const res = await post("/first-page/budgets", [
			["category", String(B)],
			["budget", "lots"],
			["answer", "another"],
		]);
		expect(res.res.status).toBe(422);
		expect(res.html).toContain('role="alert"');
		expect(res.html).toContain("Enter a dollar amount, like 250 or 250.50.");
		expect(trigger(res.res).toast?.type).toBe("error");
		expect((await readFirstTally(db))?.budgets[String(B)]).toBeUndefined();
	});

	it("keeps no change when the suggestion moved since the page drew, and asks it again", async () => {
		const res = await post("/first-page/budgets", [
			["category", String(A)],
			["shown", "60000"],
			["answer", "yes"],
		]);
		expect(trigger(res.res).toast?.type).toBe("info");
		expect(trigger(res.res).toast?.message).toContain(
			"changed since the page drew",
		);
		const row = await db
			.prepare("SELECT COUNT(*) AS n FROM budget_amounts WHERE category_id = ?")
			.bind(A)
			.first<{ n: number }>();
		expect(row?.n).toBe(0);
	});

	it("says a category already answered changes nothing", async () => {
		await post("/first-page/budgets", [
			["category", String(A)],
			["answer", "skip"],
		]);
		const res = await post("/first-page/budgets", [
			["category", String(A)],
			["shown", "65000"],
			["answer", "yes"],
		]);
		expect(trigger(res.res).toast?.message).toBe(
			"That one is already answered.",
		);
		expect((await readFirstTally(db))?.budgets[String(A)]).toEqual({
			kind: "skipped",
			cents: null,
		});
	});
});

describe("categories the step does not ask", () => {
	it("keeps a category's budget set on Home, and does not ask it", async () => {
		await db
			.prepare(
				"INSERT INTO budget_amounts (category_id, effective_month, amount_cents) VALUES (?, ?, ?)",
			)
			.bind(A, MONTH_2, 40000)
			.run();
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain("Keep all 1 budget, $150 a month?");
		expect(textOf(html)).not.toContain(nameA);
	});

	it("asks a category with no history with a blank amount, and says it has no spending yet", async () => {
		await post("/first-page/budgets", [
			["category", String(A)],
			["answer", "skip"],
		]);
		await post("/first-page/budgets", [
			["category", String(B)],
			["answer", "skip"],
		]);
		const { html } = await get("/first-page?budgets=one");
		expect(focusedHeading(html)).toBe(`Do you want a ${nameC} budget?`);
		expect(textOf(html)).toContain(
			`${nameC} has no spending yet. Set a monthly budget, or skip it.`,
		);
		expect(html).toContain('name="budget"');
		expect(html).toMatch(/name="budget"[^>]*value=""/);
		expect(textOf(html)).toContain("Save this budget");
		expect(textOf(html)).not.toContain("Yes, $");
	});

	it("asks, with a blank amount and no suggestion, a category whose rounded average is over the largest budget", async () => {
		await post("/first-page/budgets", [
			["category", String(A)],
			["answer", "skip"],
		]);
		await post("/first-page/budgets", [
			["category", String(B)],
			["answer", "skip"],
		]);
		await post("/first-page/budgets", [
			["category", String(C)],
			["answer", "skip"],
		]);
		const { html } = await get("/first-page?budgets=one");
		expect(focusedHeading(html)).toBe(`Do you want a ${nameD} budget?`);
		expect(textOf(html)).toContain(
			`Your bank shows ${nameD} spent $1,000,001 in ${monthName(MONTH_2)} and $1,000,001 in ${monthName(MONTH_1)}.`,
		);
		expect(textOf(html)).not.toContain("Yes, $");
	});
});

describe("the step's end", () => {
	it("two answers at once both keep, and the budgets stroke waits for the last category", async () => {
		await post("/first-page/budgets", [
			["category", String(A)],
			["shown", "65000"],
			["answer", "yes"],
		]);
		const [first, second] = await Promise.all([
			post("/first-page/budgets", [
				["category", String(B)],
				["answer", "skip"],
			]),
			post("/first-page/budgets", [
				["category", String(C)],
				["answer", "skip"],
			]),
		]);
		expect(first.res.status).toBe(200);
		expect(second.res.status).toBe(200);
		let record = await readFirstTally(db);
		expect(record?.budgets[String(B)]).toEqual({
			kind: "skipped",
			cents: null,
		});
		expect(record?.budgets[String(C)]).toEqual({
			kind: "skipped",
			cents: null,
		});
		// D is still to answer, so the stroke waits for it.
		expect(record?.strokes.budgets).toBeUndefined();
		await post("/first-page/budgets", [
			["category", String(D)],
			["answer", "skip"],
		]);
		record = await readFirstTally(db);
		expect(record?.strokes.budgets).toBe(TODAY);
	});

	it("rules off the month's Safe to spend, the number Home shows, under the Four line", async () => {
		await spend(A, 10000, TODAY);
		await post("/first-page/budgets", [
			["category", String(A)],
			["shown", "65000"],
			["answer", "yes"],
		]);
		await post("/first-page/budgets", [
			["category", String(B)],
			["shown", "15000"],
			["answer", "yes"],
		]);
		await post("/first-page/budgets", [
			["category", String(C)],
			["answer", "skip"],
		]);
		const last = await post("/first-page/budgets", [
			["category", String(D)],
			["answer", "skip"],
		]);
		const { summary } = await readMonthSummary(db, TODAY, CUR);
		// The month's budgets ($650 and $150) less this month's $100 of spending.
		expect(summary.safeToSpendCents).toBe(70000);
		const text = textOf(last.html);
		expect(text).toContain(
			"Four. Tomorrow Tally keeps count on its own, and that's the fifth.",
		);
		expect(text).toContain("Safe to spend");
		expect(text).toContain(safeToSpendText(summary.safeToSpendCents));
		expect(last.html).toContain('href="/"');
		expect(text).toContain("Go to Home");
	});

	it("shows the total with no question left on a reload", async () => {
		for (const id of [A, B, C, D]) {
			await post("/first-page/budgets", [
				["category", String(id)],
				["answer", "skip"],
			]);
		}
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain(
			"Four. Tomorrow Tally keeps count on its own, and that's the fifth.",
		);
		expect(textOf(html)).not.toContain("Keep all");
		expect(html).not.toContain("budget?");
	});

	it("draws the budgets stroke at once when no category is left to ask", async () => {
		for (const id of [A, B, C, D]) {
			await db
				.prepare(
					"INSERT INTO budget_amounts (category_id, effective_month, amount_cents) VALUES (?, ?, ?)",
				)
				.bind(id, MONTH_2, 5000)
				.run();
		}
		await get("/first-page");
		expect((await readFirstTally(db))?.strokes.budgets).toBe(TODAY);
	});
});

describe("the needs-a-category line", () => {
	it("shows the uncategorized count and about its monthly mean, linked to the filter", async () => {
		// $60 of uncategorized spending in the first full month: a mean of $30 over the two.
		await spend(null, 6000, `${MONTH_2}-03`);
		const { html } = await get("/first-page?budgets=one");
		expect(textOf(html)).toContain(
			"Needs a category · 1 transaction · about $30 a month",
		);
		expect(html).toContain('href="/transactions?uncategorized=1"');
	});

	it("draws no line when nothing needs a category", async () => {
		const { html } = await get("/first-page?budgets=one");
		expect(textOf(html)).not.toContain("Needs a category ·");
	});
});

describe("the budgets step's motion", () => {
	it("marks the budgets ledger line for its one-shot rise when a Yes writes it", async () => {
		const res = await post("/first-page/budgets", [
			["category", String(A)],
			["shown", "65000"],
			["answer", "yes"],
		]);
		expect(res.html).toContain("first-line-new");
	});
});

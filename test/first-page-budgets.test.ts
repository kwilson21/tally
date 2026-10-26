import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_TIME_ZONE,
	daysBefore,
	daysInMonth,
	monthName,
	monthsBefore,
	todayIn,
} from "../src/dates";
import {
	markStroke,
	readFirstTally,
	takeBackQuestionStrokes,
} from "../src/db/first-tally";
import { resetDemo } from "../src/demo/reset";
import {
	type BudgetAsk,
	bankLine,
	budgetsTotalLine,
	keepAllButton,
	keepAllLead,
	keepAllQuestion,
} from "../src/first-tally/budgets";
import {
	keepBudgetAnswers,
	settleAndLoad,
} from "../src/first-tally/first-page";
import { readMonthSummary } from "../src/month-summary";
import { firstPage, questionScreen } from "../src/routes/first-page";
import { setupRoute } from "../src/routes/setup";
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
/** The setup finish's heading, as the page's text reads it (P142 A, decision 148, #774). */
const SET_UP = "You're set up.";

/**
 * The app with the page mounted, as the family app serves it, with a verified identity. `DB` is the database the page
 * reads and writes (the test's own unless a test wraps it).
 */
function app(DB: D1Database = db) {
	const router = new Hono<{ Bindings: Env; Variables: { actor: string } }>();
	router.use("*", async (c, next) => {
		c.set("actor", "person@example.com");
		await next();
	});
	router.route("/", setupRoute);
	router.route("/", firstPage);
	return {
		fetch(path: string, init?: RequestInit) {
			return router.fetch(
				new Request(BASE + path, init),
				{ ...env, DB, DEMO: "false" } as unknown as Env,
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

async function post(
	path: string,
	fields: [string, string][],
	htmx = true,
	DB: D1Database = db,
) {
	// A budgets form carries the household month it showed; a test posts the current one unless it names another.
	const withMonth = fields.some(([name]) => name === "month")
		? fields
		: [...fields, ["month", CUR]];
	const res = await app(DB).fetch(path, {
		method: "POST",
		redirect: "manual",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			...(htmx ? { "HX-Request": "true" } : {}),
		},
		body: new URLSearchParams(withMonth).toString(),
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

/** Each form on the page as its markup. Forms don't nest, so each one's markup ends at its own closing tag. */
const formsOf = (html: string) =>
	[...html.matchAll(/<form\b[\s\S]*?<\/form>/g)].map(([form]) => form);

/** A form's default button: the first submit button inside it, which Enter in one of its fields presses. */
const defaultButtonOf = (form: string) =>
	/<button\b(?=[^>]*\btype="submit")[^>]*>/.exec(form)?.[0] ?? "";

/** The heading that takes focus (its autofocus), or null when none does. */
const focusedHeading = (html: string) =>
	/<h1[^>]*autofocus[^>]*>([^<]*)<\/h1>/.exec(html)?.[1] ?? null;

/** The page's first h1 as its markup, so a test can read its attributes (the focus) and its words. */
const h1Of = (html: string) => /<h1\b[^>]*>[^<]*<\/h1>/.exec(html)?.[0] ?? "";

/** The budgets forms on a page, as their markup. */
const budgetFormsOf = (html: string) =>
	formsOf(html).filter((form) => form.includes('action="/setup/budgets"'));

/** How many times `needle` appears in `text`. */
const countOf = (text: string, needle: string) => text.split(needle).length - 1;

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

/**
 * The test database with `hook` run once, against the database itself, just before its first batch: the write a sync or
 * a competing answer makes between a reply's read and its own batch. Every other call forwards to the database.
 */
function raceBeforeBatch(hook: (db: D1Database) => Promise<void>): D1Database {
	let raced = false;
	return new Proxy(db, {
		get(target, prop) {
			if (prop === "batch" && !raced) {
				return async (statements: D1PreparedStatement[]) => {
					raced = true;
					await hook(target);
					return target.batch(statements);
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** A Home budget set from `month` on, written as Home's sheet writes it (a race's write). */
const homeBudget =
	(categoryId: number, cents: number, month = CUR) =>
	async (d: D1Database) => {
		await d
			.prepare(
				"INSERT INTO budget_amounts (category_id, effective_month, amount_cents) VALUES (?, ?, ?)",
			)
			.bind(categoryId, month, cents)
			.run();
	};

/** A category's budget amounts in cents, the oldest month first. */
async function budgetRows(categoryId: number): Promise<number[]> {
	const { results } = await db
		.prepare(
			"SELECT amount_cents AS cents FROM budget_amounts WHERE category_id = ? ORDER BY effective_month",
		)
		.bind(categoryId)
		.all<{ cents: number }>();
	return results.map((row) => row.cents);
}

/** The record's budgets for a category, or undefined when the record has no answer for it. */
async function recordedBudget(categoryId: number) {
	return (await readFirstTally(db))?.budgets[String(categoryId)];
}

describe("the budgets question, keep all or one at a time", () => {
	it("offers keep all for the suggestions, with their total, and a quiet One at a time", async () => {
		const { html } = await get("/setup");
		const text = textOf(html);
		expect(text).toContain("Keep these budgets?");
		expect(text).toContain("2 budgets");
		expect(text).toContain("$800 a month");
		expect(text).toContain("Keep all 2");
		expect(text).toContain("Go one at a time");
		expect(html).toContain('href="/setup?budgets=one"');
		expect(text).toContain(
			`Each is what you spent in ${monthName(MONTH_2)} and ${monthName(MONTH_1)}, on average, rounded up to the next $10.`,
		);
	});

	it("keep all writes each suggestion from this month on, keeps each answer, and says how many", async () => {
		const { html } = await get("/setup");
		const res = await post("/setup/budgets", [
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
	});

	it("keep all keeps only the suggestions the page showed, and asks a changed one again", async () => {
		const { html } = await get("/setup");
		const shown = keepFields(html);
		// B's suggestion moves after the page drew: its shown value no longer matches, so only A is kept.
		await spend(B, 90000, `${MONTH_1}-02`);
		const res = await post("/setup/budgets", [...shown, ["answer", "all"]]);
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
		const { html } = await get("/setup");
		await post("/setup/budgets", [...keepFields(html), ["answer", "all"]]);
		const record = await readFirstTally(db);
		expect(record?.strokes.budgets).toBeUndefined();
	});

	it("asks each category in turn with its months and its Yes amount, after One at a time", async () => {
		const { html } = await get("/setup?budgets=one");
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
		const res = await post("/setup/budgets", [
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
	});

	it("resumes at the next unanswered category after a reload, with no keep all", async () => {
		await post("/setup/budgets", [
			["category", String(A)],
			["shown", "65000"],
			["answer", "yes"],
		]);
		const { html } = await get("/setup");
		expect(textOf(html)).not.toContain("Keep all");
		expect(textOf(html)).toContain(`Make $150 a month your ${nameB} budget?`);
	});

	it("keeps a skip as given, writes no budget for it, and moves on", async () => {
		const res = await post("/setup/budgets", [
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
		const res = await post("/setup/budgets", [
			["category", String(A)],
			["budget", "120"],
			["answer", "another"],
		]);
		expect(trigger(res.res).announce).toBe(`${nameA}: $120 a month.`);
		const row = await db
			.prepare(
				"SELECT amount_cents AS cents FROM budget_amounts WHERE category_id = ?",
			)
			.bind(A)
			.first<{ cents: number }>();
		expect(row?.cents).toBe(12000);
		expect((await readFirstTally(db))?.budgets[String(A)]).toEqual({
			kind: "another",
			cents: 12000,
		});
	});

	it("refuses an amount that is not dollars, with its error in the field, and keeps nothing", async () => {
		const res = await post("/setup/budgets", [
			["category", String(A)],
			["budget", "lots"],
			["answer", "another"],
		]);
		expect(res.res.status).toBe(422);
		expect(res.html).toContain('role="alert"');
		expect(res.html).toContain("Enter a dollar amount, like 250 or 250.50.");
		expect(trigger(res.res).toast?.type).toBe("error");
		expect((await readFirstTally(db))?.budgets[String(A)]).toBeUndefined();
		// The refused question is the first one asked (A), so its form and its field are A's, not the category posted (#697).
		expect(textOf(res.html)).toContain(
			`Make $650 a month your ${nameA} budget?`,
		);
		expect([
			...new Set(hiddenFields(res.html, "category").map(([, value]) => value)),
		]).toEqual([String(A)]);
		expect(res.html).toMatch(new RegExp(`id="budget-${A}"[^>]*value="lots"`));
		expect(res.html).not.toContain(`name="category" value="${B}"`);
		// A corrected Save posts the category the form carries.
		await post("/setup/budgets", [
			["category", String(A)],
			["budget", "120"],
			["answer", "another"],
		]);
		expect(await budgetRows(A)).toEqual([12000]);
		expect(await budgetRows(B)).toEqual([]);
	});

	it("keeps Enter in the amount field on Another amount: its form's default button is Save, and the Yes form holds no amount", async () => {
		const { html } = await get("/setup?budgets=one");
		const forms = formsOf(html);
		const amountForm = forms.find((form) => form.includes('name="budget"'));
		expect(amountForm).toBeDefined();
		expect(defaultButtonOf(amountForm ?? "")).toContain('value="another"');
		const yesForm = forms.find((form) => form.includes('value="yes"'));
		expect(yesForm).toBeDefined();
		expect(yesForm).not.toContain('name="budget"');
		expect(defaultButtonOf(yesForm ?? "")).toContain('value="yes"');
		expect(forms.some((form) => form.includes('value="skip"'))).toBe(true);
	});

	it("keeps no change when the suggestion moved since the page drew, and asks it again", async () => {
		const res = await post("/setup/budgets", [
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
		await post("/setup/budgets", [
			["category", String(A)],
			["answer", "skip"],
		]);
		const res = await post("/setup/budgets", [
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
	it("gives each category the step asks its icon and colour, as the setup screen's rows draw them (#773)", async () => {
		const row = await db
			.prepare("SELECT icon, color FROM categories WHERE id = ?1")
			.bind(A)
			.first<{ icon: string; color: string }>();
		const pending = (await settleAndLoad(db, TODAY, { oneAtATime: true }))
			.budgets;
		if (!pending || pending.done)
			throw new Error("the budgets question is open");
		const ask = pending.asks.find((candidate) => candidate.id === A);
		expect(row?.icon).toBeTruthy();
		expect(row?.color).toBeTruthy();
		expect(ask?.icon).toBe(row?.icon);
		expect(ask?.color).toBe(row?.color);
	});

	it("keeps a category's budget set on Home, and does not ask it", async () => {
		await db
			.prepare(
				"INSERT INTO budget_amounts (category_id, effective_month, amount_cents) VALUES (?, ?, ?)",
			)
			.bind(A, MONTH_2, 40000)
			.run();
		const { html } = await get("/setup");
		expect(textOf(html)).toContain("Keep this budget?");
		expect(textOf(html)).toContain("1 budget");
		expect(textOf(html)).toContain("$150 a month");
		expect(textOf(html)).not.toContain(nameA);
	});

	it("asks a category with no history with a blank amount, and says it has no spending yet", async () => {
		await post("/setup/budgets", [
			["category", String(A)],
			["answer", "skip"],
		]);
		await post("/setup/budgets", [
			["category", String(B)],
			["answer", "skip"],
		]);
		const { html } = await get("/setup?budgets=one");
		expect(focusedHeading(html)).toBe(`Do you want a ${nameC} budget?`);
		expect(textOf(html)).toContain(
			`${nameC} has no spending yet. Set a monthly budget, or skip it.`,
		);
		expect(html).toContain('name="budget"');
		expect(html).toMatch(/name="budget"[^>]*value=""/);
		expect(textOf(html)).toContain("Save this budget");
		expect(textOf(html)).not.toContain("Yes, $");
	});

	it("a category with no history: its Save this budget is the amount form's own button, which Enter in the field presses, and Skip is a form of its own", async () => {
		await post("/setup/budgets", [
			["category", String(A)],
			["answer", "skip"],
		]);
		await post("/setup/budgets", [
			["category", String(B)],
			["answer", "skip"],
		]);
		const { html } = await get("/setup?budgets=one");
		const forms = formsOf(html);
		const amountForm = forms.find((form) => form.includes('name="budget"'));
		expect(amountForm).toContain('id="one-budget"');
		// The Save button is drawn in the screen's foot with form="one-budget", so it belongs to the amount form.
		expect(html).toMatch(
			/<button\b(?=[^>]*\bform="one-budget")(?=[^>]*value="another")/,
		);
		expect(amountForm).not.toContain('value="skip"');
		expect(forms.find((form) => form.includes('value="skip"'))).toBeDefined();
	});

	it("asks, with a blank amount and no suggestion, a category whose rounded average is over the largest budget", async () => {
		await post("/setup/budgets", [
			["category", String(A)],
			["answer", "skip"],
		]);
		await post("/setup/budgets", [
			["category", String(B)],
			["answer", "skip"],
		]);
		await post("/setup/budgets", [
			["category", String(C)],
			["answer", "skip"],
		]);
		const { html } = await get("/setup?budgets=one");
		expect(focusedHeading(html)).toBe(`Do you want a ${nameD} budget?`);
		expect(textOf(html)).toContain(
			`Your bank shows ${nameD} spent $1,000,001 in ${monthName(MONTH_2)} and $1,000,001 in ${monthName(MONTH_1)}.`,
		);
		expect(textOf(html)).not.toContain("Yes, $");
	});
});

describe("the step's end", () => {
	it("two answers at once both keep, and the budgets stroke waits for the last category", async () => {
		await post("/setup/budgets", [
			["category", String(A)],
			["shown", "65000"],
			["answer", "yes"],
		]);
		// Only the first category asked takes a route's answer (#697), so two answers at once go through the write itself.
		const pending = (await settleAndLoad(db, TODAY, { oneAtATime: true }))
			.budgets;
		if (!pending || pending.done)
			throw new Error("the budgets question is open");
		const askB = pending.asks.find((ask) => ask.id === B);
		const askC = pending.asks.find((ask) => ask.id === C);
		if (!askB || !askC) throw new Error("B and C are still asked");
		const [first, second] = await Promise.all([
			keepBudgetAnswers(db, TODAY, pending.firstDate, [
				{ ask: askB, answer: { kind: "skipped", cents: null } },
			]),
			keepBudgetAnswers(db, TODAY, pending.firstDate, [
				{ ask: askC, answer: { kind: "skipped", cents: null } },
			]),
		]);
		expect(first).toEqual([B]);
		expect(second).toEqual([C]);
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
		const last = await post("/setup/budgets", [
			["category", String(D)],
			["answer", "skip"],
		]);
		expect(last.res.status).toBe(200);
		record = await readFirstTally(db);
		// The savings question is the step's last, so its stroke waits for that answer too (#721).
		expect(record?.strokes.budgets).toBeUndefined();
		await post("/setup/savings", [["answer", "skip"]]);
		record = await readFirstTally(db);
		expect(record?.strokes.budgets).toBe(TODAY);
	});

	it("draws the setup finish with the month's Safe to spend, the number Home shows, once the budgets step is done", async () => {
		await spend(A, 10000, TODAY);
		await post("/setup/budgets", [
			["category", String(A)],
			["shown", "65000"],
			["answer", "yes"],
		]);
		await post("/setup/budgets", [
			["category", String(B)],
			["shown", "15000"],
			["answer", "yes"],
		]);
		await post("/setup/budgets", [
			["category", String(C)],
			["answer", "skip"],
		]);
		await post("/setup/budgets", [
			["category", String(D)],
			["answer", "skip"],
		]);
		// The savings question is the step's last; Not now leaves the month's Safe to spend as it is.
		const last = await post("/setup/savings", [["answer", "skip"]]);
		const { summary } = await readMonthSummary(db, TODAY, CUR);
		// The month's budgets ($650 and $150) less this month's $100 of spending.
		expect(summary.safeToSpendCents).toBe(70000);
		const text = textOf(last.html);
		expect(text).toContain(SET_UP);
		expect(text).toContain("Safe to spend in October");
		expect(text).toContain(safeToSpendText(summary.safeToSpendCents));
		expect(last.html).toContain('href="/"');
		expect(text).toContain("Go to Home");
	});

	it("draws the finish as the reply to the last answer, and a reload of /setup draws it too (#774)", async () => {
		for (const id of [A, B, C, D]) {
			await post("/setup/budgets", [
				["category", String(id)],
				["answer", "skip"],
			]);
		}
		const { html } = await post("/setup/savings", [["answer", "skip"]]);
		const reload = await get("/setup");
		expect(reload.res.status).toBe(200);
		expect(textOf(reload.html)).toContain(SET_UP);
		expect(reload.html).toContain('href="/"');
		expect(focusedHeading(reload.html)).toBeNull();
		expect(textOf(html)).toContain(SET_UP);
		// The finish's heading takes the focus, so the reply puts the person on "You're set up." (#774).
		expect(textOf(h1Of(html)).trim()).toBe(SET_UP);
		expect(h1Of(html)).toContain("autofocus");
		expect(h1Of(html)).toContain('tabindex="-1"');
		expect(textOf(html)).not.toContain("Keep all");
		expect(html).not.toContain("budget?");
		// Every category was answered (skipped), so the line for a step with nothing to ask is not the one said.
		expect(textOf(html)).not.toContain("Every category already has a budget.");
		expect(textOf(html)).not.toContain("No categories to budget yet.");
	});

	it("says neither line once every category is answered with an amount, since those budgets are the family's own (#692 review)", async () => {
		for (const id of [A, B, C, D]) {
			await post("/setup/budgets", [
				["category", String(id)],
				["budget", "100"],
				["answer", "another"],
			]);
		}
		const text = textOf(
			(await post("/setup/savings", [["answer", "skip"]])).html,
		);
		expect(text).toContain(SET_UP);
		expect(text).not.toContain("Every category already has a budget.");
		expect(text).not.toContain("No categories to budget yet.");
	});

	it("draws the budgets stroke once the savings question is answered, when no category is left to ask", async () => {
		for (const id of [A, B, C, D]) {
			await db
				.prepare(
					"INSERT INTO budget_amounts (category_id, effective_month, amount_cents) VALUES (?, ?, ?)",
				)
				.bind(id, MONTH_2, 5000)
				.run();
		}
		const { html } = await get("/setup");
		expect(textOf(html)).toContain("Save some each month?");
		expect((await readFirstTally(db))?.strokes.budgets).toBeUndefined();
		await post("/setup/savings", [["answer", "skip"]]);
		expect((await readFirstTally(db))?.strokes.budgets).toBe(TODAY);
	});
});

describe("the needs-a-category line", () => {
	it("shows the uncategorized count and about its monthly mean, linked to the filter", async () => {
		// $60 of uncategorized spending in the first full month: a mean of $30 over the two.
		await spend(null, 6000, `${MONTH_2}-03`);
		const { html } = await get("/setup?budgets=one");
		expect(textOf(html)).toContain(
			"Needs a category · 1 transaction · about $30 a month",
		);
		// The link opens the same all-time count the line shows, so the list and the number agree.
		expect(html).toContain(
			'href="/transactions?uncategorized=1&amp;month=all"',
		);
	});

	it("draws no line when nothing needs a category", async () => {
		const { html } = await get("/setup?budgets=one");
		expect(textOf(html)).not.toContain("Needs a category ·");
	});
});

describe("the bank line's months", () => {
	it("joins three months with commas, and 'and' before the last, as the keep all line's list does", () => {
		const ask: BudgetAsk = {
			id: 1,
			name: "Groceries",
			icon: "groceries",
			color: "cat-blue",
			months: [
				{ month: "2026-08", spentCents: 61000 },
				{ month: "2026-09", spentCents: 67400 },
				{ month: "2026-10", spentCents: 70000 },
			],
			suggestion: null,
		};
		expect(bankLine(ask)).toBe(
			"Your bank shows Groceries spent $610 in August, $674 in September and $700 in October.",
		);
	});
});

// The setup screen's budgets question (P142 A, #773): the lead, the double-ruled total, and the question and its button in
// the keep all form and in the one-category form (P142's words, and the new words for a single budget).

describe("the setup budgets question's words", () => {
	it("says what each suggestion is, from the months it came from, with its rounding", () => {
		expect(
			keepAllLead([
				{ month: "2026-08-01", spentCents: 61000 },
				{ month: "2026-09-01", spentCents: 67400 },
			]),
		).toBe(
			"Each is what you spent in August and September, on average, rounded up to the next $10.",
		);
		expect(
			keepAllLead([
				{ month: "2026-07-01", spentCents: 100 },
				{ month: "2026-08-01", spentCents: 100 },
				{ month: "2026-09-01", spentCents: 100 },
			]),
		).toBe(
			"Each is what you spent in July, August and September, on average, rounded up to the next $10.",
		);
	});

	it("says a single month without the average, and no months as a typical month", () => {
		expect(keepAllLead([{ month: "2026-09-01", spentCents: 67400 }])).toBe(
			"Each is what you spent in September, rounded up to the next $10.",
		);
		expect(keepAllLead([])).toBe(
			"Each is a typical month, rounded up to the next $10.",
		);
	});

	it("totals the budgets, counted and in whole dollars a month", () => {
		expect(budgetsTotalLine(12, 405000)).toEqual({
			label: "12 budgets",
			amount: "$4,050 a month",
		});
		expect(budgetsTotalLine(1, 65000)).toEqual({
			label: "1 budget",
			amount: "$650 a month",
		});
	});

	it("asks the keep all question and names its button in plural, and in the singular for one", () => {
		expect(keepAllQuestion(12)).toBe("Keep these budgets?");
		expect(keepAllButton(12)).toBe("Keep all 12");
		expect(keepAllQuestion(1)).toBe("Keep this budget?");
		expect(keepAllButton(1)).toBe("Keep this budget");
	});
});

describe("an answer's write checks what is still asked, in its own batch (#590 review)", () => {
	it("a Yes does not overwrite a Home budget set after the page drew, and says it is already answered", async () => {
		const res = await post(
			"/setup/budgets",
			[
				["category", String(A)],
				["shown", "65000"],
				["answer", "yes"],
			],
			true,
			raceBeforeBatch(homeBudget(A, 40000)),
		);
		expect(await budgetRows(A)).toEqual([40000]);
		expect(await recordedBudget(A)).toBeUndefined();
		expect(trigger(res.res).toast).toEqual({
			message: "That one is already answered.",
			type: "info",
		});
	});

	it("a Yes whose suggestion moved after the page drew saves nothing, and asks the new suggestion again", async () => {
		const res = await post(
			"/setup/budgets",
			[
				["category", String(A)],
				["shown", "65000"],
				["answer", "yes"],
			],
			true,
			raceBeforeBatch(async () => {
				await spend(A, 90000, `${MONTH_1}-02`);
			}),
		);
		expect(await budgetRows(A)).toEqual([]);
		expect(await recordedBudget(A)).toBeUndefined();
		expect(trigger(res.res).toast).toEqual({
			message: `Nothing saved. ${nameA}'s suggestion changed since the page drew, so it's asked again below.`,
			type: "info",
		});
		expect(focusedHeading(res.html)).toBe(
			`Make $1,100 a month your ${nameA} budget?`,
		);
	});

	it("a Yes still lands when a race leaves the suggestion at the same amount, the total at the top of its step", async () => {
		// A's total goes from $1,284 to $1,300 over the two months: still $650 a month, the largest total that rounds to it.
		const res = await post(
			"/setup/budgets",
			[
				["category", String(A)],
				["shown", "65000"],
				["answer", "yes"],
			],
			true,
			raceBeforeBatch(async () => {
				await spend(A, 1600, `${MONTH_1}-02`);
			}),
		);
		expect(await budgetRows(A)).toEqual([65000]);
		expect(await recordedBudget(A)).toEqual({
			kind: "suggested",
			cents: 65000,
		});
		expect(trigger(res.res).announce).toBe(`${nameA}: $650 a month.`);
	});

	it("Another amount keeps the Home budget set after the page drew, not the typed amount", async () => {
		const res = await post(
			"/setup/budgets",
			[
				["category", String(A)],
				["budget", "120"],
				["answer", "another"],
			],
			true,
			raceBeforeBatch(homeBudget(A, 40000)),
		);
		expect(await budgetRows(A)).toEqual([40000]);
		expect(await recordedBudget(A)).toBeUndefined();
		expect(trigger(res.res).toast).toEqual({
			message: "That one is already answered.",
			type: "info",
		});
	});

	it("a Skip raced by a Yes for the same category keeps that Yes and its budget, and says it is already answered", async () => {
		const res = await post(
			"/setup/budgets",
			[
				["category", String(A)],
				["answer", "skip"],
			],
			true,
			raceBeforeBatch(async () => {
				await post("/setup/budgets", [
					["category", String(A)],
					["shown", "65000"],
					["answer", "yes"],
				]);
			}),
		);
		expect(await recordedBudget(A)).toEqual({
			kind: "suggested",
			cents: 65000,
		});
		expect(await budgetRows(A)).toEqual([65000]);
		expect(trigger(res.res).toast).toEqual({
			message: "That one is already answered.",
			type: "info",
		});
	});

	it("a category archived after the page drew is not written", async () => {
		const res = await post(
			"/setup/budgets",
			[
				["category", String(A)],
				["shown", "65000"],
				["answer", "yes"],
			],
			true,
			raceBeforeBatch(async (d) => {
				await d
					.prepare("UPDATE categories SET archived = 1 WHERE id = ?")
					.bind(A)
					.run();
			}),
		);
		expect(await budgetRows(A)).toEqual([]);
		expect(await recordedBudget(A)).toBeUndefined();
		expect(trigger(res.res).toast?.message).toBe(
			"That one is already answered.",
		);
	});

	it("keep all keeps a Home budget set after the page drew, and keeps the other suggestion", async () => {
		const { html } = await get("/setup");
		const res = await post(
			"/setup/budgets",
			[...keepFields(html), ["answer", "all"]],
			true,
			raceBeforeBatch(homeBudget(A, 40000)),
		);
		expect(await budgetRows(A)).toEqual([40000]);
		expect(await recordedBudget(A)).toBeUndefined();
		expect(await budgetRows(B)).toEqual([15000]);
		expect(await recordedBudget(B)).toEqual({
			kind: "suggested",
			cents: 15000,
		});
		expect(trigger(res.res).announce).toBe("Kept 1 budget.");
	});

	it("keep all does not write a suggestion whose amount moved after the page drew, and asks it again", async () => {
		const { html } = await get("/setup");
		const res = await post(
			"/setup/budgets",
			[...keepFields(html), ["answer", "all"]],
			true,
			raceBeforeBatch(async () => {
				await spend(B, 90000, `${MONTH_1}-02`);
			}),
		);
		expect(await budgetRows(A)).toEqual([65000]);
		expect(await budgetRows(B)).toEqual([]);
		expect(trigger(res.res).announce).toBe(
			"Kept 1 budget. 1 changed since the page drew, so it's asked again below.",
		);
		expect(focusedHeading(res.html)).toBe(
			`Make $600 a month your ${nameB} budget?`,
		);
	});

	it("a Yes saves nothing when older history moves the window's first month, and asks the new suggestion (#692)", async () => {
		const res = await post(
			"/setup/budgets",
			[
				["category", String(A)],
				["shown", "65000"],
				["answer", "yes"],
			],
			true,
			raceBeforeBatch(async () => {
				await spend(null, 5000, `${monthsBefore(CUR, 3)}-01`);
			}),
		);
		expect(await budgetRows(A)).toEqual([]);
		expect(await recordedBudget(A)).toBeUndefined();
		expect(trigger(res.res).toast).toEqual({
			message: `Nothing saved. ${nameA}'s suggestion changed since the page drew, so it's asked again below.`,
			type: "info",
		});
		// Three full months now: $1,284 over them, rounded up to $430.
		expect(focusedHeading(res.html)).toBe(
			`Make $430 a month your ${nameA} budget?`,
		);
	});

	it("a Yes saves nothing when the first charge moves so a month drops out of the window (#692)", async () => {
		const res = await post(
			"/setup/budgets",
			[
				["category", String(A)],
				["shown", "65000"],
				["answer", "yes"],
			],
			true,
			raceBeforeBatch(async (d) => {
				await d
					.prepare(
						`UPDATE transactions SET date = '${MONTH_2}-02' WHERE date = '${MONTH_2}-01'`,
					)
					.run();
			}),
		);
		expect(await budgetRows(A)).toEqual([]);
		expect(await recordedBudget(A)).toBeUndefined();
		expect(trigger(res.res).toast).toEqual({
			message: `Nothing saved. ${nameA}'s suggestion changed since the page drew, so it's asked again below.`,
			type: "info",
		});
		// The first month is now part-month, so the window is the last full month alone: $674 rounds up to $680.
		expect(focusedHeading(res.html)).toBe(
			`Make $680 a month your ${nameA} budget?`,
		);
	});

	it("keep all saves nothing when older history moves the window, and says both suggestions changed (#692)", async () => {
		const { html } = await get("/setup");
		const res = await post(
			"/setup/budgets",
			[...keepFields(html), ["answer", "all"]],
			true,
			raceBeforeBatch(async () => {
				await spend(null, 5000, `${monthsBefore(CUR, 3)}-01`);
			}),
		);
		expect(await budgetRows(A)).toEqual([]);
		expect(await budgetRows(B)).toEqual([]);
		expect(trigger(res.res).announce).toBe(
			"Nothing saved. 2 suggestions changed since the page drew, so they're asked again below.",
		);
	});
});

describe("keep all's count of what changed (#590 review)", () => {
	it("counts a shown suggestion that is still asked, but has no suggestion now, as changed", async () => {
		const { html } = await get("/setup");
		await db
			.prepare("DELETE FROM transactions WHERE category_id = ?")
			.bind(B)
			.run();
		const res = await post("/setup/budgets", [
			...keepFields(html),
			["answer", "all"],
		]);
		expect(trigger(res.res).announce).toBe(
			"Kept 1 budget. 1 changed since the page drew, so it's asked again below.",
		);
		expect(await budgetRows(B)).toEqual([]);
		expect(focusedHeading(res.html)).toBe(`Do you want a ${nameB} budget?`);
		expect(res.html).toMatch(/name="budget"[^>]*value=""/);
	});

	it("does not count a shown suggestion that a Home budget has since set", async () => {
		const { html } = await get("/setup");
		await homeBudget(B, 40000)(db);
		const res = await post("/setup/budgets", [
			...keepFields(html),
			["answer", "all"],
		]);
		expect(trigger(res.res).announce).toBe("Kept 1 budget.");
		expect(await budgetRows(B)).toEqual([40000]);
		expect(await recordedBudget(B)).toBeUndefined();
	});

	it("keeps each shown id once, and neither keeps nor counts a value the page never asked", async () => {
		const { html } = await get("/setup");
		const shown = keepFields(html);
		const res = await post("/setup/budgets", [
			...shown,
			...shown,
			["keep", "not json"],
			["keep", JSON.stringify({ id: 999, cents: 1000 })],
			["keep", JSON.stringify({ id: A, cents: 1 })],
			["answer", "all"],
		]);
		expect(trigger(res.res).announce).toBe("Kept 2 budgets.");
		expect(await budgetRows(A)).toEqual([65000]);
		expect(await budgetRows(B)).toEqual([15000]);
	});
});

describe("a refused amount without JavaScript (#590 review)", () => {
	it("draws no presence check-in on the page it returns: its settle drew the pay step (no paycheck), so a question is answered, as with a redraw (decision 146)", async () => {
		// Nothing is drawn but the bank before this request. The refused page is the same page as a redraw with JavaScript, which
		// reads the check-in after the settle, so it draws none: the settle drew the pay step, and an answered question ends it.
		const res = await post(
			"/setup/budgets",
			[
				["category", String(A)],
				["budget", "lots"],
				["answer", "another"],
			],
			false,
		);
		expect(res.res.status).toBe(422);
		expect(res.html).not.toContain('hx-post="/home/seen"');
	});

	it("draws the page at 422 with its error, the typed amount, and Another amount open", async () => {
		const res = await post(
			"/setup/budgets",
			[
				["category", String(A)],
				["budget", "lots"],
				["answer", "another"],
			],
			false,
		);
		expect(res.res.status).toBe(422);
		expect(res.html).toContain("<title>Setup · Tally</title>");
		expect(res.html).toContain('role="alert"');
		expect(res.html).toContain("Enter a dollar amount, like 250 or 250.50.");
		expect(res.html).toContain('value="lots"');
		expect(res.html).toMatch(/<details[^>]*\sopen\b/);
		expect(await budgetRows(A)).toEqual([]);
		expect(await recordedBudget(A)).toBeUndefined();
		// The page at 422 is A's question, with A's form, so its Save posts A (#697).
		expect(textOf(res.html)).toContain(
			`Make $650 a month your ${nameA} budget?`,
		);
		expect([
			...new Set(hiddenFields(res.html, "category").map(([, value]) => value)),
		]).toEqual([String(A)]);
		expect(res.html).toMatch(new RegExp(`id="budget-${A}"[^>]*value="lots"`));
		expect(res.html).not.toContain(`name="category" value="${B}"`);
		const saved = await post(
			"/setup/budgets",
			[
				["category", String(A)],
				["budget", "120"],
				["answer", "another"],
			],
			false,
		);
		expect(saved.res.status).toBe(303);
		expect(await budgetRows(A)).toEqual([12000]);
		expect(await budgetRows(B)).toEqual([]);
	});
});

describe("an answer for a category that isn't asked first (#697)", () => {
	it("a stale tab's answer for a category that isn't asked first saves nothing, and asks the first (#697)", async () => {
		// A moves to the end of the order, so the tab drawn now asks B first.
		await db
			.prepare("UPDATE categories SET sort_order = 9 WHERE id = ?")
			.bind(A)
			.run();
		const { html } = await get("/setup?budgets=one");
		expect(focusedHeading(html)).toBe(
			`Make $150 a month your ${nameB} budget?`,
		);
		await db
			.prepare("UPDATE categories SET sort_order = 1 WHERE id = ?")
			.bind(A)
			.run();
		const movedOn = {
			message:
				"Nothing saved. The categories changed since the page drew, so the next one is asked below.",
			type: "info",
		};
		const stale: [string, string][][] = [
			[
				["category", String(B)],
				["shown", "15000"],
				["answer", "yes"],
			],
			[
				["category", String(B)],
				["answer", "skip"],
			],
			[
				["category", String(B)],
				["budget", "100"],
				["answer", "another"],
			],
		];
		for (const fields of stale) {
			const res = await post("/setup/budgets", fields);
			expect(trigger(res.res).toast).toEqual(movedOn);
			expect(focusedHeading(res.html)).toBe(
				`Make $650 a month your ${nameA} budget?`,
			);
			expect(await budgetRows(A)).toEqual([]);
			expect(await budgetRows(B)).toEqual([]);
			expect(await recordedBudget(A)).toBeUndefined();
			expect(await recordedBudget(B)).toBeUndefined();
		}
		// A refused amount for B is not drawn in B's place: the reply is A's question, with no error and nothing typed.
		const lots = await post("/setup/budgets", [
			["category", String(B)],
			["budget", "lots"],
			["answer", "another"],
		]);
		expect(lots.res.status).toBe(200);
		expect(trigger(lots.res).toast).toEqual(movedOn);
		expect(lots.html).not.toContain('role="alert"');
		expect(lots.html).not.toContain('value="lots"');
		expect([
			...new Set(hiddenFields(lots.html, "category").map(([, value]) => value)),
		]).toEqual([String(A)]);
		expect(focusedHeading(lots.html)).toBe(
			`Make $650 a month your ${nameA} budget?`,
		);
		// Without JavaScript the same reply is the page again, as a redirect.
		const plain = await post(
			"/setup/budgets",
			[
				["category", String(B)],
				["budget", "lots"],
				["answer", "another"],
			],
			false,
		);
		expect(plain.res.status).toBe(303);
		expect(plain.res.headers.get("location")).toBe("/setup");
		expect(await budgetRows(A)).toEqual([]);
		expect(await budgetRows(B)).toEqual([]);
	});
});

describe("the budgets step with nothing to ask (#590 review)", () => {
	it("draws the finish with no reason line when Home budgeted every category: the finish has no line for why a step asked nothing (#774)", async () => {
		for (const id of [A, B, C, D]) await homeBudget(id, 5000, MONTH_2)(db);
		await get("/setup");
		const { html } = await post("/setup/savings", [["answer", "skip"]]);
		const text = textOf(html);
		expect(text).toContain(SET_UP);
		expect(text).toContain("Safe to spend");
		expect(text).not.toContain("Every category already has a budget.");
		expect(text).not.toContain("No categories to budget yet.");
	});

	it("draws the finish with no reason line when every category is archived (#692 review)", async () => {
		await db.prepare("UPDATE categories SET archived = 1").run();
		await get("/setup");
		const text = textOf(
			(await post("/setup/savings", [["answer", "skip"]])).html,
		);
		expect(text).toContain(SET_UP);
		expect(text).not.toContain("No categories to budget yet.");
		expect(text).not.toContain("Every category already has a budget.");
	});

	it("says neither line once the stroke is drawn and a category with no budget is added after it (#692 review)", async () => {
		for (const id of [A, B, C, D]) await homeBudget(id, 5000, MONTH_2)(db);
		await get("/setup");
		await post("/setup/savings", [["answer", "skip"]]);
		expect((await readFirstTally(db))?.strokes.budgets).toBe(TODAY);
		const added = await db
			.prepare(
				"SELECT id FROM categories WHERE archived = 1 ORDER BY id LIMIT 1",
			)
			.first<{ id: number }>();
		await db
			.prepare("UPDATE categories SET archived = 0 WHERE id = ?")
			.bind(added?.id ?? 0)
			.run();
		const text = textOf(
			String(questionScreen(await settleAndLoad(db, TODAY), { focus: false })),
		);
		expect(text).toContain(SET_UP);
		expect(text).not.toContain("Every category already has a budget.");
		expect(text).not.toContain("No categories to budget yet.");
	});
});

describe("the budgets forms carry the month they showed (#692 review)", () => {
	it("every budgets form on keep all, on one at a time, and on a category with no suggestion carries the month once", async () => {
		const keepAll = await get("/setup");
		const oneAtATime = await get("/setup?budgets=one");
		// Skip A and B, so C, the category with no suggestion, is the one asked: its blank Another amount and Skip.
		for (const id of [A, B]) {
			await post("/setup/budgets", [
				["category", String(id)],
				["answer", "skip"],
			]);
		}
		const noSuggestion = await get("/setup?budgets=one");
		expect(focusedHeading(noSuggestion.html)).toBe(
			`Do you want a ${nameC} budget?`,
		);
		for (const { html } of [keepAll, oneAtATime, noSuggestion]) {
			const forms = budgetFormsOf(html);
			expect(forms.length).toBeGreaterThan(0);
			for (const form of forms)
				expect(countOf(form, `name="month" value="${CUR}"`)).toBe(1);
		}
	});
});

describe("a form drawn in one month and posted in the next (#692 review)", () => {
	const DRAWN = `${CUR}-${daysInMonth(CUR)}T16:00:00Z`;
	const NEXT = monthsBefore(CUR, -1);
	const POSTED = `${NEXT}-01T16:00:00Z`;
	const MONTH_CHANGED = {
		message:
			"Nothing saved. The month changed since the page drew, so the question is asked again below.",
		type: "info",
	};

	beforeEach(async () => {
		// This month's spending: on the 1st the window takes it in, so each amount stays the same across the rollover.
		await spend(A, 66600, `${CUR}-01`);
		await spend(B, 15000, `${CUR}-01`);
		await spend(D, 100000100, `${CUR}-01`);
		vi.useFakeTimers({ toFake: ["Date"] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** Nothing was written: no budget for any category, no answer recorded, and no budgets stroke. */
	async function nothingWritten() {
		for (const id of [A, B, C, D]) {
			expect(await budgetRows(id)).toEqual([]);
			expect(await recordedBudget(id)).toBeUndefined();
		}
		expect((await readFirstTally(db))?.strokes.budgets).toBeUndefined();
	}

	/** The fields one budgets form posts as it drew them: its hidden inputs, and the answer its button sends. */
	function postedBy(html: string, answer: string): [string, string][] {
		const form =
			budgetFormsOf(html).find((candidate) =>
				candidate.includes(`name="answer" value="${answer}"`),
			) ?? "";
		return [
			...["category", "shown", "keep", "month"].flatMap((name) =>
				hiddenFields(form, name),
			),
			["answer", answer],
		];
	}

	it.each([
		{ label: "keep all", path: "/setup", answer: "all", extra: [] },
		{
			label: "Yes",
			path: "/setup?budgets=one",
			answer: "yes",
			extra: [],
		},
		{
			label: "Another amount",
			path: "/setup?budgets=one",
			answer: "another",
			extra: [["budget", "100"]] as [string, string][],
		},
		{
			label: "Skip",
			path: "/setup?budgets=one",
			answer: "skip",
			extra: [],
		},
	])(
		"$label, drawn in one month and posted in the next, writes nothing and draws the next month's question",
		async ({ path, answer, extra }) => {
			vi.setSystemTime(new Date(DRAWN));
			const drawn = await get(path);
			vi.setSystemTime(new Date(POSTED));
			const fields = [...postedBy(drawn.html, answer), ...extra];
			const res = await post("/setup/budgets", fields);
			expect(res.res.status).toBe(200);
			expect(trigger(res.res).toast).toEqual(MONTH_CHANGED);
			expect(trigger(res.res).announce).toBe(MONTH_CHANGED.message);
			await nothingWritten();
			for (const form of budgetFormsOf(res.html))
				expect(countOf(form, `name="month" value="${NEXT}"`)).toBe(1);
			if (answer === "all") {
				expect(focusedHeading(res.html)).toBe("Keep these budgets?");
			} else {
				expect(focusedHeading(res.html)).toBe(
					`Make $650 a month your ${nameA} budget?`,
				);
				expect(textOf(res.html)).toContain(`From ${monthName(NEXT)} on.`);
			}
			// Without JavaScript the same answer is a redirect back to the page, and it writes nothing.
			const plain = await post("/setup/budgets", fields, false);
			expect(plain.res.status).toBe(303);
			expect(plain.res.headers.get("location")).toBe("/setup");
			await nothingWritten();
		},
	);

	it("a last-month Another amount with a refused amount gets the month-changed reply at 200, with no error and nothing typed", async () => {
		vi.setSystemTime(new Date(DRAWN));
		const drawn = await get("/setup?budgets=one");
		vi.setSystemTime(new Date(POSTED));
		const res = await post("/setup/budgets", [
			...postedBy(drawn.html, "another"),
			["budget", "lots"],
		]);
		expect(res.res.status).toBe(200);
		expect(trigger(res.res).toast).toEqual(MONTH_CHANGED);
		expect(res.html).not.toContain('role="alert"');
		expect(res.html).not.toContain('value="lots"');
		await nothingWritten();
	});

	it("a post with an empty month, from a tab drawn before the month was on its forms, writes nothing and gets the month-changed reply", async () => {
		vi.setSystemTime(new Date(POSTED));
		const res = await post("/setup/budgets", [
			["category", String(A)],
			["shown", "65000"],
			["month", ""],
			["answer", "yes"],
		]);
		expect(trigger(res.res).toast).toEqual(MONTH_CHANGED);
		await nothingWritten();
	});

	it("a post with no month at all, from a tab drawn before the month was on its forms, writes nothing and gets the month-changed reply", async () => {
		vi.setSystemTime(new Date(POSTED));
		const res = await app(db).fetch("/setup/budgets", {
			method: "POST",
			redirect: "manual",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"HX-Request": "true",
			},
			body: new URLSearchParams([
				["category", String(A)],
				["shown", "65000"],
				["answer", "yes"],
			]).toString(),
		});
		expect(trigger(res).toast).toEqual(MONTH_CHANGED);
		await nothingWritten();
	});
});

describe("the savings question, the budgets step's last question (decision 135, #721)", () => {
	const QUESTION = "Save some each month?";
	const HELP =
		"Safe to spend sets it aside from the 1st, before anything else. You can change it on Home any time.";
	const LABEL = `Save each month, from ${monthName(CUR)} on`;
	const BLANK = "Enter an amount greater than $0, or choose Not now.";

	/** The goal row for a month, in cents, or undefined when there is none. */
	async function goalFor(month = CUR): Promise<number | undefined> {
		const row = await db
			.prepare(
				"SELECT amount_cents AS cents FROM savings_goal_amounts WHERE effective_month = ?",
			)
			.bind(month)
			.first<{ cents: number }>();
		return row?.cents;
	}

	async function goalRows(): Promise<number> {
		const row = await db
			.prepare("SELECT COUNT(*) AS n FROM savings_goal_amounts")
			.first<{ n: number }>();
		return row?.n ?? 0;
	}

	/** The record's savings answer: cents, "skipped", or undefined before the question is answered. */
	async function savingsOf() {
		return (await readFirstTally(db))?.savings;
	}

	/** Every category answered with Skip, so the savings question is the step's last. Returns the last reply. */
	async function skipAll() {
		let last: { res: Response; html: string } | undefined;
		for (const id of [A, B, C, D]) {
			last = await post("/setup/budgets", [
				["category", String(id)],
				["answer", "skip"],
			]);
		}
		if (!last) throw new Error("no categories");
		return last;
	}

	/** The savings forms on a page: the Save it form, then Not now. */
	const savingsFormsOf = (html: string) =>
		formsOf(html).filter((form) => form.includes('action="/setup/savings"'));

	/**
	 * The database with a take-back landing right after the savings check (savingsOpen) reads the record, before the refusal
	 * reads it again: the pay and bills strokes the check saw drawn are taken back, as a bank link takes them back (json_remove).
	 * Only the first check is changed, so the refusal's own settle draws them again.
	 */
	function takeBackAfterSavingsCheck(): D1Database {
		let taken = false;
		return new Proxy(db, {
			get(target, prop) {
				if (prop === "prepare")
					return (sql: string) => {
						const statement = target.prepare(sql);
						if (taken || !sql.includes("AS open")) return statement;
						taken = true;
						return new Proxy(statement, {
							get(inner, key) {
								if (key === "first")
									return async () => {
										const row = await inner.first();
										await target
											.prepare(
												"UPDATE household_settings SET value = json_remove(value, '$.strokes.pay', '$.strokes.bills') WHERE key = 'first_tally'",
											)
											.run();
										return row;
									};
								const value = Reflect.get(inner, key, inner);
								return typeof value === "function" ? value.bind(inner) : value;
							},
						});
					};
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	it("asks Save some each month? after the last category, with the field blank, and no finish yet", async () => {
		const { html } = await skipAll();
		const text = textOf(html);
		expect(text).toContain(QUESTION);
		expect(text).toContain(HELP);
		expect(text).toContain(LABEL);
		expect(text).not.toContain(SET_UP);
		expect(focusedHeading(html)).toBe(QUESTION);
		const forms = savingsFormsOf(html);
		expect(forms).toHaveLength(2);
		const [save, skip] = forms as [string, string];
		expect(save).toContain('name="goal"');
		// Save it is drawn in the foot with form="savings", so it belongs to the savings form; Enter in its field presses it.
		expect(html).toMatch(
			/<button\b(?=[^>]*\bform="savings")(?=[^>]*value="save")/,
		);
		expect(textOf(html)).toContain("Save it");
		expect(skip).toContain('name="answer" value="skip"');
		expect(skip).toContain("Not now");
		expect(skip).not.toContain('name="goal"');
		expect(html).toContain(`name="month" value="${CUR}"`);
		expect((await readFirstTally(db))?.strokes.budgets).toBeUndefined();
	});

	it("asks it at load when no category is left, not the finish", async () => {
		await db.prepare("UPDATE categories SET archived = 1").run();
		const { html } = await get("/setup");
		expect(textOf(html)).toContain(QUESTION);
		expect(textOf(html)).not.toContain(SET_UP);
	});

	it("asks it at load when every category already has a budget", async () => {
		for (const id of [A, B, C, D]) await homeBudget(id, 5000)(db);
		const { html } = await get("/setup");
		expect(textOf(html)).toContain(QUESTION);
		expect(textOf(html)).not.toContain(SET_UP);
	});

	it("treats a $0 goal row for this month as no goal, so the question still asks", async () => {
		await skipAll();
		await db
			.prepare(
				"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES (?, 0)",
			)
			.bind(CUR)
			.run();
		const { html } = await get("/setup");
		expect(textOf(html)).toContain(QUESTION);
		expect(await savingsOf()).toBeUndefined();
		expect((await readFirstTally(db))?.strokes.budgets).toBeUndefined();
	});

	it("draws stroke four with the goal's cents when a goal above $0 exists before the last category is answered", async () => {
		await db
			.prepare(
				"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES (?, 30000)",
			)
			.bind(CUR)
			.run();
		const { html } = await skipAll();
		expect(textOf(html)).toContain(SET_UP);
		expect(textOf(html)).not.toContain(QUESTION);
		expect(await savingsOf()).toBe(30000);
	});

	it("draws stroke four at load, with the goal's cents, when no category is left and a goal above $0 exists", async () => {
		await db.prepare("UPDATE categories SET archived = 1").run();
		await db
			.prepare(
				"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES (?, 30000)",
			)
			.bind(CUR)
			.run();
		const { html } = await get("/setup");
		expect(textOf(html)).toContain(SET_UP);
		expect(textOf(html)).not.toContain(QUESTION);
		expect(await savingsOf()).toBe(30000);
	});

	it("answers the load at 200 with the finish and no question, when that settle completes the budgets step", async () => {
		// Home budgeted every category and set a goal above $0, so the load's settle draws stroke four and no question is left.
		for (const id of [A, B, C, D]) await homeBudget(id, 5000, MONTH_2)(db);
		await db
			.prepare(
				"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES (?, 30000)",
			)
			.bind(CUR)
			.run();
		expect((await readFirstTally(db))?.strokes.budgets).toBeUndefined();
		const { res, html } = await get("/setup");
		expect(res.status).toBe(200);
		expect(html).toContain('id="setup-screen"');
		const text = textOf(html);
		const { summary } = await readMonthSummary(db, TODAY, CUR);
		expect(text).toContain("Safe to spend");
		expect(text).toContain(safeToSpendText(summary.safeToSpendCents));
		expect(text).toContain(SET_UP);
		expect(text).not.toContain(QUESTION);
		expect(savingsFormsOf(html)).toHaveLength(0);
		expect(budgetFormsOf(html)).toHaveLength(0);
		expect((await readFirstTally(db))?.strokes.budgets).toBe(TODAY);
	});

	it("Save it with $300 sets this month's goal, writes its line, draws stroke four, and rules off Safe to spend less the goal", async () => {
		await skipAll();
		const before = (await readMonthSummary(db, TODAY, CUR)).summary
			.safeToSpendCents;
		const res = await post("/setup/savings", [
			["answer", "save"],
			["goal", "300"],
		]);
		expect(res.res.status).toBe(200);
		expect(await goalFor()).toBe(30000);
		expect(await savingsOf()).toBe(30000);
		expect((await readFirstTally(db))?.strokes.budgets).toBe(TODAY);
		expect(textOf(res.html)).toContain(SET_UP);
		expect(trigger(res.res).toast).toEqual({
			message: "Saved the savings goal: $300 a month.",
			type: "success",
		});
		expect(trigger(res.res).announce).toBe(
			"Saved the savings goal: $300 a month.",
		);
		const after = (await readMonthSummary(db, TODAY, CUR)).summary
			.safeToSpendCents;
		expect(after).toBe(before - 30000);
	});

	it("keeps cents: $300.50 is 30050 cents and its line says $300.50", async () => {
		await skipAll();
		await post("/setup/savings", [
			["answer", "save"],
			["goal", "300.50"],
		]);
		expect(await goalFor()).toBe(30050);
		expect(await savingsOf()).toBe(30050);
	});

	it("replaces a $0 row for this month rather than failing on its unique key", async () => {
		await skipAll();
		await db
			.prepare(
				"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES (?, 0)",
			)
			.bind(CUR)
			.run();
		const res = await post("/setup/savings", [
			["answer", "save"],
			["goal", "300"],
		]);
		expect(res.res.status).toBe(200);
		expect(await goalFor()).toBe(30000);
		expect(await goalRows()).toBe(1);
	});

	it("refuses a blank amount with the words under the field, and writes nothing", async () => {
		await skipAll();
		const { res, html } = await post("/setup/savings", [
			["answer", "save"],
			["goal", ""],
		]);
		expect(res.status).toBe(422);
		expect(textOf(html)).toContain(BLANK);
		expect(html).toContain('aria-invalid="true"');
		expect(html).toContain('role="alert"');
		expect(textOf(html)).toContain(QUESTION);
		expect(focusedHeading(html)).toBeNull();
		expect(trigger(res).toast).toEqual({ message: BLANK, type: "error" });
		expect(trigger(res).announce).toBe(BLANK);
		expect(await goalRows()).toBe(0);
		expect(await savingsOf()).toBeUndefined();
	});

	it("refuses $0 with the same words, and writes nothing", async () => {
		await skipAll();
		const { res, html } = await post("/setup/savings", [
			["answer", "save"],
			["goal", "0"],
		]);
		expect(res.status).toBe(422);
		expect(textOf(html)).toContain(BLANK);
		expect(await goalRows()).toBe(0);
		expect(await savingsOf()).toBeUndefined();
	});

	it("gives bad text and an amount over the largest budget the amount's own words", async () => {
		await skipAll();
		const bad = await post("/setup/savings", [
			["answer", "save"],
			["goal", "lots"],
		]);
		expect(bad.res.status).toBe(422);
		expect(textOf(bad.html)).toContain(
			"Enter a dollar amount, like 250 or 250.50.",
		);
		const huge = await post("/setup/savings", [
			["answer", "save"],
			["goal", "2000000"],
		]);
		expect(huge.res.status).toBe(422);
		expect(textOf(huge.html)).toContain(
			"Keep the budget to $1,000,000 a month or less.",
		);
		expect(await goalRows()).toBe(0);
	});

	it("without JavaScript a refused Save it returns the whole page at 422, with its error", async () => {
		await skipAll();
		const { res, html } = await post(
			"/setup/savings",
			[
				["answer", "save"],
				["goal", ""],
			],
			false,
		);
		expect(res.status).toBe(422);
		expect(html).toContain("<html");
		expect(textOf(html)).toContain(QUESTION);
		expect(textOf(html)).toContain(BLANK);
		// Pay is drawn before the budgets step can show, so no question is unanswered and the page has no check-in.
		expect(html).not.toContain('hx-post="/home/seen"');
	});

	it("without JavaScript a refused Save it draws no check-in after a take-back lands between its check and its read, since its settle draws pay and bills again", async () => {
		await skipAll();
		const drawn = await readFirstTally(db);
		expect(drawn?.strokes.pay).toBeDefined();
		expect(drawn?.strokes.bills).toBeDefined();
		const { res, html } = await post(
			"/setup/savings",
			[
				["answer", "save"],
				["goal", ""],
			],
			false,
			takeBackAfterSavingsCheck(),
		);
		expect(res.status).toBe(422);
		expect(textOf(html)).toContain(QUESTION);
		expect(textOf(html)).toContain(BLANK);
		// The settle drew the pay step again, so a question is answered and the page checks in no more.
		expect((await readFirstTally(db))?.strokes.pay).toBeDefined();
		expect(html).not.toContain('hx-post="/home/seen"');
	});

	it("Not now keeps 'skipped', writes no goal or ledger line, and draws stroke four", async () => {
		await skipAll();
		const { res, html } = await post("/setup/savings", [["answer", "skip"]]);
		expect(res.status).toBe(200);
		expect(await savingsOf()).toBe("skipped");
		expect(await goalRows()).toBe(0);
		expect(textOf(html)).toContain(SET_UP);
		// The finish's heading takes the focus, as the last answer's reply (#774).
		expect(textOf(h1Of(html)).trim()).toBe(SET_UP);
		expect(h1Of(html)).toContain("autofocus");
		expect(h1Of(html)).toContain('tabindex="-1"');
		expect(trigger(res).toast).toEqual({
			message: "No savings goal for now.",
			type: "success",
		});
	});

	it("keeps Home's goal over Save it: the goal stays, the line and the record take its amount, and the reply says so", async () => {
		await skipAll();
		// Home sets a goal after the page drew.
		await db
			.prepare(
				"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES (?, 20000)",
			)
			.bind(CUR)
			.run();
		const res = await post("/setup/savings", [
			["answer", "save"],
			["goal", "300"],
		]);
		expect(await goalFor()).toBe(20000);
		expect(await goalRows()).toBe(1);
		expect(await savingsOf()).toBe(20000);
		expect(textOf(res.html)).toContain(SET_UP);
		expect(trigger(res.res).toast).toEqual({
			message: "Home already has a savings goal: $200 a month.",
			type: "info",
		});
		expect(trigger(res.res).announce).toBe(
			"Home already has a savings goal: $200 a month.",
		);
	});

	it("keeps Home's goal over Not now as well, and the reply says so", async () => {
		await skipAll();
		await db
			.prepare(
				"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES (?, 20000)",
			)
			.bind(CUR)
			.run();
		const res = await post("/setup/savings", [["answer", "skip"]]);
		expect(await goalFor()).toBe(20000);
		expect(await savingsOf()).toBe(20000);
		expect(textOf(res.html)).toContain(SET_UP);
		expect(trigger(res.res).toast?.message).toBe(
			"Home already has a savings goal: $200 a month.",
		);
	});

	/**
	 * A refused Save it after Home set a goal: the goal drew the step when the refusal settled the page, so the reply is the
	 * finished page with Home's words, not the refusal (#721).
	 */
	async function refusedAfterHomeGoal(goal: string) {
		await skipAll();
		await db
			.prepare(
				"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES (?, 20000)",
			)
			.bind(CUR)
			.run();
		const res = await post("/setup/savings", [
			["answer", "save"],
			["goal", goal],
		]);
		expect(res.res.status).toBe(200);
		expect(await goalFor()).toBe(20000);
		expect(await goalRows()).toBe(1);
		expect(await savingsOf()).toBe(20000);
		expect(textOf(res.html)).toContain(SET_UP);
		expect(res.html).not.toContain(QUESTION);
		expect(textOf(res.html)).not.toContain(BLANK);
		expect(res.html).not.toContain('role="alert"');
		expect(trigger(res.res).toast).toEqual({
			message: "Home already has a savings goal: $200 a month.",
			type: "info",
		});
		expect(trigger(res.res).announce).toBe(
			"Home already has a savings goal: $200 a month.",
		);
	}

	it("answers a blank Save it with Home's words, not the refusal, when Home's goal drew the step", async () => {
		await refusedAfterHomeGoal("");
	});

	it("answers a $0 Save it with Home's words, not the refusal, when Home's goal drew the step", async () => {
		await refusedAfterHomeGoal("0");
	});

	it("gets the month-changed reply for a form drawn in another month, and writes nothing", async () => {
		await skipAll();
		const { res, html } = await post("/setup/savings", [
			["answer", "save"],
			["goal", "300"],
			["month", MONTH_1],
		]);
		expect(res.status).toBe(200);
		expect(trigger(res).toast).toEqual({
			message:
				"Nothing saved. The month changed since the page drew, so the question is asked again below.",
			type: "info",
		});
		expect(textOf(html)).toContain(QUESTION);
		expect(await goalRows()).toBe(0);
		expect(await savingsOf()).toBeUndefined();
	});

	it("answers a bad answer with 400", async () => {
		await skipAll();
		const { res } = await post("/setup/savings", [
			["answer", "yes"],
			["goal", "300"],
		]);
		expect(res.status).toBe(400);
		expect(await goalRows()).toBe(0);
	});

	it("writes one goal and one record when two Save its race", async () => {
		await skipAll();
		const [first, second] = await Promise.all([
			post("/setup/savings", [
				["answer", "save"],
				["goal", "300"],
			]),
			post("/setup/savings", [
				["answer", "save"],
				["goal", "400"],
			]),
		]);
		const toasts = [first, second].map((r) => trigger(r.res).toast?.message);
		expect(
			toasts.filter((m) => m?.startsWith("Saved the savings goal")).length,
		).toBe(1);
		expect(toasts).toContain("That one is already answered.");
		expect(await goalRows()).toBe(1);
		expect(await savingsOf()).toBe(await goalFor());
	});

	it("writes nothing for an answer once setup is done (the budgets stroke drawn), and sends Home (decision 148)", async () => {
		await skipAll();
		await post("/setup/savings", [["answer", "skip"]]);
		const { res } = await post("/setup/savings", [
			["answer", "save"],
			["goal", "500"],
		]);
		expect(res.headers.get("HX-Redirect")).toBe("/");
		expect(await goalRows()).toBe(0);
		expect(await savingsOf()).toBe("skipped");
	});

	it("writes nothing when a category was added after the question drew, and asks the budget again", async () => {
		await skipAll();
		const archived = await db
			.prepare(
				"SELECT id, name FROM categories WHERE archived = 1 ORDER BY id LIMIT 1",
			)
			.first<{ id: number; name: string }>();
		if (!archived) throw new Error("an archived category");
		await db
			.prepare("UPDATE categories SET archived = 0 WHERE id = ?")
			.bind(archived.id)
			.run();
		const { res, html } = await post("/setup/savings", [
			["answer", "save"],
			["goal", "300"],
		]);
		expect(trigger(res).toast).toEqual({
			message:
				"Nothing saved. The categories changed since the page drew, so the next one is asked below.",
			type: "info",
		});
		expect(textOf(html)).toContain(`Do you want a ${archived.name} budget?`);
		expect(await goalRows()).toBe(0);
		expect(await savingsOf()).toBeUndefined();
		// A blank or $0 Save it is caught by the same reply: the budget is still asked, so the answer is refused with the moved-on
		// words, not the amount's error.
		for (const goal of ["", "0"]) {
			const refused = await post("/setup/savings", [
				["answer", "save"],
				["goal", goal],
			]);
			expect(refused.res.status).toBe(200);
			const moved =
				"Nothing saved. The categories changed since the page drew, so the next one is asked below.";
			expect(trigger(refused.res).toast).toEqual({
				message: moved,
				type: "info",
			});
			expect(trigger(refused.res).announce).toBe(moved);
			expect(textOf(refused.html)).toContain(
				`Do you want a ${archived.name} budget?`,
			);
			expect(refused.html).not.toContain('role="alert"');
			expect(refused.html).not.toContain(BLANK);
			expect(await goalRows()).toBe(0);
			expect(await savingsOf()).toBeUndefined();
		}
	});

	it("writes nothing for a Save it that comes while a pay question shows, and gets the stale reply", async () => {
		await skipAll();
		// A new deposit brings the pay question back after the savings question drew (the same rows as a pay test's deposit).
		await spend(null, -245000, TODAY, {
			flag_income: 1,
			raw_name: "NEW PAYER",
		});
		expect((await get("/setup")).html).toContain("Is this your pay?");
		const { res, html } = await post("/setup/savings", [
			["answer", "save"],
			["goal", "300"],
		]);
		expect(res.status).toBe(200);
		expect(trigger(res).toast).toEqual({
			message: "That one is already answered.",
			type: "info",
		});
		expect(html).toContain("Is this your pay?");
		expect(await goalRows()).toBe(0);
		expect(await savingsOf()).toBeUndefined();
		expect((await readFirstTally(db))?.strokes.budgets).toBeUndefined();
	});

	it("writes nothing for a Save it that comes while a bills question shows, and gets the stale reply", async () => {
		await skipAll();
		// Two charges a month apart with the same amount: Possible bills asks to keep the repeat as a bill.
		await spend(A, 1549, daysBefore(TODAY, 30), { raw_name: "NETFLIX" });
		await spend(A, 1549, TODAY, { raw_name: "NETFLIX" });
		expect((await get("/setup")).html).toContain("Keep this one as a bill?");
		const { res, html } = await post("/setup/savings", [
			["answer", "save"],
			["goal", "300"],
		]);
		expect(res.status).toBe(200);
		expect(trigger(res).toast).toEqual({
			message: "That one is already answered.",
			type: "info",
		});
		expect(html).toContain("Keep this one as a bill?");
		expect(await goalRows()).toBe(0);
		expect(await savingsOf()).toBeUndefined();
		expect((await readFirstTally(db))?.strokes.budgets).toBeUndefined();
	});

	it("keeps the answer through a take-back, and the re-ask draws stroke four with no second question", async () => {
		await skipAll();
		await post("/setup/savings", [
			["answer", "save"],
			["goal", "300"],
		]);
		await takeBackQuestionStrokes(db, "Wells Fargo").run();
		const { html } = await get("/setup");
		expect(textOf(html)).toContain(SET_UP);
		expect(textOf(html)).not.toContain(QUESTION);
		expect(await savingsOf()).toBe(30000);
		expect(await goalFor()).toBe(30000);
	});

	it("writes nothing when a pay deposit arrives after the page read and before the Save it batch (#721 review)", async () => {
		await skipAll();
		// The deposit lands after the page's pre-read and before the answer's batch, so the savings write must see it.
		const racing = raceBeforeBatch(() =>
			spend(null, -245000, TODAY, { flag_income: 1, raw_name: "NEW PAYER" }),
		);
		const { res, html } = await post(
			"/setup/savings",
			[
				["answer", "save"],
				["goal", "300"],
			],
			true,
			racing,
		);
		expect(trigger(res).toast).toEqual({
			message: "That one is already answered.",
			type: "info",
		});
		expect(html).toContain("Is this your pay?");
		expect(await goalRows()).toBe(0);
		expect(await savingsOf()).toBeUndefined();
		expect((await readFirstTally(db))?.strokes.budgets).toBeUndefined();
	});

	it("draws no budgets stroke when Not now races a new pay deposit with a Home goal set (#721 review)", async () => {
		await skipAll();
		// With Home's goal set, the budgets stroke's goal check passes, so only its pay check keeps the stroke undrawn.
		await db
			.prepare(
				"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES (?, 20000)",
			)
			.bind(CUR)
			.run();
		const racing = raceBeforeBatch(() =>
			spend(null, -245000, TODAY, { flag_income: 1, raw_name: "NEW PAYER" }),
		);
		const { html } = await post(
			"/setup/savings",
			[["answer", "skip"]],
			true,
			racing,
		);
		expect(html).toContain("Is this your pay?");
		expect(await savingsOf()).toBeUndefined();
		expect((await readFirstTally(db))?.strokes.budgets).toBeUndefined();
	});

	it("copies a Home goal and draws the budgets stroke in one batch, so the record and the stroke agree (#721 review)", async () => {
		await skipAll();
		// Home sets the goal after the question drew, so the page's own read copies it and draws the stroke.
		await db
			.prepare(
				"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES (?, 30000)",
			)
			.bind(CUR)
			.run();
		const batch = vi.spyOn(db, "batch");
		try {
			await settleAndLoad(db, TODAY);
			// The page's own reads may batch too; the goal's copy and the budgets stroke are one batch of exactly two statements.
			const sizes = batch.mock.calls.map(([statements]) => statements.length);
			expect(sizes.filter((size) => size === 2)).toHaveLength(1);
		} finally {
			batch.mockRestore();
		}
		expect(await savingsOf()).toBe(30000);
		expect((await readFirstTally(db))?.strokes.budgets).toBe(TODAY);
	});
});

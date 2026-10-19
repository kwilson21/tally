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
import { type BudgetAsk, bankLine } from "../src/first-tally/budgets";
import {
	keepBudgetAnswers,
	settleAndLoad,
} from "../src/first-tally/first-page";
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
	/<h2[^>]*autofocus[^>]*>([^<]*)<\/h2>/.exec(html)?.[1] ?? null;

/** The budgets forms on a page, as their markup. */
const budgetFormsOf = (html: string) =>
	formsOf(html).filter((form) => form.includes('action="/first-page/budgets"'));

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
		const res = await post("/first-page/budgets", [
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
		await post("/first-page/budgets", [
			["category", String(A)],
			["budget", "120"],
			["answer", "another"],
		]);
		expect(await budgetRows(A)).toEqual([12000]);
		expect(await budgetRows(B)).toEqual([]);
	});

	it("keeps Enter in the amount field on Another amount: its form's default button is Save, and the Yes form holds no amount", async () => {
		const { html } = await get("/first-page?budgets=one");
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

	it("a category with no history: its blank amount's form has Save as its default button, and Skip is a form of its own", async () => {
		await post("/first-page/budgets", [
			["category", String(A)],
			["answer", "skip"],
		]);
		await post("/first-page/budgets", [
			["category", String(B)],
			["answer", "skip"],
		]);
		const { html } = await get("/first-page?budgets=one");
		const forms = formsOf(html);
		const amountForm = forms.find((form) => form.includes('name="budget"'));
		expect(defaultButtonOf(amountForm ?? "")).toContain('value="another"');
		expect(amountForm).not.toContain('value="skip"');
		expect(forms.find((form) => form.includes('value="skip"'))).toBeDefined();
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
		const last = await post("/first-page/budgets", [
			["category", String(D)],
			["answer", "skip"],
		]);
		expect(last.res.status).toBe(200);
		record = await readFirstTally(db);
		// The savings question is the step's last, so its stroke waits for that answer too (#721).
		expect(record?.strokes.budgets).toBeUndefined();
		await post("/first-page/savings", [["answer", "skip"]]);
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
		await post("/first-page/budgets", [
			["category", String(D)],
			["answer", "skip"],
		]);
		// The savings question is the step's last; Not now leaves the month's Safe to spend as it is.
		const last = await post("/first-page/savings", [["answer", "skip"]]);
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
		await post("/first-page/savings", [["answer", "skip"]]);
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain(
			"Four. Tomorrow Tally keeps count on its own, and that's the fifth.",
		);
		expect(textOf(html)).not.toContain("Keep all");
		expect(html).not.toContain("budget?");
		// Every category was answered (skipped), so the line for a step with nothing to ask is not the one said.
		expect(textOf(html)).not.toContain("Every category already has a budget.");
		expect(textOf(html)).not.toContain("No categories to budget yet.");
	});

	it("says neither line once every category is answered with an amount, since those budgets are the family's own (#692 review)", async () => {
		for (const id of [A, B, C, D]) {
			await post("/first-page/budgets", [
				["category", String(id)],
				["budget", "100"],
				["answer", "another"],
			]);
		}
		await post("/first-page/savings", [["answer", "skip"]]);
		const text = textOf((await get("/first-page")).html);
		expect(text).toContain(
			"Four. Tomorrow Tally keeps count on its own, and that's the fifth.",
		);
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
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain("Save some each month?");
		expect((await readFirstTally(db))?.strokes.budgets).toBeUndefined();
		await post("/first-page/savings", [["answer", "skip"]]);
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
		// The link opens the same all-time count the line shows, so the list and the number agree.
		expect(html).toContain(
			'href="/transactions?uncategorized=1&amp;month=all"',
		);
	});

	it("draws no line when nothing needs a category", async () => {
		const { html } = await get("/first-page?budgets=one");
		expect(textOf(html)).not.toContain("Needs a category ·");
	});
});

describe("the bank line's months", () => {
	it("joins three months with commas, and 'and' before the last, as the keep all line's list does", () => {
		const ask: BudgetAsk = {
			id: 1,
			name: "Groceries",
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

describe("an answer's write checks what is still asked, in its own batch (#590 review)", () => {
	it("a Yes does not overwrite a Home budget set after the page drew, and says it is already answered", async () => {
		const res = await post(
			"/first-page/budgets",
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
		expect(textOf(res.html)).not.toContain("Budgets ·");
	});

	it("a Yes whose suggestion moved after the page drew saves nothing, and asks the new suggestion again", async () => {
		const res = await post(
			"/first-page/budgets",
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
			"/first-page/budgets",
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
			"/first-page/budgets",
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
			"/first-page/budgets",
			[
				["category", String(A)],
				["answer", "skip"],
			],
			true,
			raceBeforeBatch(async () => {
				await post("/first-page/budgets", [
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
			"/first-page/budgets",
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
		const { html } = await get("/first-page");
		const res = await post(
			"/first-page/budgets",
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
		const { html } = await get("/first-page");
		const res = await post(
			"/first-page/budgets",
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
			"/first-page/budgets",
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
			"/first-page/budgets",
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
		const { html } = await get("/first-page");
		const res = await post(
			"/first-page/budgets",
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
		const { html } = await get("/first-page");
		await db
			.prepare("DELETE FROM transactions WHERE category_id = ?")
			.bind(B)
			.run();
		const res = await post("/first-page/budgets", [
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
		const { html } = await get("/first-page");
		await homeBudget(B, 40000)(db);
		const res = await post("/first-page/budgets", [
			...keepFields(html),
			["answer", "all"],
		]);
		expect(trigger(res.res).announce).toBe("Kept 1 budget.");
		expect(await budgetRows(B)).toEqual([40000]);
		expect(await recordedBudget(B)).toBeUndefined();
	});

	it("keeps each shown id once, and neither keeps nor counts a value the page never asked", async () => {
		const { html } = await get("/first-page");
		const shown = keepFields(html);
		const res = await post("/first-page/budgets", [
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
	it("draws the page at 422 with its error, the typed amount, and Another amount open", async () => {
		const res = await post(
			"/first-page/budgets",
			[
				["category", String(A)],
				["budget", "lots"],
				["answer", "another"],
			],
			false,
		);
		expect(res.res.status).toBe(422);
		expect(res.html).toContain("<title>Your first page · Tally</title>");
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
			"/first-page/budgets",
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
		const { html } = await get("/first-page?budgets=one");
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
			const res = await post("/first-page/budgets", fields);
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
		const lots = await post("/first-page/budgets", [
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
			"/first-page/budgets",
			[
				["category", String(B)],
				["budget", "lots"],
				["answer", "another"],
			],
			false,
		);
		expect(plain.res.status).toBe(303);
		expect(plain.res.headers.get("location")).toBe("/first-page");
		expect(await budgetRows(A)).toEqual([]);
		expect(await budgetRows(B)).toEqual([]);
	});
});

describe("the budgets step with nothing to ask (#590 review)", () => {
	it("says every category already has a budget, above the ruled-off Safe to spend, when Home budgeted them all", async () => {
		for (const id of [A, B, C, D]) await homeBudget(id, 5000, MONTH_2)(db);
		await get("/first-page");
		await post("/first-page/savings", [["answer", "skip"]]);
		const { html } = await get("/first-page");
		const text = textOf(html);
		expect(text).toContain("Every category already has a budget.");
		expect(text.indexOf("Every category already has a budget.")).toBeLessThan(
			text.indexOf("Safe to spend"),
		);
		expect(text).toContain(
			"Four. Tomorrow Tally keeps count on its own, and that's the fifth.",
		);
		expect(text).not.toContain("No categories to budget yet.");
	});

	it("says there are no categories to budget, not that they are budgeted, when every category is archived (#692 review)", async () => {
		await db.prepare("UPDATE categories SET archived = 1").run();
		await get("/first-page");
		await post("/first-page/savings", [["answer", "skip"]]);
		const text = textOf((await get("/first-page")).html);
		expect(text).toContain("No categories to budget yet.");
		expect(text.indexOf("No categories to budget yet.")).toBeLessThan(
			text.indexOf("Safe to spend"),
		);
		expect(text).not.toContain("Every category already has a budget.");
	});

	it("says neither line once the stroke is drawn and a category with no budget is added after it (#692 review)", async () => {
		for (const id of [A, B, C, D]) await homeBudget(id, 5000, MONTH_2)(db);
		await get("/first-page");
		await post("/first-page/savings", [["answer", "skip"]]);
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
		const text = textOf((await get("/first-page")).html);
		expect(text).toContain(
			"Four. Tomorrow Tally keeps count on its own, and that's the fifth.",
		);
		expect(text).not.toContain("Every category already has a budget.");
		expect(text).not.toContain("No categories to budget yet.");
	});
});

describe("the budgets forms carry the month they showed (#692 review)", () => {
	it("every budgets form on keep all, on one at a time, and on a category with no suggestion carries the month once", async () => {
		const keepAll = await get("/first-page");
		const oneAtATime = await get("/first-page?budgets=one");
		// Skip A and B, so C, the category with no suggestion, is the one asked: its blank Another amount and Skip.
		for (const id of [A, B]) {
			await post("/first-page/budgets", [
				["category", String(id)],
				["answer", "skip"],
			]);
		}
		const noSuggestion = await get("/first-page?budgets=one");
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
		{ label: "keep all", path: "/first-page", answer: "all", extra: [] },
		{
			label: "Yes",
			path: "/first-page?budgets=one",
			answer: "yes",
			extra: [],
		},
		{
			label: "Another amount",
			path: "/first-page?budgets=one",
			answer: "another",
			extra: [["budget", "100"]] as [string, string][],
		},
		{
			label: "Skip",
			path: "/first-page?budgets=one",
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
			const res = await post("/first-page/budgets", fields);
			expect(res.res.status).toBe(200);
			expect(trigger(res.res).toast).toEqual(MONTH_CHANGED);
			expect(trigger(res.res).announce).toBe(MONTH_CHANGED.message);
			await nothingWritten();
			for (const form of budgetFormsOf(res.html))
				expect(countOf(form, `name="month" value="${NEXT}"`)).toBe(1);
			if (answer === "all") {
				expect(focusedHeading(res.html)).toBe(
					"Keep all 2 budgets, $800 a month?",
				);
			} else {
				expect(focusedHeading(res.html)).toBe(
					`Make $650 a month your ${nameA} budget?`,
				);
				expect(textOf(res.html)).toContain(`From ${monthName(NEXT)} on.`);
			}
			// Without JavaScript the same answer is a redirect back to the page, and it writes nothing.
			const plain = await post("/first-page/budgets", fields, false);
			expect(plain.res.status).toBe(303);
			expect(plain.res.headers.get("location")).toBe("/first-page");
			await nothingWritten();
		},
	);

	it("a last-month Another amount with a refused amount gets the month-changed reply at 200, with no error and nothing typed", async () => {
		vi.setSystemTime(new Date(DRAWN));
		const drawn = await get("/first-page?budgets=one");
		vi.setSystemTime(new Date(POSTED));
		const res = await post("/first-page/budgets", [
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
		const res = await post("/first-page/budgets", [
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
		const res = await app(db).fetch("/first-page/budgets", {
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
	const FOUR =
		"Four. Tomorrow Tally keeps count on its own, and that's the fifth.";

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
			last = await post("/first-page/budgets", [
				["category", String(id)],
				["answer", "skip"],
			]);
		}
		if (!last) throw new Error("no categories");
		return last;
	}

	/** The savings forms on a page: the Save it form, then Not now. */
	const savingsFormsOf = (html: string) =>
		formsOf(html).filter((form) =>
			form.includes('action="/first-page/savings"'),
		);

	it("asks Save some each month? after the last category, with the field blank, and no Four line yet", async () => {
		const { html } = await skipAll();
		const text = textOf(html);
		expect(text).toContain(QUESTION);
		expect(text).toContain(HELP);
		expect(text).toContain(LABEL);
		expect(text).not.toContain(FOUR);
		expect(focusedHeading(html)).toBe(QUESTION);
		const forms = savingsFormsOf(html);
		expect(forms).toHaveLength(2);
		const [save, skip] = forms as [string, string];
		expect(save).toContain('name="goal"');
		expect(save).toContain('name="answer" value="save"');
		expect(save).toContain("Save it");
		expect(defaultButtonOf(save)).toContain('value="save"');
		expect(skip).toContain('name="answer" value="skip"');
		expect(skip).toContain("Not now");
		expect(skip).not.toContain('name="goal"');
		expect(html).toContain(`name="month" value="${CUR}"`);
		expect((await readFirstTally(db))?.strokes.budgets).toBeUndefined();
	});

	it("asks it at load when no category is left, not the Four line", async () => {
		await db.prepare("UPDATE categories SET archived = 1").run();
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain(QUESTION);
		expect(textOf(html)).not.toContain(FOUR);
	});

	it("asks it at load when every category already has a budget", async () => {
		for (const id of [A, B, C, D]) await homeBudget(id, 5000)(db);
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain(QUESTION);
		expect(textOf(html)).not.toContain(FOUR);
	});

	it("treats a $0 goal row for this month as no goal, so the question still asks", async () => {
		await skipAll();
		await db
			.prepare(
				"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES (?, 0)",
			)
			.bind(CUR)
			.run();
		const { html } = await get("/first-page");
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
		expect(textOf(html)).toContain(FOUR);
		expect(textOf(html)).not.toContain(QUESTION);
		expect(await savingsOf()).toBe(30000);
		expect(textOf(html)).toContain("Savings · $300 a month");
	});

	it("draws stroke four at load, with the goal's cents, when no category is left and a goal above $0 exists", async () => {
		await db.prepare("UPDATE categories SET archived = 1").run();
		await db
			.prepare(
				"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES (?, 30000)",
			)
			.bind(CUR)
			.run();
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain(FOUR);
		expect(textOf(html)).not.toContain(QUESTION);
		expect(await savingsOf()).toBe(30000);
		expect(textOf(html)).toContain("Savings · $300 a month");
	});

	it("Save it with $300 sets this month's goal, writes its line, draws stroke four, and rules off Safe to spend less the goal", async () => {
		await skipAll();
		const before = (await readMonthSummary(db, TODAY, CUR)).summary
			.safeToSpendCents;
		const res = await post("/first-page/savings", [
			["answer", "save"],
			["goal", "300"],
		]);
		expect(res.res.status).toBe(200);
		expect(await goalFor()).toBe(30000);
		expect(await savingsOf()).toBe(30000);
		expect((await readFirstTally(db))?.strokes.budgets).toBe(TODAY);
		expect(textOf(res.html)).toContain("Savings · $300 a month");
		expect(textOf(res.html)).toContain(FOUR);
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
		const res = await post("/first-page/savings", [
			["answer", "save"],
			["goal", "300.50"],
		]);
		expect(await goalFor()).toBe(30050);
		expect(await savingsOf()).toBe(30050);
		expect(textOf(res.html)).toContain("Savings · $300.50 a month");
	});

	it("replaces a $0 row for this month rather than failing on its unique key", async () => {
		await skipAll();
		await db
			.prepare(
				"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES (?, 0)",
			)
			.bind(CUR)
			.run();
		const res = await post("/first-page/savings", [
			["answer", "save"],
			["goal", "300"],
		]);
		expect(res.res.status).toBe(200);
		expect(await goalFor()).toBe(30000);
		expect(await goalRows()).toBe(1);
	});

	it("refuses a blank amount with the words under the field, and writes nothing", async () => {
		await skipAll();
		const { res, html } = await post("/first-page/savings", [
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
		const { res, html } = await post("/first-page/savings", [
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
		const bad = await post("/first-page/savings", [
			["answer", "save"],
			["goal", "lots"],
		]);
		expect(bad.res.status).toBe(422);
		expect(textOf(bad.html)).toContain(
			"Enter a dollar amount, like 250 or 250.50.",
		);
		const huge = await post("/first-page/savings", [
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
			"/first-page/savings",
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
	});

	it("Not now keeps 'skipped', writes no goal or ledger line, and draws stroke four", async () => {
		await skipAll();
		const { res, html } = await post("/first-page/savings", [
			["answer", "skip"],
		]);
		expect(res.status).toBe(200);
		expect(await savingsOf()).toBe("skipped");
		expect(await goalRows()).toBe(0);
		expect(textOf(html)).not.toContain("Savings ·");
		expect(textOf(html)).toContain(FOUR);
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
		const res = await post("/first-page/savings", [
			["answer", "save"],
			["goal", "300"],
		]);
		expect(await goalFor()).toBe(20000);
		expect(await goalRows()).toBe(1);
		expect(await savingsOf()).toBe(20000);
		expect(textOf(res.html)).toContain("Savings · $200 a month");
		expect(textOf(res.html)).toContain(FOUR);
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
		const res = await post("/first-page/savings", [["answer", "skip"]]);
		expect(await goalFor()).toBe(20000);
		expect(await savingsOf()).toBe(20000);
		expect(trigger(res.res).toast?.message).toBe(
			"Home already has a savings goal: $200 a month.",
		);
	});

	it("gets the month-changed reply for a form drawn in another month, and writes nothing", async () => {
		await skipAll();
		const { res, html } = await post("/first-page/savings", [
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
		const { res } = await post("/first-page/savings", [
			["answer", "yes"],
			["goal", "300"],
		]);
		expect(res.status).toBe(400);
		expect(await goalRows()).toBe(0);
	});

	it("writes one goal and one record when two Save its race", async () => {
		await skipAll();
		const [first, second] = await Promise.all([
			post("/first-page/savings", [
				["answer", "save"],
				["goal", "300"],
			]),
			post("/first-page/savings", [
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

	it("writes nothing for an answer after stroke four, and gets the stale reply", async () => {
		await skipAll();
		await post("/first-page/savings", [["answer", "skip"]]);
		const { res } = await post("/first-page/savings", [
			["answer", "save"],
			["goal", "500"],
		]);
		expect(trigger(res).toast).toEqual({
			message: "That one is already answered.",
			type: "info",
		});
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
		const { res, html } = await post("/first-page/savings", [
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
	});

	it("keeps the answer through a take-back, and the re-ask draws stroke four with no second question", async () => {
		await skipAll();
		await post("/first-page/savings", [
			["answer", "save"],
			["goal", "300"],
		]);
		await takeBackQuestionStrokes(db, "Wells Fargo").run();
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain(FOUR);
		expect(textOf(html)).not.toContain(QUESTION);
		expect(await savingsOf()).toBe(30000);
		expect(await goalFor()).toBe(30000);
		expect(textOf(html)).toContain("Savings · $300 a month");
	});
});

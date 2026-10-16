import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { insertBill } from "../src/bills/write";
import { DEFAULT_TIME_ZONE, daysBefore, shortDay, todayIn } from "../src/dates";
import { markStroke, readFirstTally } from "../src/db/first-tally";
import { saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import {
	answerPay,
	type PayMerchant,
	payMerchants,
} from "../src/first-tally/first-page";
import { firstPage } from "../src/routes/first-page";

// The question page at /first-page (P125 E, spec §8.8, decision 114): one question at a time, each answer written
// to the family's transactions or bills, the stroke drawn when its step is done, every swap announced. These tests
// name each bullet of issue #589's "Tests first" list.

const db = env.DB;
const BASE = "http://tally.test";
const TODAY = todayIn(DEFAULT_TIME_ZONE);
/** Stroke one was drawn two days ago, so the questions are open today (the household day after it, spec §8.8). */
const STROKE_ONE = daysBefore(TODAY, 2);

/**
 * The app with the page mounted, as the family app serves it (`demo` decides the 404), with a verified identity.
 * `DB` is the database the page reads and writes (the test's own unless a test wraps it).
 */
function app(demo: boolean, DB: D1Database = db) {
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
				{ ...env, DB, DEMO: demo ? "true" : "false" } as unknown as Env,
				{ waitUntil() {}, passThroughOnException() {}, props: {} },
			);
		},
	};
}

const family = app(false);

async function get(path: string) {
	const res = await family.fetch(path);
	return { res, html: await res.text() };
}

async function post(
	path: string,
	fields: Record<string, string>,
	htmx = false,
) {
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

const trigger = (res: Response) =>
	JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
		toast?: { message: string; type: string };
		announce?: string;
	};

/** The page's words: a link's tags leave no space behind (so "Possible bills." reads whole), other tags a space. */
const textOf = (html: string) =>
	html
		.replace(/<\/?a\b[^>]*>/g, "")
		.replace(/<[^>]+>/g, " ")
		.replaceAll("&#39;", "'")
		.replaceAll("&quot;", '"')
		.replaceAll("&amp;", "&")
		.replace(/\s+/g, " ");

let seq = 0;
/** One imported bank line on the one connected bank (account 1). `over` sets the columns that differ. */
async function txn(over: Record<string, unknown>) {
	seq += 1;
	const row: Record<string, unknown> = {
		account_id: 1,
		plaid_transaction_id: `first-page-${seq}`,
		date: TODAY,
		amount_cents: 1200,
		raw_name: `SHOP ${seq}`,
		category_id: await categoryId(),
		category_source: "user",
		category_confidence: 90,
		income_confidence: 0,
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

let cachedCategory: number | null = null;
async function categoryId() {
	if (cachedCategory === null) {
		const row = await db
			.prepare(
				"SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1",
			)
			.first<{ id: number }>();
		cachedCategory = row?.id ?? 1;
	}
	return cachedCategory;
}

/** Deposits every `days` days, `count` of them, ending on TODAY, each `cents` (or the list's own amount). */
async function deposits(
	raw: string,
	cents: number | number[],
	count: number,
	days = 14,
	over: Record<string, unknown> = {},
) {
	for (let i = 0; i < count; i += 1) {
		const date = daysBefore(TODAY, (count - 1 - i) * days);
		await txn({
			raw_name: raw,
			date,
			amount_cents: -(typeof cents === "number" ? cents : (cents[i] as number)),
			flag_income: 1,
			plaid_category: "INCOME",
			...over,
		});
	}
}

/** A repeat charge found by Possible bills: two charges about a month apart, same amount. */
async function charge(raw: string, cents: number, categorized = true) {
	for (const days of [30, 0]) {
		await txn({
			raw_name: raw,
			date: daysBefore(TODAY, days),
			amount_cents: cents,
			category_id: categorized ? await categoryId() : null,
			category_source: categorized ? "user" : null,
			flag_income: 0,
			income_confidence: 0,
		});
	}
}

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await db.prepare("DELETE FROM transactions").run();
	await db.prepare("DELETE FROM bill_payments").run();
	await db.prepare("DELETE FROM bills").run();
	await db.prepare("DELETE FROM merchants").run();
	await db.prepare("DELETE FROM accounts").run();
	await db.prepare("DELETE FROM plaid_items").run();
	await db
		.prepare("DELETE FROM household_settings WHERE key = 'first_tally'")
		.run();
	cachedCategory = null;
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
});

describe("the gate", () => {
	it("redirects to Home while the questions are shut", async () => {
		await db.prepare("UPDATE plaid_items SET history_complete_at = NULL").run();
		const { res } = await get("/first-page");
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/");
	});

	it("opens the page once the gate is open", async () => {
		const { res } = await get("/first-page");
		expect(res.status).toBe(200);
	});
});

describe("the family app only", () => {
	it("is a 404 in the demo, for the page and its answers", async () => {
		const demo = app(true);
		expect((await demo.fetch("/first-page")).status).toBe(404);
		const answer = await demo.fetch("/first-page/pay", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "merchant=X&answer=yes",
		});
		expect(answer.status).toBe(404);
	});
});

describe("pay questions from data", () => {
	it("asks one question per merchant, Maybe income included", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 3);
		await deposits("SIDE GIG", 4000, 2, 30, {
			flag_income: 0,
			income_confidence: 0.5,
		});
		const first = await get("/first-page");
		expect(first.html.match(/Is this your pay\?/g)?.length).toBe(1);
		expect(first.html).toContain("ACME CORP PAYROLL");
		expect(first.html).not.toContain("SIDE GIG");
		await post("/first-page/pay", {
			merchant: "ACME CORP PAYROLL",
			answer: "yes",
		});
		const second = await get("/first-page");
		expect(second.html).toContain("SIDE GIG");
	});

	it("gives a range when a merchant's deposits vary", async () => {
		await deposits("ACME CORP PAYROLL", [230000, 260000, 245000], 3);
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain("$2,300 to $2,600, 3 times since");
	});

	it("names the cadence from the dates", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 4, 14);
		const { html } = await get("/first-page");
		const weekday = new Date(`${TODAY}T00:00:00Z`).toLocaleDateString("en-US", {
			weekday: "long",
			timeZone: "UTC",
		});
		expect(textOf(html)).toContain(
			`paying $2,450 every other ${weekday}, 4 times since`,
		);
	});
});

describe("Yes and No writes", () => {
	it("Yes marks the merchant's money in as income, as the person's choice", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const { res } = await post("/first-page/pay", {
			merchant: "ACME CORP PAYROLL",
			answer: "yes",
		});
		expect(res.status).toBe(303);
		const rows = await db
			.prepare(
				"SELECT flag_income, income_source FROM transactions WHERE raw_name = 'ACME CORP PAYROLL'",
			)
			.all<{ flag_income: number; income_source: string }>();
		expect(
			rows.results.every(
				(row) => row.flag_income === 1 && row.income_source === "user",
			),
		).toBe(true);
	});

	it("No marks it as not income, as the person's choice", async () => {
		await deposits("TRANSFER IN", 50000, 2, 14, {
			flag_income: 0,
			income_confidence: 0.5,
		});
		await post("/first-page/pay", { merchant: "TRANSFER IN", answer: "no" });
		const rows = await db
			.prepare(
				"SELECT flag_income, income_source FROM transactions WHERE raw_name = 'TRANSFER IN'",
			)
			.all<{ flag_income: number; income_source: string }>();
		expect(
			rows.results.every(
				(row) => row.flag_income === 0 && row.income_source === "user",
			),
		).toBe(true);
	});

	it("draws the pay stroke after the last answer, and not before", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		await deposits("SIDE GIG", 4000, 2, 30, {
			flag_income: 0,
			income_confidence: 0.5,
		});
		await post("/first-page/pay", {
			merchant: "ACME CORP PAYROLL",
			answer: "yes",
		});
		expect((await readFirstTally(db))?.strokes.pay).toBeUndefined();
		await post("/first-page/pay", { merchant: "SIDE GIG", answer: "no" });
		expect((await readFirstTally(db))?.strokes.pay).toBe(TODAY);
	});

	it("does not ask an answered merchant again after a reload", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		await deposits("SIDE GIG", 4000, 2, 30, {
			flag_income: 0,
			income_confidence: 0.5,
		});
		await post("/first-page/pay", {
			merchant: "ACME CORP PAYROLL",
			answer: "yes",
		});
		const { html } = await get("/first-page");
		expect(textOf(html)).not.toContain("ACME CORP PAYROLL paying");
		expect(html).toContain("SIDE GIG");
	});

	it("a stale answer for a merchant with nothing left to ask changes nothing", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		await post("/first-page/pay", {
			merchant: "ACME CORP PAYROLL",
			answer: "yes",
		});
		const before = await db
			.prepare(
				"SELECT updated_at FROM transactions WHERE raw_name = 'ACME CORP PAYROLL'",
			)
			.all();
		const { res } = await post(
			"/first-page/pay",
			{ merchant: "ACME CORP PAYROLL", answer: "no" },
			true,
		);
		expect(trigger(res).toast?.type).toBe("info");
		const after = await db
			.prepare(
				"SELECT updated_at FROM transactions WHERE raw_name = 'ACME CORP PAYROLL'",
			)
			.all();
		expect(after.results).toEqual(before.results);
		expect((await readFirstTally(db))?.pay?.["ACME CORP PAYROLL"]?.answer).toBe(
			"yes",
		);
	});

	it("a second answer from a stale read changes nothing and leaves the first's record and flags agreeing", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const merchant = (await payMerchants(db))[0] as PayMerchant;
		expect(
			await answerPay(db, merchant, "yes", "person@example.com"),
		).toBeGreaterThan(0);
		expect(await answerPay(db, merchant, "no", "person@example.com")).toBe(0);
		expect((await readFirstTally(db))?.pay?.["ACME CORP PAYROLL"]).toEqual({
			answer: "yes",
			deposits: merchant.deposits,
			at: 0,
		});
		const rows = await db
			.prepare(
				"SELECT flag_income, income_source FROM transactions WHERE raw_name = 'ACME CORP PAYROLL'",
			)
			.all<{ flag_income: number; income_source: string }>();
		expect(
			rows.results.every(
				(row) => row.flag_income === 1 && row.income_source === "user",
			),
		).toBe(true);
	});

	it("answers a No that a competing Yes beat with the page as it is, as info, and keeps the Yes", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const merchant = (await payMerchants(db))[0] as PayMerchant;
		let raced = false;
		// The competing Yes lands just before this reply's own batch, so the reply's No changes no row.
		const racing = new Proxy(db, {
			get(target, prop) {
				if (prop === "batch" && !raced) {
					return async (statements: D1PreparedStatement[]) => {
						raced = true;
						await answerPay(target, merchant, "yes", "person@example.com");
						return target.batch(statements);
					};
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const res = await app(false, racing).fetch("/first-page/pay", {
			method: "POST",
			redirect: "manual",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"HX-Request": "true",
			},
			body: new URLSearchParams({
				merchant: "ACME CORP PAYROLL",
				answer: "no",
			}).toString(),
		});
		const html = await res.text();
		expect(res.status).toBe(200);
		expect(trigger(res).toast).toEqual({
			message: "That one is already answered.",
			type: "info",
		});
		expect(trigger(res).announce).toBe("That one is already answered.");
		expect(html).not.toContain("Saved");
		expect(html).not.toContain("Is this your pay?");
		expect(textOf(html)).toMatch(/Pay · /);
		expect((await readFirstTally(db))?.pay?.["ACME CORP PAYROLL"]?.answer).toBe(
			"yes",
		);
	});

	it("a deposit added between loading the question and answering it stays unanswered and is asked next", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		let raced = false;
		// A deposit arrives after the question was read and before this reply's batch: the answer must leave it alone.
		const racing = new Proxy(db, {
			get(target, prop) {
				if (prop === "batch" && !raced) {
					return async (statements: D1PreparedStatement[]) => {
						raced = true;
						await txn({
							raw_name: "ACME CORP PAYROLL",
							date: daysBefore(TODAY, 7),
							amount_cents: -245000,
							flag_income: 1,
							plaid_category: "INCOME",
						});
						return target.batch(statements);
					};
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const res = await app(false, racing).fetch("/first-page/pay", {
			method: "POST",
			redirect: "manual",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				merchant: "ACME CORP PAYROLL",
				answer: "yes",
			}).toString(),
		});
		expect(res.status).toBe(303);
		const late = await db
			.prepare(
				"SELECT flag_income, income_source FROM transactions WHERE raw_name = 'ACME CORP PAYROLL' AND date = ?",
			)
			.bind(daysBefore(TODAY, 7))
			.first<{ flag_income: number; income_source: string | null }>();
		expect(late).toEqual({ flag_income: 1, income_source: null });
		const answered = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE raw_name = 'ACME CORP PAYROLL' AND income_source = 'user'",
			)
			.first<{ n: number }>();
		expect(answered?.n).toBe(2);
		const record = await readFirstTally(db);
		expect(record?.pay?.["ACME CORP PAYROLL"]?.deposits).toHaveLength(2);
		expect(record?.strokes.pay).toBeUndefined();
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain("ACME CORP PAYROLL paying");
	});
});

describe("bills: the exclusions and the one-tap keep", () => {
	it("keeps the found charges in one tap and leaves out one with no category", async () => {
		await charge("NETFLIX", 1549);
		await charge("GYM", 4500, false);
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain("Keep this one as a bill?");
		expect(textOf(html)).toContain("1 more waits in Possible bills.");
	});

	it("leaves out a charge over $100,000", async () => {
		await charge("MORTGAGE", 10_000_001);
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain("1 more waits in Possible bills.");
		expect(textOf(html)).toContain("Nothing here to keep in one tap.");
	});

	it("leaves out both charges whose names collide", async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('NETFLIX A', 'Netflix'), ('NETFLIX B', 'netflix')",
			)
			.run();
		await charge("NETFLIX A", 1549);
		await charge("NETFLIX B", 1299);
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain("2 more wait in Possible bills.");
	});

	it("keeps the bills through the Add bill path, and draws the bills stroke", async () => {
		await charge("NETFLIX", 1549);
		const { res } = await post("/first-page/bills", {});
		expect(res.status).toBe(303);
		const bills = await db
			.prepare(
				"SELECT name, amount_cents, merchant_raw_name FROM bills WHERE active = 1",
			)
			.all<{ name: string; amount_cents: number; merchant_raw_name: string }>();
		expect(bills.results).toEqual([
			{ name: "Netflix", amount_cents: 1549, merchant_raw_name: "NETFLIX" },
		]);
		expect((await readFirstTally(db))?.strokes.bills).toBe(TODAY);
	});

	it("says an empty bills step names what waits and counts as done", async () => {
		await charge("GYM", 4500, false);
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain("Nothing here to keep in one tap.");
		expect(textOf(html)).toContain("1 more waits in Possible bills.");
		expect((await readFirstTally(db))?.strokes.bills).toBe(TODAY);
	});
});

describe("empty steps", () => {
	it("says no paycheck was spotted, and counts the pay step done", async () => {
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain(
			"Tally didn't spot a paycheck. You can mark one from any transaction later.",
		);
		expect((await readFirstTally(db))?.strokes.pay).toBe(TODAY);
	});
});

describe("announcements and focus", () => {
	it("announces each answer in an HX-Trigger with toast and announce, and focuses the next question's heading", async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('ACME CORP PAYROLL', 'Acme Corp')",
			)
			.run();
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const { res, html } = await post(
			"/first-page/pay",
			{ merchant: "ACME CORP PAYROLL", answer: "yes" },
			true,
		);
		expect(res.status).toBe(200);
		const headers = trigger(res);
		expect(headers.announce).toBe("Saved: Acme Corp is your pay.");
		expect(headers.toast?.message).toBe("Saved: Acme Corp is your pay.");
		expect(html).toContain('id="first-page"');
		expect(html).toContain('tabindex="-1"');
		expect(html).toContain("autofocus");
		expect(html).toContain("first-line-new");
		const { html: page } = await get("/first-page");
		expect(page).not.toContain("first-line-new");
	});

	it("announces a kept bills step with its count", async () => {
		await charge("NETFLIX", 1549);
		await charge("SPOTIFY", 1199);
		const { res } = await post("/first-page/bills", {}, true);
		expect(trigger(res).announce).toBe("Kept 2 bills.");
	});
});

describe("the bank's head lines, before any answer", () => {
	it("says the bank, its lines and their dates, and the transfers left out", async () => {
		const first = daysBefore(TODAY, 9);
		await txn({ date: first, raw_name: "COFFEE", amount_cents: 500 });
		await txn({
			date: daysBefore(TODAY, 3),
			raw_name: "GROCER",
			amount_cents: 4000,
		});
		await txn({
			date: TODAY,
			raw_name: "TRANSFER TO SAVINGS",
			amount_cents: 20000,
			flag_transfer: 1,
			excluded: 1,
			excluded_source: "plaid",
		});
		// A transfer put back in the budget is not left out: it counts as spending, so it isn't "left out".
		await txn({
			date: daysBefore(TODAY, 2),
			raw_name: "TRANSFER BACK IN",
			amount_cents: 3000,
			flag_transfer: 1,
			excluded: 0,
			excluded_source: "user",
		});
		// A transfer that pays a bill counts once as the bill, so it isn't "left out" either.
		await txn({
			date: daysBefore(TODAY, 1),
			raw_name: "TRANSFER TO PHONE",
			amount_cents: 6000,
			flag_transfer: 1,
			excluded: 1,
			excluded_source: "jev",
		});
		await insertBill(
			db,
			{
				name: "Phone",
				amountCents: 6000,
				dueDay: 5,
				frequency: "monthly",
				anchorMonth: null,
				categoryId: await categoryId(),
				merchantRawName: "PHONE CO",
			},
			TODAY,
		);
		const phone = await db
			.prepare(
				"SELECT t.id AS txn, b.id AS bill FROM transactions t, bills b WHERE t.raw_name = 'TRANSFER TO PHONE' AND b.name = 'Phone'",
			)
			.first<{ txn: number; bill: number }>();
		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, ?, ?, 'auto', 'linked')",
			)
			.bind(phone?.bill, TODAY.slice(0, 7), phone?.txn)
			.run();
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain(
			`From Chase · 5 lines · ${shortDay(first, TODAY)} to ${shortDay(TODAY, TODAY)}`,
		);
		expect(textOf(html)).toContain("Moves between your accounts · 1 left out");
	});
});

describe("the answer's motion", () => {
	it("marks the notebook's pay line for its one-shot draw when the reply draws the pay stroke", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		await charge("NETFLIX", 1549);
		const { html } = await post(
			"/first-page/pay",
			{ merchant: "ACME CORP PAYROLL", answer: "yes" },
			true,
		);
		// The pay stroke is the second of the five, and the bills step still has a charge to keep: only its line draws.
		expect(html.match(/first-stroke-new/g)).toHaveLength(1);
		expect(html).toMatch(
			/<line x1="53" y1="38" x2="53" y2="60" class="stroke-ink first-stroke-new"/,
		);
	});

	it("marks every line the reply drew, when an empty step after the answer is done too", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const { html } = await post(
			"/first-page/pay",
			{ merchant: "ACME CORP PAYROLL", answer: "yes" },
			true,
		);
		// Pay is the last merchant, and no bill charge is found: the pay and the bills strokes are drawn together.
		expect(html.match(/first-stroke-new/g)).toHaveLength(2);
		expect(html).toMatch(
			/<line x1="53" y1="38" x2="53" y2="60" class="stroke-ink first-stroke-new"/,
		);
		expect(html).toMatch(
			/<line x1="60" y1="38" x2="60" y2="60" class="stroke-ink first-stroke-new"/,
		);
	});

	it("marks the bills stroke when the kept bills draw it", async () => {
		await charge("NETFLIX", 1549);
		await charge("SPOTIFY", 1199);
		const { html } = await post("/first-page/bills", {}, true);
		expect(html).toMatch(
			/<line x1="60" y1="38" x2="60" y2="60" class="stroke-ink first-stroke-new"/,
		);
	});

	it("marks no notebook line when the reply draws no stroke", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		await deposits("SIDE GIG", 4000, 2, 30, {
			flag_income: 0,
			income_confidence: 0.5,
		});
		const { html } = await post(
			"/first-page/pay",
			{ merchant: "ACME CORP PAYROLL", answer: "yes" },
			true,
		);
		expect(html).toContain("first-line-new");
		expect(html).not.toContain("first-stroke-new");
	});

	it("marks no line and no stroke for a stale answer, which writes nothing", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const { res, html } = await post(
			"/first-page/pay",
			{ merchant: "GONE MERCHANT", answer: "yes" },
			true,
		);
		expect(trigger(res).announce).toBe("That one is already answered.");
		expect(html).not.toContain("first-line-new");
		expect(html).not.toContain("first-stroke-new");
	});

	it("marks nothing on a plain page load", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const { html } = await get("/first-page");
		expect(html).not.toContain("first-line-new");
		expect(html).not.toContain("first-stroke-new");
	});

	it("rises the line the reply wrote, even when it sorts before a line already there", async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('ACME CORP', 'Acme Corp'), ('ZED CO', 'Zed Co')",
			)
			.run();
		await deposits("ZED CO", 245000, 2);
		await deposits("ACME CORP", 245000, 2);
		await post("/first-page/pay", { merchant: "ZED CO", answer: "yes" }, true);
		const { html } = await post(
			"/first-page/pay",
			{ merchant: "ACME CORP", answer: "yes" },
			true,
		);
		expect(html).toMatch(
			/class="py-2 text-ink first-line-new">Pay · Acme Corp,/,
		);
		expect(html).not.toMatch(/first-line-new">Pay · Zed Co/);
		// The ledger is in the order each merchant was first answered: Zed was answered first, though its name sorts after Acme's.
		expect(html.indexOf("Pay · Zed Co")).toBeLessThan(
			html.indexOf("Pay · Acme Corp"),
		);
	});

	it("keeps the answer order for a numeric merchant key, which JSON lists first", async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('ACME CORP', 'Acme Corp'), ('1234', 'Bistro 1234')",
			)
			.run();
		await deposits("ACME CORP", 245000, 2);
		await deposits("1234", 9000, 2);
		await post(
			"/first-page/pay",
			{ merchant: "ACME CORP", answer: "yes" },
			true,
		);
		const { html } = await post(
			"/first-page/pay",
			{ merchant: "1234", answer: "yes" },
			true,
		);
		expect(html).toMatch(
			/class="py-2 text-ink first-line-new">Pay · Bistro 1234,/,
		);
		expect(html).not.toMatch(/first-line-new">Pay · Acme Corp/);
		expect(html.indexOf("Pay · Acme Corp")).toBeLessThan(
			html.indexOf("Pay · Bistro 1234"),
		);
	});
});

describe("the waiting line names Possible bills once", () => {
	const count = (html: string) =>
		(textOf(html).match(/Possible bills/g) ?? []).length;

	it("in the bills question", async () => {
		await charge("NETFLIX", 1549);
		await charge("GYM", 4500, false);
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain("Keep this one as a bill?");
		expect(textOf(html)).toContain("1 more waits in Possible bills.");
		expect(count(html)).toBe(1);
	});

	it("in the empty bills step", async () => {
		await charge("GYM", 4500, false);
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain("1 more waits in Possible bills.");
		expect(count(html)).toBe(1);
	});

	it("in the done step, after a keep leaves one charge waiting", async () => {
		await charge("NETFLIX", 1549);
		await charge("GYM", 4500, false);
		await post("/first-page/bills", {});
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain("Pay and bills are done.");
		expect(textOf(html)).toContain("1 more waits in Possible bills.");
		expect(count(html)).toBe(1);
	});
});

describe("a split purchase in the bank's head lines", () => {
	it("counts the split purchase once, as the bank's one line", async () => {
		const first = daysBefore(TODAY, 9);
		await txn({ date: first, raw_name: "COFFEE", amount_cents: 500 });
		await txn({
			date: daysBefore(TODAY, 3),
			raw_name: "GROCER",
			amount_cents: 4000,
		});
		await txn({ date: TODAY, raw_name: "COSTCO", amount_cents: 18742 });
		const costco = await db
			.prepare("SELECT id FROM transactions WHERE raw_name = 'COSTCO'")
			.first<{ id: number }>();
		const category = await categoryId();
		const split = await saveSplit(
			db,
			costco?.id as number,
			[
				{ categoryId: category, amountCents: 6000 },
				{ categoryId: category, amountCents: 6000 },
				{ categoryId: category, amountCents: 6742 },
			],
			"person@example.com",
		);
		expect(split.saved).toBe(true);
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain(
			`From Chase · 3 lines · ${shortDay(first, TODAY)} to ${shortDay(TODAY, TODAY)}`,
		);
	});
});

describe("refunds and the Yes write", () => {
	it("does not ask a refund linked to a purchase, even with a Maybe guess on it", async () => {
		await txn({
			raw_name: "STORE",
			date: daysBefore(TODAY, 3),
			amount_cents: 2500,
		});
		const purchase = await db
			.prepare("SELECT id FROM transactions WHERE raw_name = 'STORE'")
			.first<{ id: number }>();
		await txn({
			raw_name: "STORE REFUND",
			date: TODAY,
			amount_cents: -2500,
			refund_of_id: purchase?.id,
			flag_income: 0,
			income_confidence: 0.5,
		});
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain(
			"Tally didn't spot a paycheck. You can mark one from any transaction later.",
		);
		expect(html).not.toContain("STORE REFUND");
		await post("/first-page/pay", {
			merchant: "STORE REFUND",
			answer: "yes",
		});
		const row = await db
			.prepare(
				"SELECT flag_income, income_source FROM transactions WHERE raw_name = 'STORE REFUND'",
			)
			.first<{ flag_income: number; income_source: string | null }>();
		expect(row).toEqual({ flag_income: 0, income_source: null });
	});

	it("Yes clears the Maybe guess, as the review's Yes does", async () => {
		await deposits("SIDE GIG", 4000, 2, 30, {
			flag_income: 0,
			income_confidence: 0.5,
		});
		await post("/first-page/pay", { merchant: "SIDE GIG", answer: "yes" });
		const rows = await db
			.prepare(
				"SELECT income_confidence FROM transactions WHERE raw_name = 'SIDE GIG'",
			)
			.all<{ income_confidence: number | null }>();
		expect(rows.results).toHaveLength(2);
		expect(rows.results.every((row) => row.income_confidence === null)).toBe(
			true,
		);
	});
});

/** A bill added from the Bills page: the Add bill write, as the page's own Rent (no charge matches it). */
const rentBill = async () =>
	insertBill(
		db,
		{
			name: "Rent",
			amountCents: 100000,
			dueDay: 1,
			frequency: "monthly",
			anchorMonth: null,
			categoryId: await categoryId(),
			merchantRawName: "RENT CO",
		},
		TODAY,
	);

describe("keeping bills links the charges they paid", () => {
	it("links a charge already paid this period after Keep, so that occurrence isn't due", async () => {
		await charge("NETFLIX", 1549);
		await post("/first-page/bills", {});
		const links = await db
			.prepare(
				"SELECT bp.period, t.date FROM bill_payments bp JOIN transactions t ON t.id = bp.transaction_id WHERE bp.status = 'linked' AND t.date = ?",
			)
			.bind(TODAY)
			.all<{ period: string; date: string }>();
		expect(links.results).toEqual([{ period: TODAY.slice(0, 7), date: TODAY }]);
	});
});

describe("the bills ledger line reads what the step recorded", () => {
	it("doesn't count a bill added on the Bills page the same day", async () => {
		await charge("NETFLIX", 1500);
		await post("/first-page/bills", {});
		await rentBill();
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain("Bills · 1 kept, about $15 a month");
		expect(textOf(html)).not.toContain("Bills · 2 kept");
	});

	it("shows no kept line for an empty step, when a bill is added that day", async () => {
		await charge("GYM", 4500, false);
		await get("/first-page");
		await rentBill();
		const { html } = await get("/first-page");
		expect(html).not.toMatch(/Bills · \d+ kept/);
	});

	it("adds a second Keep to the line, rather than replacing the first", async () => {
		await charge("NETFLIX", 1500);
		await post("/first-page/bills", {});
		await charge("SPOTIFY", 1200);
		await post("/first-page/bills", {});
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain("Bills · 2 kept, about $27 a month");
	});
});

describe("a Keep that fails part-way", () => {
	it("still counts the bill it kept, and a retry counts the rest", async () => {
		await charge("NETFLIX", 1549);
		await charge("SPOTIFY", 1199);
		// The first bill goes in; the second is refused by the database, so the Keep errors after one bill.
		await db
			.prepare(
				"CREATE TRIGGER fail_keep BEFORE INSERT ON bills WHEN (SELECT COUNT(*) FROM bills) > 0 BEGIN SELECT RAISE(ABORT, 'forced'); END",
			)
			.run();
		try {
			const failed = await post("/first-page/bills", {});
			expect(failed.res.status).toBe(500);
		} finally {
			await db.prepare("DROP TRIGGER IF EXISTS fail_keep").run();
		}
		const kept = await db
			.prepare("SELECT amount_cents FROM bills")
			.all<{ amount_cents: number }>();
		expect(kept.results).toHaveLength(1);
		expect((await readFirstTally(db))?.bills).toEqual({
			kept: 1,
			cents: kept.results[0]?.amount_cents,
		});

		const { res, html } = await post("/first-page/bills", {}, true);
		expect(trigger(res).toast?.message).toBe("Kept 1 bill.");
		expect((await readFirstTally(db))?.bills).toEqual({
			kept: 2,
			cents: 2748,
		});
		expect((await readFirstTally(db))?.strokes.bills).toBe(TODAY);
		expect(textOf(html)).toContain("Bills · 2 kept, about $27 a month");
	});
});

describe("the pay question's scope", () => {
	it("asks a flagged income that a credit review reviewed, and Yes writes the person's choice", async () => {
		await deposits("CREDIT PAY", 245000, 2, 14, {
			credit_reviewed: 1,
			income_source: "jev",
		});
		const { html } = await get("/first-page");
		expect(html).toContain("CREDIT PAY");
		await post("/first-page/pay", { merchant: "CREDIT PAY", answer: "yes" });
		const rows = await db
			.prepare(
				"SELECT income_source FROM transactions WHERE raw_name = 'CREDIT PAY'",
			)
			.all<{ income_source: string }>();
		expect(rows.results.every((row) => row.income_source === "user")).toBe(
			true,
		);
	});

	it("doesn't ask an excluded deposit or a transfer in, and answering either changes no row", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2, 14, {
			excluded: 1,
			excluded_source: "jev",
		});
		await deposits("XFER FROM SAVINGS", 50000, 2, 14, { flag_transfer: 1 });
		const { html } = await get("/first-page");
		expect(html).not.toContain("Is this your pay?");
		expect(textOf(html)).toContain(
			"Tally didn't spot a paycheck. You can mark one from any transaction later.",
		);
		const rows = () =>
			db
				.prepare(
					"SELECT id, flag_income, income_source, excluded, flag_transfer FROM transactions WHERE raw_name IN ('ACME CORP PAYROLL', 'XFER FROM SAVINGS') ORDER BY id",
				)
				.all();
		const before = await rows();
		await post("/first-page/pay", {
			merchant: "ACME CORP PAYROLL",
			answer: "yes",
		});
		await post("/first-page/pay", {
			merchant: "XFER FROM SAVINGS",
			answer: "no",
		});
		expect((await rows()).results).toEqual(before.results);
	});

	it("asks a flagged income the person reviewed as a credit, since only the answer settles it", async () => {
		await deposits("REVIEWED PAY", 245000, 2, 14, {
			credit_reviewed: 1,
			credit_reviewed_by: "user",
		});
		const { html } = await get("/first-page");
		expect(html).toContain("REVIEWED PAY");
		expect(html.match(/Is this your pay\?/g)?.length).toBe(1);
	});
});

describe("the pay ledger reads what the page recorded", () => {
	/**
	 * Acme Corp, with the two deposits the pay question asks about (flagged income, not yet decided), and two it leaves
	 * out: a deposit the Transactions panel marked as income, and a split part. Yes answers the two.
	 */
	async function acmeYesWithExtras() {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('ACME CORP', 'Acme Corp')",
			)
			.run();
		await deposits("ACME CORP", 245000, 2);
		await deposits("ACME CORP", 90000, 1, 14, { income_source: "user" });
		await txn({
			raw_name: "ACME CORP",
			date: TODAY,
			amount_cents: 18742,
			is_split: 1,
		});
		const parent = await db
			.prepare(
				"SELECT id FROM transactions WHERE raw_name = 'ACME CORP' AND is_split = 1",
			)
			.first<{ id: number }>();
		await txn({
			raw_name: "ACME CORP",
			date: TODAY,
			amount_cents: -6000,
			parent_id: parent?.id,
			flag_income: 1,
			income_source: "user",
		});
		await post("/first-page/pay", { merchant: "ACME CORP", answer: "yes" });
	}

	it("a deposit the Transactions panel marked adds nothing to a Yes's pay line", async () => {
		await acmeYesWithExtras();
		const { html } = await get("/first-page");
		expect(textOf(html)).toMatch(/Pay · Acme Corp, \$2,450 every other \w+/);
		expect(textOf(html)).not.toContain("$900");
		expect(textOf(html).match(/Pay · /g)).toHaveLength(1);
	});

	it("a split part adds nothing to a Yes's pay line, and no extra line appears", async () => {
		await acmeYesWithExtras();
		const { html } = await get("/first-page");
		expect(textOf(html)).toMatch(/Pay · Acme Corp, \$2,450 every other \w+/);
		expect(textOf(html)).not.toContain("$60");
		expect(textOf(html).match(/Pay · /g)).toHaveLength(1);
	});

	it("adds no ledger line for a No answer, and the bank's lines show again", async () => {
		await deposits("TRANSFER IN", 50000, 2, 14, {
			flag_income: 0,
			income_confidence: 0.5,
		});
		await post("/first-page/pay", { merchant: "TRANSFER IN", answer: "no" });
		const { html } = await get("/first-page");
		expect(textOf(html)).not.toMatch(/Not pay|Pay · /);
		expect(textOf(html)).toContain("From Chase");
	});
});

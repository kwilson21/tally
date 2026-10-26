import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, daysBefore, todayIn } from "../src/dates";
import { AI_SWITCHES_ALL_ON } from "../src/db/ai-switches";
import {
	markStroke,
	readFirstTally,
	STROKES,
	takeBackQuestionStrokes,
} from "../src/db/first-tally";
import { suggestionQueue } from "../src/db/suggestions-queue";
import { resetDemo } from "../src/demo/reset";
import {
	answerPay,
	type PayMerchant,
	payMerchants,
} from "../src/first-tally/first-page";
import { shownPayValues } from "../src/first-tally/pay";
import { firstPage } from "../src/routes/first-page";
import { setupRoute } from "../src/routes/setup";

// The setup questions (P142 A, spec §8.8, decision 148, #773): one question at a time at /setup, each answer written to the
// family's transactions or bills, the stroke drawn when its step is done, every swap announced. The answers are POSTs to
// /setup/*; /first-page sends a family to /setup. These tests name each bullet of issue #589's "Tests first" list.

const db = env.DB;
const BASE = "http://tally.test";
const TODAY = todayIn(DEFAULT_TIME_ZONE);
/** Stroke one was drawn two days ago, so the questions are open today (spec §8.8, decision 146: no wait for a later day). */
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
	router.route("/", setupRoute);
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
	fields: Record<string, string> | [string, string][],
	htmx = false,
	DB: D1Database = db,
) {
	const res = await app(false, DB).fetch(path, {
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

/**
 * The hidden fields a form submits under one name, one pair per field, unescaped as the browser sends them (the `&amp;`
 * last, as textOf does).
 */
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

/** The `keep` fields a Keep form submits for the charges its page shows. A test that keeps the page's charges posts these. */
function keepFields(html: string): [string, string][] {
	return hiddenFields(html, "keep");
}

/** The `deposit` fields a pay form submits: one per deposit its question shows. */
function payFields(html: string): [string, string][] {
	return hiddenFields(html, "deposit");
}

/** The `deposit` fields a pay answer posts for a merchant, the values shownPayValues gives its deposits as payMerchants reads them now. */
function depositFields(merchant: PayMerchant): [string, string][] {
	return shownPayValues(merchant).map((value): [string, string] => [
		"deposit",
		value,
	]);
}

/** A merchant's deposits as the pay record keeps them under one answer: each by its transaction id. */
function byId(merchant: PayMerchant) {
	return Object.fromEntries(
		merchant.ids.map((id, i) => [String(id), merchant.deposits[i]]),
	);
}

/** Keep, as the page's own form does it: the page is read, and the charges it shows are the ones posted. */
async function keepAsShown(htmx = false) {
	return post("/setup/bills", keepFields((await get("/setup")).html), htmx);
}

/**
 * Yes or No, as the page's own form posts it: the page is read, and its first question's merchant, deposit fields and
 * answer are posted.
 */
async function answerAsShown(answer: "yes" | "no", htmx = false) {
	const { html } = await get("/setup");
	return post(
		"/setup/pay",
		[...hiddenFields(html, "merchant"), ...payFields(html), ["answer", answer]],
		htmx,
	);
}

/**
 * Yes or No for a merchant the page doesn't ask first, or doesn't ask at all: posted with the deposits its question
 * would show, and none when nothing is asked about it (so the reply is stale).
 */
async function answerFor(key: string, answer: "yes" | "no", htmx = false) {
	const merchant = (await payMerchants(db)).find((m) => m.key === key);
	return post(
		"/setup/pay",
		[
			["merchant", key],
			...(merchant ? depositFields(merchant) : []),
			["answer", answer],
		],
		htmx,
	);
}

/**
 * The test database with `hook` run once, against the database itself, just before its first batch: the write a sync or
 * a competing answer makes between a reply's check and its own batch. Every other call forwards to the database.
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
	it("sends the old page to /setup, which asks no question while the questions are shut", async () => {
		await db.prepare("UPDATE plaid_items SET history_complete_at = NULL").run();
		const { res } = await get("/first-page");
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/setup");
		const setup = await get("/setup");
		expect(setup.res.status).toBe(200);
		expect(setup.html).not.toContain('action="/setup/pay"');
	});

	it("an answer while the questions are shut is sent Home, and writes nothing", async () => {
		await db.prepare("UPDATE plaid_items SET history_complete_at = NULL").run();
		const { res } = await post("/setup/pay", [["answer", "yes"]]);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/");
		expect((await readFirstTally(db))?.strokes.pay).toBeUndefined();
	});

	it("opens the questions once the gate is open", async () => {
		const { res, html } = await get("/setup");
		expect(res.status).toBe(200);
		expect(html).toContain('id="setup-screen"');
	});

	describe("once the first week is set up (#647)", () => {
		/** Draws every stroke: the household is set up, and nothing is left to ask. */
		const setUp = async () => {
			for (const stroke of STROKES) await markStroke(db, stroke, TODAY);
		};

		/** The ACME deposits' flags, as the ledger reads them: a Yes would change them, so they show whether an answer wrote. */
		const flagsOf = async (raw: string) =>
			(
				await db
					.prepare(
						"SELECT flag_income, income_source FROM transactions WHERE raw_name = ?",
					)
					.bind(raw)
					.all()
			).results;

		it("sends the page Home with a 303, and a plain answer Home too", async () => {
			await setUp();
			const { res } = await get("/setup");
			expect(res.status).toBe(303);
			expect(res.headers.get("Location")).toBe("/");
			const answer = await post("/setup/pay", [["answer", "yes"]]);
			expect(answer.res.status).toBe(303);
			expect(answer.res.headers.get("Location")).toBe("/");
		});

		it("sends a pay answer Home with HX-Redirect, and writes nothing", async () => {
			// Deposits the page asks about while it is still open; the answer posts the fields that page showed.
			await deposits("ACME CORP PAYROLL", 245000, 2, 14, {
				flag_income: 0,
				income_confidence: 0.5,
			});
			const { html } = await get("/setup");
			const asked: [string, string][] = [
				...hiddenFields(html, "merchant"),
				...payFields(html),
				["answer", "yes"],
			];
			expect(asked).toHaveLength(4);
			await setUp();
			const before = await readFirstTally(db);
			const flags = await flagsOf("ACME CORP PAYROLL");
			const { res } = await post("/setup/pay", asked, true);
			expect(res.status).toBe(204);
			expect(res.headers.get("HX-Redirect")).toBe("/");
			expect(await readFirstTally(db)).toEqual(before);
			expect(await flagsOf("ACME CORP PAYROLL")).toEqual(flags);
		});

		it("sends a bills keep Home with HX-Redirect, and keeps no bill", async () => {
			await charge("NETFLIX", 1549);
			const { html } = await get("/setup");
			const keep = keepFields(html);
			expect(keep).toHaveLength(1);
			await setUp();
			const before = await readFirstTally(db);
			const { res } = await post("/setup/bills", keep, true);
			expect(res.status).toBe(204);
			expect(res.headers.get("HX-Redirect")).toBe("/");
			expect(await readFirstTally(db)).toEqual(before);
			const bills = await db
				.prepare("SELECT COUNT(*) AS n FROM bills")
				.first<{ n: number }>();
			expect(bills?.n).toBe(0);
		});
	});
});

describe("the family app only", () => {
	it("is a 404 in the demo, for the page and its answers", async () => {
		const demo = app(true);
		expect((await demo.fetch("/first-page")).status).toBe(404);
		const answer = await demo.fetch("/setup/pay", {
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
		const first = await get("/setup");
		expect(first.html.match(/Is this your pay\?/g)?.length).toBe(1);
		expect(first.html).toContain("ACME CORP PAYROLL");
		expect(first.html).not.toContain("SIDE GIG");
		await answerAsShown("yes");
		const second = await get("/setup");
		expect(second.html).toContain("SIDE GIG");
	});

	it("gives a range when a merchant's deposits vary", async () => {
		await deposits("ACME CORP PAYROLL", [230000, 260000, 245000], 3);
		const { html } = await get("/setup");
		expect(textOf(html)).toContain("$2,300 to $2,600");
		expect(textOf(html)).toContain("3 times since");
	});

	it("names the cadence from the dates", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 4, 14);
		const { html } = await get("/setup");
		const weekday = new Date(`${TODAY}T00:00:00Z`).toLocaleDateString("en-US", {
			weekday: "long",
			timeZone: "UTC",
		});
		expect(textOf(html)).toContain(`Every other ${weekday} · 4 times since`);
	});
});

describe("Yes and No writes", () => {
	it("Yes marks the merchant's money in as income, as the person's choice", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const { res } = await answerAsShown("yes");
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
		await answerAsShown("no");
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
		await answerAsShown("yes");
		expect((await readFirstTally(db))?.strokes.pay).toBeUndefined();
		await answerAsShown("no");
		expect((await readFirstTally(db))?.strokes.pay).toBe(TODAY);
	});

	it("does not ask an answered merchant again after a reload", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		await deposits("SIDE GIG", 4000, 2, 30, {
			flag_income: 0,
			income_confidence: 0.5,
		});
		await answerAsShown("yes");
		const { html } = await get("/setup");
		expect(textOf(html)).not.toContain("ACME CORP PAYROLL");
		expect(html).toContain("SIDE GIG");
	});

	it("after a bank linked during setup takes the questions back, asks the new deposits and not the answered ones (#578)", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		await answerAsShown("yes");
		expect((await readFirstTally(db))?.strokes.pay).toBe(TODAY);
		await takeBackQuestionStrokes(db, "Wells Fargo").run();
		expect((await readFirstTally(db))?.strokes.pay).toBeUndefined();
		await deposits("NEW BANK PAYROLL", 180000, 2);
		const { html } = await get("/setup");
		expect(textOf(html)).toContain("NEW BANK PAYROLL");
		expect(textOf(html)).not.toContain("ACME CORP PAYROLL");
	});

	it("a stale answer for a merchant with nothing left to ask changes nothing", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		await answerAsShown("yes");
		const before = await db
			.prepare(
				"SELECT updated_at FROM transactions WHERE raw_name = 'ACME CORP PAYROLL'",
			)
			.all();
		const { res } = await post(
			"/setup/pay",
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
		expect(
			Object.keys(
				(await readFirstTally(db))?.pay?.["ACME CORP PAYROLL"]?.yes ?? {},
			),
		).toHaveLength(2);
	});

	it("a second answer from a stale read changes nothing and leaves the first's record and flags agreeing", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const merchant = (await payMerchants(db))[0] as PayMerchant;
		expect(
			await answerPay(db, merchant, "yes", "person@example.com"),
		).toBeGreaterThan(0);
		expect(await answerPay(db, merchant, "no", "person@example.com")).toBe(0);
		expect((await readFirstTally(db))?.pay?.["ACME CORP PAYROLL"]).toEqual({
			yes: byId(merchant),
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

	it("answers every deposit of an unchanged merchant", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const merchant = (await payMerchants(db))[0] as PayMerchant;
		expect(await answerPay(db, merchant, "yes", "person@example.com")).toBe(2);
	});

	describe("a sync correction after the question was read", () => {
		const FLAGS =
			"SELECT id, flag_income, income_source FROM transactions WHERE raw_name = 'ACME CORP PAYROLL' ORDER BY id";

		/**
		 * Yes for a merchant whose shown deposit was corrected after its question was read: the answer changes nothing, the
		 * deposits keep their flags, and the pay record gets no line for the merchant.
		 */
		async function expectNothingMarked(merchant: PayMerchant) {
			const before = await db.prepare(FLAGS).all();
			expect(await answerPay(db, merchant, "yes", "person@example.com")).toBe(
				0,
			);
			expect((await db.prepare(FLAGS).all()).results).toEqual(before.results);
			expect(
				(await readFirstTally(db))?.pay?.["ACME CORP PAYROLL"],
			).toBeUndefined();
		}

		it("changes nothing when a shown deposit's cents changed", async () => {
			await deposits("ACME CORP PAYROLL", 245000, 2);
			const merchant = (await payMerchants(db))[0] as PayMerchant;
			await db
				.prepare("UPDATE transactions SET amount_cents = -250000 WHERE id = ?")
				.bind(merchant.ids[0])
				.run();
			await expectNothingMarked(merchant);
		});

		it("changes nothing when a shown deposit's date changed", async () => {
			await deposits("ACME CORP PAYROLL", 245000, 2);
			const merchant = (await payMerchants(db))[0] as PayMerchant;
			await db
				.prepare("UPDATE transactions SET date = ? WHERE id = ?")
				.bind(daysBefore(TODAY, 1), merchant.ids[0])
				.run();
			await expectNothingMarked(merchant);
		});

		it("changes nothing when a shown deposit's merchant key changed", async () => {
			await deposits("ACME CORP PAYROLL", 245000, 2);
			const merchant = (await payMerchants(db))[0] as PayMerchant;
			await db
				.prepare("UPDATE transactions SET merchant_name = 'ACME' WHERE id = ?")
				.bind(merchant.ids[0])
				.run();
			await expectNothingMarked(merchant);
		});
	});

	it("answers a No that a competing Yes beat with the page as it is, as info, and keeps the Yes", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const merchant = (await payMerchants(db))[0] as PayMerchant;
		// The competing Yes lands just before this reply's own batch, so the reply's No changes no row.
		const racing = raceBeforeBatch(async (target) => {
			await answerPay(target, merchant, "yes", "person@example.com");
		});
		const res = await app(false, racing).fetch("/setup/pay", {
			method: "POST",
			redirect: "manual",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"HX-Request": "true",
			},
			body: new URLSearchParams([
				["merchant", "ACME CORP PAYROLL"],
				...depositFields(merchant),
				["answer", "no"],
			]).toString(),
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
		expect(
			Object.keys(
				(await readFirstTally(db))?.pay?.["ACME CORP PAYROLL"]?.yes ?? {},
			),
		).toHaveLength(2);
	});

	it("a deposit added between loading the question and answering it stays unanswered and is asked next", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const merchant = (await payMerchants(db))[0] as PayMerchant;
		// A deposit arrives after the question was read and before this reply's batch: the answer must leave it alone.
		const racing = raceBeforeBatch(() =>
			txn({
				raw_name: "ACME CORP PAYROLL",
				date: daysBefore(TODAY, 7),
				amount_cents: -245000,
				flag_income: 1,
				plaid_category: "INCOME",
			}),
		);
		const res = await app(false, racing).fetch("/setup/pay", {
			method: "POST",
			redirect: "manual",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams([
				["merchant", "ACME CORP PAYROLL"],
				...depositFields(merchant),
				["answer", "yes"],
			]).toString(),
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
		expect(
			Object.keys(record?.pay?.["ACME CORP PAYROLL"]?.yes ?? {}),
		).toHaveLength(2);
		expect(record?.strokes.pay).toBeUndefined();
		const { html } = await get("/setup");
		expect(html).toContain("Is this your pay?");
		expect(textOf(html)).toContain("ACME CORP PAYROLL");
	});
});

describe("a merchant asked again keeps every Yes in its pay line", () => {
	/**
	 * Acme Corp, two Yes-answered deposits two weeks apart, then a third paycheck two weeks after the latest, which the
	 * page asks about on its own. The first answer is Yes, so the merchant is asked again for the third.
	 */
	async function acmeAskedAgain() {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('ACME CORP', 'Acme Corp')",
			)
			.run();
		await txn({
			raw_name: "ACME CORP",
			date: daysBefore(TODAY, 28),
			amount_cents: -245000,
			flag_income: 1,
			plaid_category: "INCOME",
		});
		await txn({
			raw_name: "ACME CORP",
			date: daysBefore(TODAY, 14),
			amount_cents: -245000,
			flag_income: 1,
			plaid_category: "INCOME",
		});
		await answerAsShown("yes");
		await txn({
			raw_name: "ACME CORP",
			date: TODAY,
			amount_cents: -245000,
			flag_income: 1,
			plaid_category: "INCOME",
		});
		const { html } = await get("/setup");
		expect(textOf(html)).toContain("Once, on");
		expect(textOf(html)).toContain("$2,450");
		expect(html.match(/Is this your pay\?/g)?.length).toBe(1);
	}

	it("a merchant asked again for a new paycheck keeps one pay line over every deposit answered Yes", async () => {
		await acmeAskedAgain();
		const { res } = await answerAsShown("yes", true);
		expect(trigger(res).toast?.message).toBe("Saved: Acme Corp is your pay.");
		expect(
			Object.keys((await readFirstTally(db))?.pay?.["ACME CORP"]?.yes ?? {}),
		).toHaveLength(3);
		const { html } = await get("/setup");
		expect(html).not.toContain("Is this your pay?");
	});

	it("a later No on a new deposit leaves the earlier Yes deposits as they were", async () => {
		await acmeAskedAgain();
		const yesBefore = Object.keys(
			(await readFirstTally(db))?.pay?.["ACME CORP"]?.yes ?? {},
		);
		expect(yesBefore).toHaveLength(2);
		const { res, html } = await answerAsShown("no", true);
		const message = "Saved: that deposit from Acme Corp isn't your pay.";
		expect(trigger(res).toast).toEqual({ message, type: "success" });
		expect(trigger(res).announce).toBe(message);
		expect(html).not.toContain("Is this your pay?");
		const record = (await readFirstTally(db))?.pay?.["ACME CORP"];
		expect(Object.keys(record?.yes ?? {})).toEqual(yesBefore);
		const newId = await db
			.prepare(
				"SELECT id FROM transactions WHERE raw_name = 'ACME CORP' AND date = ?",
			)
			.bind(TODAY)
			.first<{ id: number }>();
		expect(record?.no).toEqual({
			[String(newId?.id)]: { date: TODAY, cents: 245000 },
		});
		const row = await db
			.prepare(
				"SELECT income_source, flag_income FROM transactions WHERE id = ?",
			)
			.bind(newId?.id ?? 0)
			.first<{ income_source: string; flag_income: number }>();
		expect(row).toEqual({ income_source: "user", flag_income: 0 });
	});

	it("a No on several new deposits says how many it kept apart, when the merchant had a Yes line", async () => {
		await acmeAskedAgain();
		await answerAsShown("yes");
		for (const days of [7, 0]) {
			await txn({
				raw_name: "ACME CORP",
				date: daysBefore(TODAY, days),
				amount_cents: -245000,
				flag_income: 1,
				plaid_category: "INCOME",
			});
		}
		const { res } = await answerAsShown("no", true);
		const message = "Saved: those 2 deposits from Acme Corp aren't your pay.";
		expect(trigger(res).toast?.message).toBe(message);
	});

	it("a No with no Yes line before it keeps the plain words", async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('ACME CORP', 'Acme Corp')",
			)
			.run();
		await deposits("ACME CORP", 50000, 2, 14, {
			flag_income: 0,
			income_confidence: 0.5,
		});
		const { res } = await answerAsShown("no", true);
		expect(trigger(res).toast?.message).toBe(
			"Saved: Acme Corp isn't your pay.",
		);
	});
});

describe("A pay answer answers what the page showed", () => {
	const REFUSED =
		"Nothing saved. The deposits from Acme Corp changed since the page drew, so the question is asked again below.";

	beforeEach(async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('ACME CORP PAYROLL', 'Acme Corp')",
			)
			.run();
	});

	/**
	 * The reply to a pay answer that wrote nothing: the info toast and announcement, the question drawn again with `asked`
	 * in its sentence, and no deposit marked, no pay record and no stroke.
	 */
	async function expectRefused(res: Response, html: string, asked: string) {
		expect(res.status).toBe(200);
		expect(trigger(res).toast).toEqual({ message: REFUSED, type: "info" });
		expect(trigger(res).announce).toBe(REFUSED);
		expect(html).not.toContain("Saved:");
		expect(html).toContain("Is this your pay?");
		expect(html).toContain(asked);
		const marked = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE income_source = 'user'",
			)
			.first<{ n: number }>();
		expect(marked?.n).toBe(0);
		const record = await readFirstTally(db);
		expect(record?.pay?.["ACME CORP PAYROLL"]).toBeUndefined();
		expect(record?.strokes.pay).toBeUndefined();
	}

	it("marks nothing for a deposit added after the page drew, and asks the question again", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const page = (await get("/setup")).html;
		await txn({
			raw_name: "ACME CORP PAYROLL",
			date: daysBefore(TODAY, 28),
			amount_cents: -245000,
			flag_income: 1,
			plaid_category: "INCOME",
		});
		const { res, html } = await post(
			"/setup/pay",
			[
				...hiddenFields(page, "merchant"),
				...payFields(page),
				["answer", "yes"],
			],
			true,
		);
		await expectRefused(res, html, "3 times since");
	});

	it("marks nothing for a deposit whose amount changed in place after the page drew", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const page = (await get("/setup")).html;
		await db
			.prepare(
				"UPDATE transactions SET amount_cents = -250000 WHERE raw_name = 'ACME CORP PAYROLL' AND date = ?",
			)
			.bind(TODAY)
			.run();
		const { res, html } = await post(
			"/setup/pay",
			[
				...hiddenFields(page, "merchant"),
				...payFields(page),
				["answer", "yes"],
			],
			true,
		);
		await expectRefused(res, html, "2 times since");
	});

	it("says the deposits changed when a sync corrects a shown deposit between the check and the answer", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const merchant = (await payMerchants(db))[0] as PayMerchant;
		const racing = raceBeforeBatch(async (target) => {
			await target
				.prepare("UPDATE transactions SET amount_cents = -250000 WHERE id = ?")
				.bind(merchant.ids[0])
				.run();
		});
		const { res, html } = await post(
			"/setup/pay",
			[
				["merchant", "ACME CORP PAYROLL"],
				...depositFields(merchant),
				["answer", "yes"],
			],
			true,
			racing,
		);
		await expectRefused(res, html, "$2,450 to $2,500");
	});

	it("says the deposits changed when a sync renames a shown deposit's merchant between the check and the answer", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const merchant = (await payMerchants(db))[0] as PayMerchant;
		const racing = raceBeforeBatch(async (target) => {
			await target
				.prepare("UPDATE transactions SET merchant_name = 'ACME' WHERE id = ?")
				.bind(merchant.ids[0])
				.run();
		});
		const { res, html } = await post(
			"/setup/pay",
			[
				["merchant", "ACME CORP PAYROLL"],
				...depositFields(merchant),
				["answer", "yes"],
			],
			true,
			racing,
		);
		// The renamed deposit is now its own merchant, 'ACME', which sorts first and is asked first.
		await expectRefused(res, html, "Once, on");
	});

	it("marks nothing when the form posts no deposit field", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const { res, html } = await post(
			"/setup/pay",
			{ merchant: "ACME CORP PAYROLL", answer: "yes" },
			true,
		);
		await expectRefused(res, html, "2 times since");
	});

	it("renders one hidden deposit input per deposit the question shows", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 3);
		const { html } = await get("/setup");
		expect(html.match(/name="deposit"/g)).toHaveLength(3);
	});
});

describe("bills: the exclusions and the one-tap keep", () => {
	it("keeps the found charges in one tap and leaves out one with no category", async () => {
		await charge("NETFLIX", 1549);
		await charge("GYM", 4500, false);
		const { html } = await get("/setup");
		expect(textOf(html)).toContain("Keep this one as a bill?");
		expect(textOf(html)).toContain("1 more waits in Possible bills.");
	});

	it("leaves out a charge over $100,000", async () => {
		await charge("MORTGAGE", 10_000_001);
		const { html } = await get("/setup");
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
		const { html } = await get("/setup");
		expect(textOf(html)).toContain("2 more wait in Possible bills.");
	});

	it("keeps the bills through the Add bill path, and draws the bills stroke", async () => {
		await charge("NETFLIX", 1549);
		const { res } = await keepAsShown();
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
		const { html } = await get("/setup");
		expect(textOf(html)).toContain("Nothing here to keep in one tap.");
		expect(textOf(html)).toContain("1 more waits in Possible bills.");
		expect((await readFirstTally(db))?.strokes.bills).toBe(TODAY);
	});
});

describe("Keep keeps what the page showed", () => {
	it("keeps the charge the page showed, and asks a charge that is new since then again", async () => {
		await charge("NETFLIX", 1549);
		const shown = keepFields((await get("/setup")).html);
		await charge("SPOTIFY", 1199);
		const { res, html } = await post("/setup/bills", shown, true);
		const bills = await db
			.prepare("SELECT name FROM bills WHERE active = 1")
			.all<{ name: string }>();
		expect(bills.results.map((bill) => bill.name)).toEqual(["Netflix"]);
		expect(trigger(res).announce).toBe(
			"Kept 1 bill. 1 charge changed since the page drew, so it's asked again below.",
		);
		expect((await readFirstTally(db))?.strokes.bills).toBeUndefined();
		expect(textOf(html)).toContain("Keep this one as a bill?");
	});

	it("keeps no charge whose amount changed since the page showed it, and asks it again", async () => {
		await charge("NETFLIX", 1549);
		const shown = keepFields((await get("/setup")).html);
		await db
			.prepare(
				"UPDATE transactions SET amount_cents = 1599 WHERE raw_name = 'NETFLIX' AND date = ?",
			)
			.bind(TODAY)
			.run();
		const { res, html } = await post("/setup/bills", shown, true);
		const bills = await db
			.prepare("SELECT COUNT(*) AS count FROM bills")
			.first<{ count: number }>();
		expect(bills?.count).toBe(0);
		expect(trigger(res).announce).toBe(
			"Nothing kept. 1 charge changed since the page drew, so it's asked again below.",
		);
		expect(trigger(res).toast?.type).toBe("info");
		expect(textOf(html)).toContain("Keep this one as a bill?");
	});

	it("keeps no charge whose name was changed in another tab since the page showed it, and asks it again", async () => {
		await charge("NETFLIX", 1549);
		const shown = keepFields((await get("/setup")).html);
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('NETFLIX', 'Netflix Plus')",
			)
			.run();
		const { res, html } = await post("/setup/bills", shown, true);
		const bills = await db
			.prepare("SELECT COUNT(*) AS count FROM bills")
			.first<{ count: number }>();
		expect(bills?.count).toBe(0);
		expect(trigger(res).announce).toBe(
			"Nothing kept. 1 charge changed since the page drew, so it's asked again below.",
		);
		expect(trigger(res).toast?.type).toBe("info");
		expect(textOf(html)).toContain("Netflix Plus");
		expect(textOf(html)).toContain("Keep this one as a bill?");
	});

	it("keeps no bill when the form submits no charge, even with one on the page", async () => {
		await charge("NETFLIX", 1549);
		const { res } = await post("/setup/bills", [], true);
		const bills = await db
			.prepare("SELECT COUNT(*) AS count FROM bills")
			.first<{ count: number }>();
		expect(bills?.count).toBe(0);
		expect(trigger(res).announce).toMatch(/^Nothing kept\./);
	});
});

// The presence check-in (decision 146): the questions page checks in every 30 seconds while no question is answered, so
// Tally knows someone is still on it. Once one is answered the page draws no check-in.
describe("the presence check-in on the page (decision 146)", () => {
	const CHECK_IN = 'hx-post="/home/seen"';

	/**
	 * The HTML of the element whose opening tag starts at `start`, through its matching close (nested divs counted), so a test
	 * can tell what sits inside the root an answer swaps.
	 */
	function elementAt(html: string, start: number): string {
		const tag = /<\/?div\b[^>]*>/g;
		tag.lastIndex = start;
		let depth = 0;
		for (let m = tag.exec(html); m; m = tag.exec(html)) {
			depth += m[0].startsWith("</") ? -1 : 1;
			if (depth === 0) return html.slice(start, m.index + m[0].length);
		}
		throw new Error("the element is never closed");
	}

	it("is drawn once while no question is answered, inside the #setup-screen that an answer swaps", async () => {
		// One payroll merchant: its question is asked, not drawn, so no question is answered.
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const { res, html } = await get("/setup");
		expect(res.status).toBe(200);
		expect(html).toContain(CHECK_IN);
		expect(html.match(/id="home-seen"/g)).toHaveLength(1);
		const root = html.indexOf('<div id="setup-screen"');
		expect(root).toBeGreaterThanOrEqual(0);
		expect(elementAt(html, root)).toContain('id="home-seen"');
	});

	it("is marked, so a Plaid Link window on Home pauses it wherever it is drawn (decision 146)", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const { html } = await get("/setup");
		const tag = html.match(/<[a-z]+ id="home-seen"[^>]*>/)?.[0] ?? "";
		expect(tag).toContain("data-waits-for-link");
	});

	it("is not drawn once a question is answered", async () => {
		await markStroke(db, "pay", TODAY);
		const { res, html } = await get("/setup");
		expect(res.status).toBe(200);
		expect(html).not.toContain(CHECK_IN);
	});

	it("is not drawn for a household with no paycheck: the page draws the pay step itself, so the first question is answered (decision 146)", async () => {
		const { res, html } = await get("/setup");
		expect(res.status).toBe(200);
		expect((await readFirstTally(db))?.strokes.pay).toBe(TODAY);
		expect(html).not.toContain(CHECK_IN);
		// A reload of the same page draws none either.
		expect((await get("/setup")).html).not.toContain(CHECK_IN);
	});

	it("is drawn inside the swapped #setup-screen of a pay answer that leaves a question open, so the page keeps checking in", async () => {
		// Two payroll merchants: answering the first leaves the second to ask, so the pay step is not drawn yet.
		await deposits("ACME CORP PAYROLL", 245000, 2);
		await deposits("OTHER PAYROLL", 180000, 2);
		const { res, html } = await answerAsShown("yes", true);
		expect(res.status).toBe(200);
		expect(html).toContain('id="setup-screen"');
		expect(html).toContain(CHECK_IN);
		const root = html.indexOf('<div id="setup-screen"');
		expect(elementAt(html, root)).toContain(CHECK_IN);
	});

	it("is not drawn in a pay answer's #setup-screen once the answer draws the pay step, so the swap takes away the one the page drew", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const { res, html } = await answerAsShown("yes", true);
		expect(res.status).toBe(200);
		expect(html).toContain('id="setup-screen"');
		expect(html).not.toContain(CHECK_IN);
	});
});

describe("empty steps", () => {
	it("says no paycheck was spotted, and counts the pay step done", async () => {
		const { html } = await get("/setup");
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
		const { res, html } = await answerAsShown("yes", true);
		expect(res.status).toBe(200);
		const headers = trigger(res);
		expect(headers.announce).toBe("Saved: Acme Corp is your pay.");
		expect(headers.toast?.message).toBe("Saved: Acme Corp is your pay.");
		expect(html).toContain('id="setup-screen"');
		expect(html).toContain('tabindex="-1"');
		expect(html).toContain("autofocus");
	});

	it("announces a kept bills step with its count", async () => {
		await charge("NETFLIX", 1549);
		await charge("SPOTIFY", 1199);
		const { res } = await keepAsShown(true);
		expect(trigger(res).announce).toBe("Kept 2 bills.");
	});
});

describe("the waiting line names Possible bills once", () => {
	const count = (html: string) =>
		(textOf(html).match(/Possible bills/g) ?? []).length;

	it("in the bills question", async () => {
		await charge("NETFLIX", 1549);
		await charge("GYM", 4500, false);
		const { html } = await get("/setup");
		expect(textOf(html)).toContain("Keep this one as a bill?");
		expect(textOf(html)).toContain("1 more waits in Possible bills.");
		expect(count(html)).toBe(1);
	});

	it("in the empty bills step", async () => {
		await charge("GYM", 4500, false);
		const { html } = await get("/setup");
		expect(textOf(html)).toContain("1 more waits in Possible bills.");
		expect(count(html)).toBe(1);
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
		const { html } = await get("/setup");
		expect(textOf(html)).toContain(
			"Tally didn't spot a paycheck. You can mark one from any transaction later.",
		);
		expect(html).not.toContain("STORE REFUND");
		await answerFor("STORE REFUND", "yes");
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
		await answerAsShown("yes");
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

describe("keeping bills links the charges they paid", () => {
	it("links a charge already paid this period after Keep, so that occurrence isn't due", async () => {
		await charge("NETFLIX", 1549);
		await keepAsShown();
		const links = await db
			.prepare(
				"SELECT bp.period, t.date FROM bill_payments bp JOIN transactions t ON t.id = bp.transaction_id WHERE bp.status = 'linked' AND t.date = ?",
			)
			.bind(TODAY)
			.all<{ period: string; date: string }>();
		expect(links.results).toEqual([{ period: TODAY.slice(0, 7), date: TODAY }]);
	});
});

describe("a Keep that fails part-way", () => {
	it("still counts the bill it kept, and a retry counts the rest", async () => {
		await charge("NETFLIX", 1549);
		await charge("SPOTIFY", 1199);
		const shown = keepFields((await get("/setup")).html);
		// The first bill goes in; the second is refused by the database, so the Keep errors after one bill.
		await db
			.prepare(
				"CREATE TRIGGER fail_keep BEFORE INSERT ON bills WHEN (SELECT COUNT(*) FROM bills) > 0 BEGIN SELECT RAISE(ABORT, 'forced'); END",
			)
			.run();
		try {
			const failed = await post("/setup/bills", shown);
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

		const { res } = await post("/setup/bills", shown, true);
		expect(trigger(res).toast?.message).toBe("Kept 1 bill.");
		expect((await readFirstTally(db))?.bills).toEqual({
			kept: 2,
			cents: 2748,
		});
		expect((await readFirstTally(db))?.strokes.bills).toBe(TODAY);
	});
});

describe("the pay question's scope", () => {
	it("asks a flagged income that a credit review reviewed, and Yes writes the person's choice", async () => {
		await deposits("CREDIT PAY", 245000, 2, 14, {
			credit_reviewed: 1,
			income_source: "jev",
		});
		const { html } = await get("/setup");
		expect(html).toContain("CREDIT PAY");
		await answerAsShown("yes");
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
		const { html } = await get("/setup");
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
		await answerFor("ACME CORP PAYROLL", "yes");
		await answerFor("XFER FROM SAVINGS", "no");
		expect((await rows()).results).toEqual(before.results);
	});

	it("asks a flagged income the person reviewed as a credit, since only the answer settles it", async () => {
		await deposits("REVIEWED PAY", 245000, 2, 14, {
			credit_reviewed: 1,
			credit_reviewed_by: "user",
		});
		const { html } = await get("/setup");
		expect(html).toContain("REVIEWED PAY");
		expect(html.match(/Is this your pay\?/g)?.length).toBe(1);
	});
});

describe("a Never suggest income line doesn't hide the pay question (#651)", () => {
	/** An unflagged deposit Tally is unsure is income (a Maybe guess), from a merchant with a Never suggest income line. */
	async function hiddenDeposit(
		raw: string,
		over: Record<string, unknown> = {},
	) {
		await deposits(raw, 245000, 2, 14, {
			flag_income: 0,
			income_confidence: 0.5,
			...over,
		});
		await db
			.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES (?, 'income', '2026-10-03')",
			)
			.bind(raw)
			.run();
	}

	it("asks the unflagged deposit, since the pay step asks every income guess a person hasn't decided", async () => {
		await hiddenDeposit("NEVER PAY");
		expect((await payMerchants(db)).map((m) => m.key)).toEqual(["NEVER PAY"]);
		const { html } = await get("/setup");
		expect(html).toContain("Is this your pay?");
		expect(html).toContain("NEVER PAY");
	});

	it("Yes on that question marks each deposit as income, as the person's choice", async () => {
		await hiddenDeposit("NEVER PAY");
		await answerAsShown("yes");
		const rows = await db
			.prepare(
				"SELECT flag_income, income_source FROM transactions WHERE raw_name = 'NEVER PAY'",
			)
			.all<{ flag_income: number; income_source: string }>();
		expect(rows.results).toHaveLength(2);
		expect(
			rows.results.every(
				(row) => row.flag_income === 1 && row.income_source === "user",
			),
		).toBe(true);
		expect(await payMerchants(db)).toEqual([]);
	});

	it("the review still leaves the same deposit out, since it honours Never suggest", async () => {
		await hiddenDeposit("NEVER PAY");
		const queue = await suggestionQueue(db, AI_SWITCHES_ALL_ON);
		expect(queue.filter((item) => item.kind === "income")).toEqual([]);
	});

	it("a deposit the person already said No to stays left out, with or without the Never suggest line", async () => {
		await hiddenDeposit("NEVER PAY", { income_maybe_declined: 1 });
		expect(await payMerchants(db)).toEqual([]);
		await db.prepare("DELETE FROM never_suggest_rules").run();
		expect(await payMerchants(db)).toEqual([]);
	});
});

/** The savings question's heading, as the page draws it. */
const SAVINGS_QUESTION = "Save some each month?";

/** The category id a budgets form posts first (its `category` field, or a keep-all form's first `keep` value), for a skip. */
function firstCategoryOf(html: string): number {
	const category = hiddenFields(html, "category")[0]?.[1];
	return Number(category ?? 0);
}

describe("the questions at /setup, and the old page's addresses (#773)", () => {
	/** A POST to an answer path, from the demo or the family app, with a yes answer (an answer's own check decides the rest). */
	const answerIn = (demo: boolean, path: string, htmx = false) =>
		app(demo).fetch(path, {
			method: "POST",
			redirect: "manual",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				...(htmx ? { "HX-Request": "true" } : {}),
			},
			body: new URLSearchParams([["answer", "yes"]]).toString(),
		});

	const ANSWERS = [
		"/setup/pay",
		"/setup/bills",
		"/setup/budgets",
		"/setup/savings",
	] as const;
	const OLD_ANSWERS = [
		"/first-page/pay",
		"/first-page/bills",
		"/first-page/budgets",
		"/first-page/savings",
	] as const;

	it("sends GET /first-page to /setup, keeping ?budgets=one when it asks for one at a time", async () => {
		const plain = await family.fetch("/first-page");
		expect(plain.status).toBe(303);
		expect(plain.headers.get("Location")).toBe("/setup");
		const one = await family.fetch("/first-page?budgets=one");
		expect(one.status).toBe(303);
		expect(one.headers.get("Location")).toBe("/setup?budgets=one");
	});

	it("sends each old answer to /setup, with HX-Redirect for htmx, and writes nothing", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		await charge("NETFLIX", 1549);
		const before = await readFirstTally(db);
		for (const path of OLD_ANSWERS) {
			const htmx = await answerIn(false, path, true);
			expect(htmx.status).toBe(204);
			expect(htmx.headers.get("HX-Redirect")).toBe("/setup");
			const plain = await answerIn(false, path);
			expect(plain.status).toBe(303);
			expect(plain.headers.get("Location")).toBe("/setup");
		}
		expect(await readFirstTally(db)).toEqual(before);
		const yes = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE income_source = 'user'",
			)
			.first<{ n: number }>();
		expect(yes?.n).toBe(0);
		const bills = await db
			.prepare("SELECT COUNT(*) AS n FROM bills")
			.first<{ n: number }>();
		expect(bills?.n).toBe(0);
	});

	it("is a 404 in the demo at every answer path, and at GET /setup", async () => {
		for (const path of [...ANSWERS, ...OLD_ANSWERS]) {
			expect((await answerIn(true, path)).status).toBe(404);
			expect((await answerIn(true, path, true)).status).toBe(404);
		}
		expect((await app(true).fetch("/setup")).status).toBe(404);
		expect((await app(true).fetch("/first-page")).status).toBe(404);
	});

	it.each(ANSWERS)(
		"sends %s Home while the questions are shut, for htmx and without it, and writes nothing",
		async (path) => {
			await db
				.prepare("UPDATE plaid_items SET history_complete_at = NULL")
				.run();
			await deposits("ACME CORP PAYROLL", 245000, 2);
			const before = await readFirstTally(db);
			const htmx = await answerIn(false, path, true);
			expect(htmx.status).toBe(204);
			expect(htmx.headers.get("HX-Redirect")).toBe("/");
			const plain = await answerIn(false, path);
			expect(plain.status).toBe(303);
			expect(plain.headers.get("Location")).toBe("/");
			expect(await readFirstTally(db)).toEqual(before);
		},
	);

	it("answers without htmx with a 303 to /setup, the page the answer is for", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const { res } = await answerAsShown("yes");
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/setup");
		expect((await readFirstTally(db))?.strokes.pay).toBe(TODAY);
	});

	it("draws the next screen as the reply, with the note of the step that asked nothing", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const { html } = await answerAsShown("yes", true);
		// Pay asked something and bills asked nothing (no charge to keep): the note names the bills step alone.
		expect(textOf(html)).toContain(
			"Your bills · Nothing here to keep in one tap.",
		);
		expect(textOf(html)).not.toContain("Tally didn't spot a paycheck.");
		expect(html).toContain("Step 4 of 4 · Your budgets");
		expect(html).toContain('id="setup-screen"');
	});

	it("draws the notes of the steps that asked nothing on the first budgets screen, and none once a budget is answered", async () => {
		// The demo's budgets would leave no category to ask: this household has none set, so the budgets step asks one.
		await db.prepare("DELETE FROM budget_amounts").run();
		const first = await get("/setup");
		expect(first.res.status).toBe(200);
		expect(textOf(first.html)).toContain(
			"Your pay · Tally didn't spot a paycheck.",
		);
		expect(textOf(first.html)).toContain(
			"Your bills · Nothing here to keep in one tap.",
		);
		const answered = await post(
			"/setup/budgets",
			[
				["category", String(firstCategoryOf(first.html))],
				["month", TODAY.slice(0, 7)],
				["answer", "skip"],
			],
			true,
		);
		expect(textOf(answered.html)).not.toContain(
			"Tally didn't spot a paycheck.",
		);
		expect(textOf(answered.html)).not.toContain(
			"Nothing here to keep in one tap.",
		);
	});

	it("draws the savings screen's run of the steps that asked nothing, when no category is left", async () => {
		await db.prepare("UPDATE categories SET archived = 1").run();
		const { html } = await get("/setup");
		expect(textOf(html)).toContain("Your pay · Tally didn't spot a paycheck.");
		expect(textOf(html)).toContain(
			"Your bills · Nothing here to keep in one tap.",
		);
		expect(textOf(html)).toContain(
			"Your budgets · No categories to budget yet.",
		);
		expect(textOf(html)).toContain(SAVINGS_QUESTION);
	});

	it("draws the questions with the check-in and no Plaid script or push.js", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const { html } = await get("/setup");
		expect(html).toContain('id="home-seen"');
		expect(html).not.toContain("/js/push.js");
		expect(html).not.toContain("/js/plaid-link.js");
		expect(html).not.toContain("link-initialize.js");
	});
});

describe("a stale answer's reply (#773)", () => {
	it("says a stale answer is already answered, with its toast and announcement, and writes nothing", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const { res, html } = await answerFor("GONE MERCHANT", "yes", true);
		expect(trigger(res).announce).toBe("That one is already answered.");
		expect(trigger(res).toast).toEqual({
			message: "That one is already answered.",
			type: "info",
		});
		expect(html).toContain('id="setup-screen"');
		const count = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE income_source = 'user'",
			)
			.first<{ n: number }>();
		expect(count?.n).toBe(0);
	});
});

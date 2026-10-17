import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { insertBill } from "../src/bills/write";
import { DEFAULT_TIME_ZONE, daysBefore, shortDay, todayIn } from "../src/dates";
import { AI_SWITCHES_ALL_ON } from "../src/db/ai-switches";
import {
	markStroke,
	readFirstTally,
	STROKES,
	takeBackQuestionStrokes,
} from "../src/db/first-tally";
import { suggestionQueue } from "../src/db/suggestions-queue";
import { saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import {
	answerPay,
	type PayMerchant,
	payMerchants,
} from "../src/first-tally/first-page";
import { shownPayValues } from "../src/first-tally/pay";
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
	return post(
		"/first-page/bills",
		keepFields((await get("/first-page")).html),
		htmx,
	);
}

/**
 * Yes or No, as the page's own form posts it: the page is read, and its first question's merchant, deposit fields and
 * answer are posted.
 */
async function answerAsShown(answer: "yes" | "no", htmx = false) {
	const { html } = await get("/first-page");
	return post(
		"/first-page/pay",
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
		"/first-page/pay",
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
			const { res } = await get("/first-page");
			expect(res.status).toBe(303);
			expect(res.headers.get("Location")).toBe("/");
			const answer = await post("/first-page/pay", [["answer", "yes"]]);
			expect(answer.res.status).toBe(303);
			expect(answer.res.headers.get("Location")).toBe("/");
		});

		it("sends a pay answer Home with HX-Redirect, and writes nothing", async () => {
			// Deposits the page asks about while it is still open; the answer posts the fields that page showed.
			await deposits("ACME CORP PAYROLL", 245000, 2, 14, {
				flag_income: 0,
				income_confidence: 0.5,
			});
			const { html } = await get("/first-page");
			const asked: [string, string][] = [
				...hiddenFields(html, "merchant"),
				...payFields(html),
				["answer", "yes"],
			];
			expect(asked).toHaveLength(4);
			await setUp();
			const before = await readFirstTally(db);
			const flags = await flagsOf("ACME CORP PAYROLL");
			const { res } = await post("/first-page/pay", asked, true);
			expect(res.status).toBe(204);
			expect(res.headers.get("HX-Redirect")).toBe("/");
			expect(await readFirstTally(db)).toEqual(before);
			expect(await flagsOf("ACME CORP PAYROLL")).toEqual(flags);
		});

		it("sends a bills keep Home with HX-Redirect, and keeps no bill", async () => {
			await charge("NETFLIX", 1549);
			const { html } = await get("/first-page");
			const keep = keepFields(html);
			expect(keep).toHaveLength(1);
			await setUp();
			const before = await readFirstTally(db);
			const { res } = await post("/first-page/bills", keep, true);
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
		await answerAsShown("yes");
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
		const { html } = await get("/first-page");
		expect(textOf(html)).not.toContain("ACME CORP PAYROLL paying");
		expect(html).toContain("SIDE GIG");
	});

	it("after a bank linked during setup takes the questions back, asks the new deposits and not the answered ones (#578)", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		await answerAsShown("yes");
		expect((await readFirstTally(db))?.strokes.pay).toBe(TODAY);
		await takeBackQuestionStrokes(db, "Wells Fargo").run();
		expect((await readFirstTally(db))?.strokes.pay).toBeUndefined();
		await deposits("NEW BANK PAYROLL", 180000, 2);
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain("NEW BANK PAYROLL paying");
		expect(textOf(html)).not.toContain("ACME CORP PAYROLL paying");
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
		const res = await app(false, racing).fetch("/first-page/pay", {
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
		expect(textOf(html)).toMatch(/Pay · /);
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
		const res = await app(false, racing).fetch("/first-page/pay", {
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
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain("ACME CORP PAYROLL paying");
	});
});

describe("a merchant asked again keeps every Yes in its pay line", () => {
	/** The ledger's pay lines, as the page words them. */
	const payLines = (html: string) =>
		[...html.matchAll(/<li class="[^"]*">([^<]*)<\/li>/g)]
			.map((match) => match[1] ?? "")
			.filter((text) => text.startsWith("Pay · "));

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
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain("paying $2,450, once, on");
		expect(html.match(/Is this your pay\?/g)?.length).toBe(1);
	}

	it("a merchant asked again for a new paycheck keeps one pay line over every deposit answered Yes", async () => {
		await acmeAskedAgain();
		const { res } = await answerAsShown("yes", true);
		expect(trigger(res).toast?.message).toBe("Saved: Acme Corp is your pay.");
		expect(
			Object.keys((await readFirstTally(db))?.pay?.["ACME CORP"]?.yes ?? {}),
		).toHaveLength(3);
		const { html } = await get("/first-page");
		const weekday = new Date(`${TODAY}T00:00:00Z`).toLocaleDateString("en-US", {
			weekday: "long",
			timeZone: "UTC",
		});
		expect(payLines(html)).toEqual([
			`Pay · Acme Corp, $2,450 every other ${weekday}`,
		]);
	});

	it("a later No on a new deposit leaves the earlier Yes line as it was", async () => {
		await acmeAskedAgain();
		const before = payLines((await get("/first-page")).html);
		expect(before).toHaveLength(1);
		const yesBefore = Object.keys(
			(await readFirstTally(db))?.pay?.["ACME CORP"]?.yes ?? {},
		);
		expect(yesBefore).toHaveLength(2);
		const { res, html } = await answerAsShown("no", true);
		const message = "Saved: that deposit from Acme Corp isn't your pay.";
		expect(trigger(res).toast).toEqual({ message, type: "success" });
		expect(trigger(res).announce).toBe(message);
		expect(html).not.toContain("Is this your pay?");
		const after = await get("/first-page");
		expect(payLines(after.html)).toEqual(before);
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
		const page = (await get("/first-page")).html;
		await txn({
			raw_name: "ACME CORP PAYROLL",
			date: daysBefore(TODAY, 28),
			amount_cents: -245000,
			flag_income: 1,
			plaid_category: "INCOME",
		});
		const { res, html } = await post(
			"/first-page/pay",
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
		const page = (await get("/first-page")).html;
		await db
			.prepare(
				"UPDATE transactions SET amount_cents = -250000 WHERE raw_name = 'ACME CORP PAYROLL' AND date = ?",
			)
			.bind(TODAY)
			.run();
		const { res, html } = await post(
			"/first-page/pay",
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
			"/first-page/pay",
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
			"/first-page/pay",
			[
				["merchant", "ACME CORP PAYROLL"],
				...depositFields(merchant),
				["answer", "yes"],
			],
			true,
			racing,
		);
		// The renamed deposit is now its own merchant, 'ACME', which sorts first and is asked first.
		await expectRefused(res, html, "once, on");
	});

	it("marks nothing when the form posts no deposit field", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const { res, html } = await post(
			"/first-page/pay",
			{ merchant: "ACME CORP PAYROLL", answer: "yes" },
			true,
		);
		await expectRefused(res, html, "2 times since");
	});

	it("renders one hidden deposit input per deposit the question shows", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 3);
		const { html } = await get("/first-page");
		expect(html.match(/name="deposit"/g)).toHaveLength(3);
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
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain("Nothing here to keep in one tap.");
		expect(textOf(html)).toContain("1 more waits in Possible bills.");
		expect((await readFirstTally(db))?.strokes.bills).toBe(TODAY);
	});
});

describe("Keep keeps what the page showed", () => {
	it("keeps the charge the page showed, and asks a charge that is new since then again", async () => {
		await charge("NETFLIX", 1549);
		const shown = keepFields((await get("/first-page")).html);
		await charge("SPOTIFY", 1199);
		const { res, html } = await post("/first-page/bills", shown, true);
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
		const shown = keepFields((await get("/first-page")).html);
		await db
			.prepare(
				"UPDATE transactions SET amount_cents = 1599 WHERE raw_name = 'NETFLIX' AND date = ?",
			)
			.bind(TODAY)
			.run();
		const { res, html } = await post("/first-page/bills", shown, true);
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
		const shown = keepFields((await get("/first-page")).html);
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('NETFLIX', 'Netflix Plus')",
			)
			.run();
		const { res, html } = await post("/first-page/bills", shown, true);
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
		const { res } = await post("/first-page/bills", [], true);
		const bills = await db
			.prepare("SELECT COUNT(*) AS count FROM bills")
			.first<{ count: number }>();
		expect(bills?.count).toBe(0);
		expect(trigger(res).announce).toMatch(/^Nothing kept\./);
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
		const { res, html } = await answerAsShown("yes", true);
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
		const { res } = await keepAsShown(true);
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
		const { html } = await answerAsShown("yes", true);
		// The pay stroke is the second of the five, and the bills step still has a charge to keep: only its line draws.
		expect(html.match(/first-stroke-new/g)).toHaveLength(1);
		expect(html).toMatch(
			/<line x1="53" y1="38" x2="53" y2="60" class="stroke-ink first-stroke-new"/,
		);
	});

	it("marks every line the reply drew, when an empty step after the answer is done too", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const { html } = await answerAsShown("yes", true);
		// Pay is the last merchant, and no bill charge is found: the pay and the bills strokes are drawn together. The
		// household's categories are budgeted already, so the budgets step has nothing to ask and draws its stroke too (#590).
		expect(html.match(/first-stroke-new/g)).toHaveLength(3);
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
		const { html } = await keepAsShown(true);
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
		const { html } = await answerAsShown("yes", true);
		expect(html).toContain("first-line-new");
		expect(html).not.toContain("first-stroke-new");
	});

	it("marks no line and no stroke for a stale answer, which writes nothing", async () => {
		await deposits("ACME CORP PAYROLL", 245000, 2);
		const { res, html } = await answerFor("GONE MERCHANT", "yes", true);
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
		await answerFor("ZED CO", "yes", true);
		const { html } = await answerAsShown("yes", true);
		expect(html).toMatch(
			/class="py-2 text-ink first-line-new">Pay · Acme Corp,/,
		);
		expect(html).not.toMatch(/first-line-new">Pay · Zed Co/);
		// The ledger is in the order each merchant was first answered: Zed was answered first, though its name sorts after Acme's.
		expect(html.indexOf("Pay · Zed Co")).toBeLessThan(
			html.indexOf("Pay · Acme Corp"),
		);
	});

	it("rises the line its own reply wrote, when two ledger lines read the same", async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('ACME A', 'Acme Corp'), ('ACME B', 'Acme Corp')",
			)
			.run();
		await deposits("ACME A", 245000, 2);
		await deposits("ACME B", 245000, 2);
		await answerAsShown("yes", true);
		const { html } = await answerAsShown("yes", true);
		const lines = [
			...html.matchAll(/<li class="([^"]*)">([^<]*)<\/li>/g),
		].filter((match) => match[2]?.startsWith("Pay · Acme Corp"));
		expect(lines).toHaveLength(2);
		expect(lines[0]?.[2]).toBe(lines[1]?.[2]);
		expect(lines.map((match) => match[1]?.includes("first-line-new"))).toEqual([
			false,
			true,
		]);
		expect(html.match(/first-line-new/g)).toHaveLength(1);
	});

	it("keeps the answer order for a numeric merchant key, which JSON lists first", async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('ACME CORP', 'Acme Corp'), ('1234', 'Bistro 1234')",
			)
			.run();
		await deposits("ACME CORP", 245000, 2);
		await deposits("1234", 9000, 2);
		await answerFor("ACME CORP", "yes", true);
		const { html } = await answerAsShown("yes", true);
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
		await keepAsShown();
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

describe("the bills ledger line reads what the step recorded", () => {
	it("doesn't count a bill added on the Bills page the same day", async () => {
		await charge("NETFLIX", 1500);
		await keepAsShown();
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
		await keepAsShown();
		await charge("SPOTIFY", 1200);
		await keepAsShown();
		const { html } = await get("/first-page");
		expect(textOf(html)).toContain("Bills · 2 kept, about $27 a month");
	});
});

describe("a Keep that fails part-way", () => {
	it("still counts the bill it kept, and a retry counts the rest", async () => {
		await charge("NETFLIX", 1549);
		await charge("SPOTIFY", 1199);
		const shown = keepFields((await get("/first-page")).html);
		// The first bill goes in; the second is refused by the database, so the Keep errors after one bill.
		await db
			.prepare(
				"CREATE TRIGGER fail_keep BEFORE INSERT ON bills WHEN (SELECT COUNT(*) FROM bills) > 0 BEGIN SELECT RAISE(ABORT, 'forced'); END",
			)
			.run();
		try {
			const failed = await post("/first-page/bills", shown);
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

		const { res, html } = await post("/first-page/bills", shown, true);
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
		await answerFor("ACME CORP PAYROLL", "yes");
		await answerFor("XFER FROM SAVINGS", "no");
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
		const { html } = await get("/first-page");
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
		await answerAsShown("yes");
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
		await answerAsShown("no");
		const { html } = await get("/first-page");
		expect(textOf(html)).not.toMatch(/Not pay|Pay · /);
		expect(textOf(html)).toContain("From Chase");
	});
});

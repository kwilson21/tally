import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_TIME_ZONE,
	daysBefore,
	monthsBefore,
	todayIn,
} from "../src/dates";
import { markStroke } from "../src/db/first-tally";
import { resetDemo } from "../src/demo/reset";
import { firstPage } from "../src/routes/first-page";
import { setupRoute } from "../src/routes/setup";
import { envWith } from "./helpers/doubles";
import { pinClock } from "./pinned-clock";

// The setup routes read their answer words, the category id and the shown price at the edge (#1006, plan 4). The first
// blocks pin today's answers for bad input; the last block pins the intended differences (a padded id, a spaced or
// decimal price), which are the only answers that change.

// The clock is pinned before any date is read, so the household month the page uses is the one these dates name (#808).
pinClock();

const db = env.DB;
const BASE = "http://tally.test";
const TODAY = todayIn(DEFAULT_TIME_ZONE);
const CUR = TODAY.slice(0, 7);
const MONTH_2 = monthsBefore(CUR, 2);
const MONTH_1 = monthsBefore(CUR, 1);
const STROKE_ONE = daysBefore(TODAY, 2);

/** The setup routes mounted as the family app serves them, with a verified identity. */
function app() {
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
				envWith(env, { DB: db, DEMO: "false" }),
				{ waitUntil() {}, passThroughOnException() {}, props: {} },
			);
		},
	};
}

/** A form post with the household month the form showed (the current one unless a test names another). */
async function post(path: string, fields: [string, string][], htmx = true) {
	const withMonth = fields.some(([name]) => name === "month")
		? fields
		: [...fields, ["month", CUR]];

	const headers = new Headers({
		"content-type": "application/x-www-form-urlencoded",
	});

	if (htmx) headers.set("HX-Request", "true");

	const res = await app().fetch(path, {
		method: "POST",
		redirect: "manual",
		headers,
		body: new URLSearchParams(withMonth).toString(),
	});

	return { res, text: await res.text() };
}

/** The toast message an htmx answer sends, or undefined when it sends none. */
const toastOf = (res: Response) => {
	const parsed: { toast?: { message: string; type: string } } = JSON.parse(
		res.headers.get("HX-Trigger") ?? "{}",
	);

	return parsed.toast?.message;
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

let seq = 0;

/** One expense on the one connected bank; amount_cents is money out, as Plaid sends it. */
async function spend(categoryId: number, cents: number, date: string) {
	seq += 1;

	await db
		.prepare(
			"INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name, category_id, category_source, category_confidence, income_confidence, flag_income) VALUES (1, ?, ?, ?, ?, ?, 'user', 90, 0, 0)",
		)
		.bind(`edge-${seq}`, date, cents, `SHOP ${seq}`, categoryId)
		.run();
}

/** The four categories in play, in the order the budgets step asks them. A's suggestion is $650 (65000 cents). */
let A = 0;
let nameA = "";

afterEach(() => {
	vi.useRealTimers();
});

/** The gate open: stroke one drawn, the bank's history in, and the budgets step asking about four categories. */
beforeEach(async () => {
	pinClock();
	await resetDemo(db, TODAY);
	await db.prepare("DELETE FROM transactions").run();
	await db.prepare("DELETE FROM bill_payments").run();
	await db.prepare("DELETE FROM bills").run();
	await db.prepare("DELETE FROM merchant_suggested_names").run();
	await db.prepare("DELETE FROM merchants").run();
	await db.prepare("DELETE FROM accounts").run();
	await db.prepare("DELETE FROM plaid_items").run();
	await db.prepare("DELETE FROM budget_amounts").run();
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
	await db.prepare("UPDATE categories SET archived = 1").run();

	const ids = await db
		.prepare("SELECT id, name FROM categories ORDER BY id LIMIT 4")
		.all<{ id: number; name: string }>();

	const [a, b, c, d] = ids.results;
	A = a?.id ?? 0;
	nameA = a?.name ?? "";

	for (const [index, id] of [a, b, c, d].entries()) {
		if (!id) continue;
		await db
			.prepare(
				"UPDATE categories SET archived = 0, sort_order = ? WHERE id = ?",
			)
			.bind(index + 1, id.id)
			.run();
	}

	// A: $610 then $674, so its suggestion is $650. B: $100 then $200. D: about $1,000,001 a month.
	await spend(A, 61000, `${MONTH_2}-01`);
	await spend(A, 67400, `${MONTH_1}-01`);

	if (b) {
		await spend(b.id, 10000, `${MONTH_2}-01`);
		await spend(b.id, 20000, `${MONTH_1}-01`);
	}

	if (d) {
		await spend(d.id, 100000100, `${MONTH_2}-01`);
		await spend(d.id, 100000100, `${MONTH_1}-01`);
	}
});

describe("the answer words, a closed gate (#1006, plan 4)", () => {
	beforeEach(async () => {
		// Shut the gate: no stroke one, so the questions are not open.
		await db
			.prepare("DELETE FROM household_settings WHERE key = 'first_tally'")
			.run();
	});

	it("answers a closed gate's pay with a junk answer as not open, never a 400", async () => {
		const { res, text } = await post("/setup/pay", [
			["merchant", "ACME"],
			["answer", "maybe"],
		]);

		expect(res.status).toBe(204);
		expect(res.headers.get("HX-Redirect")).toBe("/");
		expect(text).toBe("");
	});

	it("answers a closed gate's budgets with a junk answer as not open, never a 400", async () => {
		const { res } = await post("/setup/budgets", [["answer", "maybe"]]);

		expect(res.status).toBe(204);
		expect(res.headers.get("HX-Redirect")).toBe("/");
	});

	it("answers a closed gate's savings with a junk answer as not open, never a 400", async () => {
		const { res } = await post("/setup/savings", [["answer", "maybe"]]);

		expect(res.status).toBe(204);
		expect(res.headers.get("HX-Redirect")).toBe("/");
	});
});

describe("the answer words, the gate open", () => {
	it.each([
		["a word not on the list", "maybe"],
		["an empty word", ""],
		["the word in another case", "YES"],
		["a word with a space", " no"],
	])(
		"refuses a pay answer that is %s with the sentence, and writes nothing",
		async (_label, answer) => {
			const { res, text } = await post("/setup/pay", [
				["merchant", "ACME"],
				["answer", answer],
			]);

			expect(res.status).toBe(400);
			expect(text).toBe("Choose yes or no.");
		},
	);

	it("refuses a pay with no answer at all with the same sentence", async () => {
		const { res, text } = await post("/setup/pay", [["merchant", "ACME"]]);

		expect(res.status).toBe(400);
		expect(text).toBe("Choose yes or no.");
	});

	it.each([
		["a word not on the list", "maybe"],
		["an empty word", ""],
		["the word in another case", "ALL"],
		["no answer at all", undefined],
	])(
		"refuses a budgets answer that is %s with the sentence",
		async (_label, answer) => {
			const fields: [string, string][] =
				answer === undefined ? [] : [["answer", answer]];

			const { res, text } = await post("/setup/budgets", fields);

			expect(res.status).toBe(400);
			expect(text).toBe("Choose an answer.");
		},
	);

	it.each([
		["a word not on the list", "maybe"],
		["an empty word", ""],
		["the word in another case", "SAVE"],
	])(
		"refuses a savings answer that is %s with the sentence",
		async (_label, answer) => {
			const { res, text } = await post("/setup/savings", [["answer", answer]]);

			expect(res.status).toBe(400);
			expect(text).toBe("Choose an answer.");
		},
	);
});

describe("the category id and the shown price, a Yes on the first question", () => {
	/** A's question, answered Yes at `shown` for `category`. Nothing changes the budget unless the answer is right. */
	const yes = (category: string, shown: string | undefined) => {
		const fields: [string, string][] = [
			["answer", "yes"],
			["category", category],
		];

		if (shown !== undefined) fields.push(["shown", shown]);

		return post("/setup/budgets", fields);
	};

	it.each([
		["a missing category", undefined],
		["an empty category", ""],
		["a category that is text", "abc"],
		["a category of 0", "0"],
		["a negative category", "-1"],
		["a decimal category", "1.5"],
		["an exponent category", "1e3"],
		["a category that is a space", " "],
	])(
		"answers %s the same as no question for it: nothing is written",
		async (_label, category) => {
			const fields: [string, string][] = [
				["answer", "yes"],
				["shown", "65000"],
			];

			if (category !== undefined) fields.push(["category", category]);
			const { res } = await post("/setup/budgets", fields);

			expect(res.status).toBe(200);
			expect(toastOf(res)).toBe("That one is already answered.");
			expect(await budgetRows(A)).toEqual([]);
		},
	);

	it.each([
		["a missing shown price", undefined],
		["an empty shown price", ""],
		["a shown price that is text", "abc"],
		["a shown price of 0", "0"],
		["a shown price of Infinity", "Infinity"],
		["a negative shown price", "-65000"],
		["a decimal shown price", "65000.5"],
		["a shown price of 16 digits", "1234567890123456"],
		["a shown price of 20 digits", "99999999999999999999"],
	])(
		"refuses %s with the first question's words, and writes nothing",
		async (_label, shown) => {
			const { res } = await yes(String(A), shown);

			expect(res.status).toBe(200);
			expect(toastOf(res)).toBe(
				`Nothing saved. ${nameA}'s suggestion changed since the page drew, so it's asked again below.`,
			);
			expect(await budgetRows(A)).toEqual([]);
		},
	);

	it("saves a Yes whose shown price is the suggestion, to the cent", async () => {
		const { res } = await yes(String(A), "65000");

		expect(res.status).toBe(200);
		expect(await budgetRows(A)).toEqual([65000]);
	});

	it("saves a Yes whose shown price has leading zeros, as Number reads it", async () => {
		const { res } = await yes(String(A), "065000");

		expect(res.status).toBe(200);
		expect(await budgetRows(A)).toEqual([65000]);
	});

	it("saves a Yes whose shown price is a plain 0-led zero", async () => {
		// "0" is no suggestion, so it refuses (checked above); this pins that the Yes path still reads a zero-led price.
		const { res } = await yes(String(A), "00065000");

		expect(res.status).toBe(200);
		expect(await budgetRows(A)).toEqual([65000]);
	});
});

describe("intended differences: a padded id, a spaced or exponent price (#1006, plan 4)", () => {
	it("refuses a category written with a leading zero, where Number accepted it", async () => {
		const { res } = await post("/setup/budgets", [
			["answer", "yes"],
			["category", `0${A}`],
			["shown", "65000"],
		]);

		expect(res.status).toBe(200);
		expect(toastOf(res)).toBe("That one is already answered.");
		expect(await budgetRows(A)).toEqual([]);
	});

	it("refuses a category with spaces around it, where Number accepted it", async () => {
		const { res } = await post("/setup/budgets", [
			["answer", "yes"],
			["category", ` ${A} `],
			["shown", "65000"],
		]);

		expect(res.status).toBe(200);
		expect(toastOf(res)).toBe("That one is already answered.");
		expect(await budgetRows(A)).toEqual([]);
	});

	it.each([
		["a shown price with spaces", " 65000 "],
		["a shown price with a decimal point", "65000.0"],
		["a shown price in exponent form", "6.5e4"],
		["a shown price in hex", "0xFDE8"],
	])("refuses %s, where Number accepted it", async (_label, shown) => {
		const { res } = await post("/setup/budgets", [
			["answer", "yes"],
			["category", String(A)],
			["shown", shown],
		]);

		expect(res.status).toBe(200);
		expect(toastOf(res)).toBe(
			`Nothing saved. ${nameA}'s suggestion changed since the page drew, so it's asked again below.`,
		);
		expect(await budgetRows(A)).toEqual([]);
	});
});

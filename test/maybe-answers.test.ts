import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { householdToday } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { suggestions } from "../src/routes/suggestions";

// The answer record (decision 155, spec §5 and §8.6): each Yes or No on a "Maybe …" that changed a guess writes one
// row with the kind, the guess's confidence, the answer and the household's day. No transaction, name or amount.

const db = env.DB;
const BASE = "http://tally.test";
const COLUMNS = [
	"answer",
	"confidence",
	"created_at",
	"household_day",
	"id",
	"kind",
];

const screen = new Hono<{ Bindings: Env; Variables: { actor: string } }>();
screen.use("*", async (c, next) => {
	c.set("actor", "test@example.com");
	await next();
});
screen.route("/", suggestions);

async function answerOn(fields: Record<string, string>) {
	return screen.request(
		"/settings/suggestions",
		{
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(fields).toString(),
		},
		env,
		{ waitUntil() {}, passThroughOnException() {}, props: {} },
	);
}

async function insertTransaction(fields: {
	raw: string;
	amount: number;
	incomeConfidence?: number;
	transferConfidence?: number;
	jevCategoryId?: number;
	categoryConfidence?: number;
}): Promise<number> {
	const account = await db
		.prepare("SELECT id FROM accounts ORDER BY id LIMIT 1")
		.first<{ id: number }>();
	const row = await db
		.prepare(
			`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name,
				income_confidence, transfer_confidence, jev_category_id, category_confidence)
			VALUES (?, ?, '2026-10-03', ?, ?, ?, ?, ?, ?) RETURNING id`,
		)
		.bind(
			`plaid-${crypto.randomUUID()}`,
			account?.id ?? 1,
			fields.amount,
			fields.raw,
			fields.incomeConfidence ?? null,
			fields.transferConfidence ?? null,
			fields.jevCategoryId ?? null,
			fields.categoryConfidence ?? null,
		)
		.first<{ id: number }>();
	return row?.id ?? 0;
}

const records = async () =>
	(
		await db
			.prepare("SELECT * FROM maybe_answers ORDER BY id")
			.all<Record<string, unknown>>()
	).results;

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare("DELETE FROM never_suggest_rules"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM maybe_answers"),
	]);
});

describe("maybe_answers: one row per Yes or No that changes a guess", () => {
	it("records an income Yes and an income No, each with its kind, confidence, answer and the household's day", async () => {
		const day = await householdToday(db);
		const yes = await insertTransaction({
			raw: "VENMO YES",
			amount: -250000,
			incomeConfidence: 0.6,
		});
		await answerOn({ id: `income-${yes}`, answer: "yes" });
		const no = await insertTransaction({
			raw: "VENMO NO",
			amount: -250000,
			incomeConfidence: 0.55,
		});
		await answerOn({ id: `income-${no}`, answer: "no" });
		expect(await records()).toEqual([
			{
				id: 1,
				kind: "income",
				confidence: 0.6,
				answer: "yes",
				household_day: day,
				created_at: expect.any(String),
			},
			{
				id: 2,
				kind: "income",
				confidence: 0.55,
				answer: "no",
				household_day: day,
				created_at: expect.any(String),
			},
		]);
	});

	it("records a transfer Yes and a transfer No", async () => {
		const day = await householdToday(db);
		const yes = await insertTransaction({
			raw: "CHASE PAY YES",
			amount: 20000,
			transferConfidence: 0.7,
		});
		await answerOn({ id: `transfer-${yes}`, answer: "yes" });
		const no = await insertTransaction({
			raw: "CHASE PAY NO",
			amount: 20000,
			transferConfidence: 0.45,
		});
		await answerOn({ id: `transfer-${no}`, answer: "no" });
		expect(await records()).toMatchObject([
			{ kind: "transfer", confidence: 0.7, answer: "yes", household_day: day },
			{ kind: "transfer", confidence: 0.45, answer: "no", household_day: day },
		]);
	});

	it("records a category Yes and a category Something else, with the category guess's confidence", async () => {
		const day = await householdToday(db);
		const eatingOut = await db
			.prepare("SELECT id FROM categories WHERE name = 'Eating Out'")
			.first<{ id: number }>();
		const other = await db
			.prepare(
				"SELECT id FROM categories WHERE archived = 0 AND name <> 'Eating Out' ORDER BY id LIMIT 1",
			)
			.first<{ id: number }>();
		const yes = await insertTransaction({
			raw: "CAFE YES",
			amount: 2300,
			jevCategoryId: eatingOut?.id,
			categoryConfidence: 0.5,
		});
		await answerOn({ id: `category-${yes}`, answer: "yes" });
		const elsewhere = await insertTransaction({
			raw: "CAFE ELSE",
			amount: 2300,
			jevCategoryId: eatingOut?.id,
			categoryConfidence: 0.42,
		});
		await answerOn({
			id: `category-${elsewhere}`,
			answer: "else",
			category: String(other?.id),
		});
		expect(await records()).toMatchObject([
			{ kind: "category", confidence: 0.5, answer: "yes", household_day: day },
			{
				kind: "category",
				confidence: 0.42,
				answer: "something_else",
				household_day: day,
			},
		]);
	});

	it("keeps no column that names the transaction, its merchant or its amount", async () => {
		const id = await insertTransaction({
			raw: "PRIVATE MERCHANT NAME",
			amount: 20000,
			transferConfidence: 0.5,
		});
		await answerOn({ id: `transfer-${id}`, answer: "yes" });
		const [row] = await records();
		expect(Object.keys(row ?? {}).sort()).toEqual(COLUMNS);
		expect(JSON.stringify(row)).not.toContain("PRIVATE MERCHANT NAME");
	});

	it("an answer that changes nothing, or an answer the screen does not write, records nothing", async () => {
		const sure = await insertTransaction({
			raw: "SURE TRANSFER",
			amount: 20000,
			transferConfidence: 0.95,
		});
		await answerOn({ id: `transfer-${sure}`, answer: "yes" });
		const asked = await insertTransaction({
			raw: "ASKED TRANSFER",
			amount: 20000,
			transferConfidence: 0.5,
		});
		await answerOn({ id: `transfer-${asked}`, answer: "skip" });
		expect(await records()).toEqual([]);
	});

	it("the reset empties the record with the rest of the demo", async () => {
		await db
			.prepare(
				"INSERT INTO maybe_answers (kind, confidence, answer, household_day) VALUES ('income', 0.5, 'yes', '2026-10-03')",
			)
			.run();
		await resetDemo(db, "2026-09-22");
		expect(
			await db
				.prepare("SELECT COUNT(*) AS n FROM maybe_answers")
				.first<{ n: number }>(),
		).toEqual({ n: 0 });
	});
});

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import migration from "../migrations/0024_category_suggestions.sql?raw";
import { JEV_URL } from "../src/ai/categorize";
import { NONE_FIT } from "../src/ai/decide";
import { askAgain, categorizePending } from "../src/categorize-pending";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { saveAiSwitches } from "../src/db/ai-switches";
import { noneFitTransactions } from "../src/db/category-suggestions";
import { saveJevResult } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";

// Spec §5, §7 (#51): when Jev says none of the categories fit, Tally keeps that as a fact of its own
// (`transactions.jev_none_fit`), so an answer given while "Guess categories" was off, which stores a
// confidence and no pick, is never mistaken for it.

const db = env.DB;
const JEV_KEY = { JEV_API_KEY: "jev-key" };

/** A fake Jev answering every call with `choice` at `confidence`. */
function fakeJev(choice: string, confidence: number) {
	const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
		if (String(url) !== JEV_URL) throw new Error(`unexpected fetch ${url}`);
		return Response.json({
			answers: {
				category: { type: "choice", choice, confidence },
				transfer: { type: "noul", noul: 0.01 },
				reimbursement: { type: "noul", noul: 0.01 },
				income: { type: "noul", noul: 0.01 },
			},
		});
	});
	return fetchImpl as unknown as typeof fetch & typeof fetchImpl;
}

const idOf = async (rawName: string) =>
	(
		await db
			.prepare("SELECT id FROM transactions WHERE raw_name = ? LIMIT 1")
			.bind(rawName)
			.first<{ id: number }>()
	)?.id as number;
const marked = (id: number) =>
	db
		.prepare(
			"SELECT jev_none_fit, jev_category_id, category_confidence, category_id FROM transactions WHERE id = ?",
		)
		.bind(id)
		.first();

beforeEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	await resetDemo(db, todayIn(DEFAULT_TIME_ZONE));
	await saveAiSwitches(db, { details: false });
	await db
		.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'")
		.run();
});

describe("saveJevResult", () => {
	const decision = (over = {}) => ({
		categoryId: null,
		suggestedCategoryId: null,
		confidence: 0.95,
		flags: { transfer: false, reimbursement: false, income: false },
		...over,
	});

	it("keeps a none-fit answer as a fact of its own, beside its confidence and no pick", async () => {
		const id = await idOf("POS 4417 CITY PARKING");
		await saveJevResult(db, id, decision({ noneFit: true }));
		expect(await marked(id)).toEqual({
			jev_none_fit: 1,
			jev_category_id: null,
			category_confidence: 0.95,
			category_id: null,
		});
	});

	it("doesn't mark a pick, an unsure answer or one given with no category question", async () => {
		const a = await idOf("PAYPAL *XYZSHOP");
		const b = await idOf("SQ *FARMERS MKT");
		const c = await idOf("VENMO *J RIVERA");
		await saveJevResult(
			db,
			a,
			decision({ suggestedCategoryId: 1, categoryId: 1 }),
		);
		await saveJevResult(
			db,
			b,
			decision({ suggestedCategoryId: 1, confidence: 0.5 }),
		);
		await saveJevResult(db, c, decision());
		for (const id of [a, b, c])
			expect(await marked(id)).toMatchObject({ jev_none_fit: 0 });
	});

	it("does not store category answers when the request had no category choices", async () => {
		const id = await idOf("VENMO *J RIVERA");
		await saveJevResult(db, id, decision({ noneFit: true }), {
			categoryAsked: false,
		});
		expect(await marked(id)).toMatchObject({
			jev_none_fit: 0,
			jev_category_id: null,
			category_confidence: null,
		});
	});

	it("keeps it for a credit a person already reviewed, which Jev only helps with the category of", async () => {
		const id = await idOf("VENMO *J RIVERA");
		await db
			.prepare(
				"UPDATE transactions SET amount_cents = -4000, credit_reviewed = 1, credit_reviewed_by = 'user', income_source = 'user' WHERE id = ?",
			)
			.bind(id)
			.run();
		await saveJevResult(db, id, decision({ noneFit: true }), {
			categoryOnly: true,
		});
		expect(await marked(id)).toMatchObject({ jev_none_fit: 1 });
	});
});

describe("categorizePending marks what Jev said", () => {
	it("marks a none-fit answer while Guess categories is on, and it counts toward a suggestion at 0.80 or more", async () => {
		const id = await idOf("POS 4417 CITY PARKING");
		await categorizePending({ DB: db, ...JEV_KEY }, fakeJev(NONE_FIT, 0.92), {
			onlyIds: [id],
		});
		expect(await marked(id)).toMatchObject({
			jev_none_fit: 1,
			jev_category_id: null,
			category_confidence: 0.92,
		});
		for (let copy = 0; copy < 2; copy++)
			await db
				.prepare(
					`INSERT INTO transactions (account_id,date,amount_cents,raw_name,merchant_name,plaid_category,category_confidence,jev_none_fit)
					 SELECT account_id,date,amount_cents,raw_name,merchant_name,plaid_category,0.92,1 FROM transactions WHERE id=?`,
				)
				.bind(id)
				.run();
		expect((await noneFitTransactions(db)).map((r) => r.id)).toContain(id);
	});

	it("marks a low-confidence none-fit too, but it doesn't count: it behaves like unsure", async () => {
		const id = await idOf("POS 4417 CITY PARKING");
		await categorizePending({ DB: db, ...JEV_KEY }, fakeJev(NONE_FIT, 0.55), {
			onlyIds: [id],
		});
		expect(await marked(id)).toMatchObject({ jev_none_fit: 1 });
		expect((await noneFitTransactions(db)).map((r) => r.id)).not.toContain(id);
	});

	it("doesn't mark a category pick, sure or not", async () => {
		const id = await idOf("POS 4417 CITY PARKING");
		await categorizePending({ DB: db, ...JEV_KEY }, fakeJev("Gas", 0.5), {
			onlyIds: [id],
		});
		expect(await marked(id)).toMatchObject({
			jev_none_fit: 0,
			jev_category_id: 3,
		});
	});

	it("marks nothing while Guess categories is off, though Jev is still asked for income and stores a confidence", async () => {
		await saveAiSwitches(db, { categories: false });
		const id = await idOf("POS 4417 CITY PARKING");
		await categorizePending({ DB: db, ...JEV_KEY }, fakeJev(NONE_FIT, 0.97), {
			onlyIds: [id],
		});
		expect(await marked(id)).toEqual({
			jev_none_fit: 0,
			jev_category_id: null,
			category_confidence: 0.97,
			category_id: null,
		});
		expect(await noneFitTransactions(db)).toEqual([]);
	});

	it("asks again about several transactions at once when they are left out of a suggestion, clearing each one's earlier answer first", async () => {
		const ids = [
			await idOf("POS 4417 CITY PARKING"),
			await idOf("SQ *FARMERS MKT"),
		];
		await db
			.prepare(
				"UPDATE transactions SET category_confidence = 0.95, jev_none_fit = 1 WHERE id IN (?, ?)",
			)
			.bind(...ids)
			.run();
		const jev = fakeJev("Gas", 0.9);
		vi.stubGlobal("fetch", jev);
		await Promise.all(ids.map((id) => askAgain({ DB: db, ...JEV_KEY }, id)));
		expect(jev).toHaveBeenCalledTimes(2);
		for (const id of ids)
			expect(await marked(id)).toMatchObject({
				jev_none_fit: 0,
				jev_category_id: 3,
				category_id: 3,
			});
	});

	it("still asks again about one transaction by its id, as it did", async () => {
		const id = await idOf("POS 4417 CITY PARKING");
		await db
			.prepare(
				"UPDATE transactions SET category_confidence = 0.4, jev_category_id = 1 WHERE id = ?",
			)
			.bind(id)
			.run();
		const jev = fakeJev("Gas", 0.9);
		vi.stubGlobal("fetch", jev);
		await askAgain({ DB: db, ...JEV_KEY }, id);
		expect(jev).toHaveBeenCalledTimes(1);
		expect(await marked(id)).toMatchObject({ category_id: 3 });
	});

	it("leaves the unticked ones to the night when Jev isn't asked right away, since their earlier answer is cleared", async () => {
		const id = await idOf("POS 4417 CITY PARKING");
		await db
			.prepare(
				"UPDATE transactions SET category_confidence = 0.95, jev_none_fit = 1 WHERE id = ?",
			)
			.bind(id)
			.run();
		await saveAiSwitches(db, { categories: false, income: false });
		await askAgain({ DB: db, ...JEV_KEY }, id);
		expect(await marked(id)).toMatchObject({ category_confidence: null });
		await saveAiSwitches(db, { categories: true, income: true });
		const jev = fakeJev("Gas", 0.9);
		await categorizePending({ DB: db, ...JEV_KEY }, jev);
		expect(await marked(id)).toMatchObject({ category_id: 3 });
	});
});

describe("migration 0024", () => {
	it("starts fresh and never infers none-fit from earlier Jev answers", () => {
		expect(migration).not.toMatch(/UPDATE\s+transactions/i);
	});
});

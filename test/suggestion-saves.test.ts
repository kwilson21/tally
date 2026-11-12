import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it } from "vitest";
import { runWith } from "../src/db/database";
import { decideName, nameFacts } from "../src/db/merchant-names";
import {
	categoryMaybeStatements,
	fileFacts,
	fileStatements,
	maybeChangedSinceRead,
	maybeFacts,
	moneyMaybeStatements,
	neverSuggestChangedSinceRead,
	neverSuggestFacts,
	neverSuggestStatements,
} from "../src/db/suggestion-saves";
import { resetDemo } from "../src/demo/reset";
import { answerNameSuggestion } from "../src/rules/suggestions";
import { seedMerchant } from "./helpers/merchants";

// The suggestions area's guards (decision 190): an answer is saved only while what its rule read is still true, and a
// miss raises an error the save loop recognises, so the rule is asked again. The races through the page itself are in
// test/suggestions-route.test.ts and test/suggestions-queue.test.ts.

const db = env.DB;
const TODAY = "2026-11-12";
const WHO = "person@example.com";

/** The error a batch fails with, or null when it runs. */
const raised = async (statements: D1PreparedStatement[]) => {
	try {
		await db.batch(statements);
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}

	return null;
};

const categoryId = async (name: string) =>
	(
		await db
			.prepare("SELECT id FROM categories WHERE name = ?")
			.bind(name)
			.first<{ id: number }>()
	)?.id ?? 0;

/** A purchase the review asks about: Tally guessed Eating Out, half sure. */
const maybeCategory = async () => {
	const row = await db
		.prepare(
			`INSERT INTO transactions (account_id, date, amount_cents, raw_name, jev_category_id, category_confidence)
			VALUES ((SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', 2300, 'SQ *LUPITAS TAQ', ?, 0.5)
			RETURNING id`,
		)
		.bind(await categoryId("Eating Out"))
		.first<{ id: number }>();

	return row?.id ?? 0;
};

const stored = (id: number) =>
	db
		.prepare(
			"SELECT category_id AS categoryId, category_source AS source, transfer_maybe_declined AS declined FROM transactions WHERE id = ?",
		)
		.bind(id)
		.first<{
			categoryId: number | null;
			source: string | null;
			declined: number;
		}>();

const answers = async () =>
	(
		await db
			.prepare("SELECT COUNT(*) AS n FROM maybe_answers")
			.first<{ n: number }>()
	)?.n ?? 0;

const fileSomewhereElse = (id: number, category: number) =>
	db
		.prepare(
			"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
		)
		.bind(category, id)
		.run();

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.prepare("DELETE FROM maybe_answers").run();
});

describe("a Maybe's guard", () => {
	it("reads a purchase the review asks about, and one it does not", async () => {
		const id = await maybeCategory();
		const eatingOut = await categoryId("Eating Out");

		expect(await maybeFacts(db, "category", id, eatingOut)).toMatchObject({
			asked: true,
			confidence: 0.5,
			guessedCategoryId: eatingOut,
			chosen: { id: eatingOut, name: "Eating Out", archived: false },
		});
		expect(await maybeFacts(db, "category", 999_999)).toEqual({
			asked: false,
			confidence: null,
			guessedCategoryId: null,
			chosen: null,
			version: "none",
		});
	});

	it("raises, and saves nothing, when the purchase was filed after the read", async () => {
		const id = await maybeCategory();
		const groceries = await categoryId("Groceries");
		const eatingOut = await categoryId("Eating Out");
		const { version } = await maybeFacts(db, "category", id, eatingOut);

		await fileSomewhereElse(id, groceries);

		const error = await raised(
			categoryMaybeStatements(db, {
				transactionId: id,
				categoryId: eatingOut,
				today: TODAY,
				who: WHO,
				record: "yes",
				confidence: 0.5,
				expectedVersion: version,
			}),
		);

		expect(error !== null && maybeChangedSinceRead(error)).toBe(true);
		expect(await stored(id)).toMatchObject({ categoryId: groceries });
		expect(await answers()).toBe(0);
	});

	it("raises for a money answer on a stale version, and saves nothing", async () => {
		const id = await maybeCategory();

		const error = await raised(
			moneyMaybeStatements(db, {
				kind: "transfer",
				answer: "no",
				transactionId: id,
				today: TODAY,
				who: WHO,
				confidence: 0.5,
				expectedVersion: "stale",
			}),
		);

		expect(error !== null && maybeChangedSinceRead(error)).toBe(true);
		expect(await stored(id)).toMatchObject({ declined: 0 });
		expect(await answers()).toBe(0);
	});

	it("does not take another failure for the guard's", () => {
		expect(
			maybeChangedSinceRead(
				new Error("NOT NULL constraint failed: maybe_answers.kind"),
			),
		).toBe(false);
		expect(
			neverSuggestChangedSinceRead(
				new Error("NOT NULL constraint failed: never_suggest_rules.kind"),
			),
		).toBe(false);
	});
});

describe("the filing's guard", () => {
	it("raises, and makes no category, when the list changed after the read", async () => {
		const id = await maybeCategory();
		const facts = await fileFacts(db, id);

		await db
			.prepare(
				"UPDATE categories SET name = 'Food at home', name_key = 'food at home' WHERE name = 'Groceries'",
			)
			.run();

		const error = await raised(
			fileStatements(db, {
				transactionId: id,
				today: TODAY,
				who: WHO,
				create: {
					name: "Tacos",
					nameKey: "tacos",
					color: "cat-blue",
					sortOrder: 99,
				},
				categoryId: null,
				name: "Tacos",
				record: "something_else",
				confidence: 0.5,
				expectedVersion: facts.version,
			}),
		);

		expect(error !== null && maybeChangedSinceRead(error)).toBe(true);
		expect(await categoryId("Tacos")).toBe(0);
		expect(await stored(id)).toMatchObject({ categoryId: null, source: null });
	});

	it("makes the category and files the purchase in it when nothing changed", async () => {
		const id = await maybeCategory();
		const facts = await fileFacts(db, id);

		await db.batch(
			fileStatements(db, {
				transactionId: id,
				today: TODAY,
				who: WHO,
				create: {
					name: "Tacos",
					nameKey: "tacos",
					color: "cat-blue",
					sortOrder: 99,
				},
				categoryId: null,
				name: "Tacos",
				record: "something_else",
				confidence: 0.5,
				expectedVersion: facts.version,
			}),
		);

		expect(await stored(id)).toMatchObject({
			categoryId: await categoryId("Tacos"),
			source: "user",
		});
		expect(await answers()).toBe(1);
	});
});

describe("the Never suggest guard", () => {
	it("raises, and keeps no line, when the question's stores changed after the read", async () => {
		const facts = await neverSuggestFacts(db, "transfer", 999_999);

		expect(facts).toEqual({ asked: [], version: "" });

		const error = await raised(
			neverSuggestStatements(db, {
				kind: "transfer",
				itemId: 999_999,
				stores: ["SOME STORE"],
				today: TODAY,
				expectedVersion: "stale",
			}),
		);

		expect(error !== null && neverSuggestChangedSinceRead(error)).toBe(true);
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS n FROM never_suggest_rules WHERE merchant_key = 'SOME STORE'",
				)
				.first(),
		).toEqual({ n: 0 });
	});
});

describe("a suggested name's guard", () => {
	it("asks the rule again when the offered names changed between the read and the save", async () => {
		await seedMerchant(db, {
			key: "ZED CAFE",
			status: "pending",
			names: ["Zed Cafe"],
		});

		const stale = await nameFacts(db, "ZED CAFE");
		let asked = 0;

		await db
			.prepare(
				"UPDATE merchant_suggested_names SET name = 'Zed Coffee' WHERE merchant_key = 'ZED CAFE'",
			)
			.run();

		await runWith(
			db,
			decideName(
				{
					decide: (request, facts) => {
						asked++;

						return answerNameSuggestion.decide(
							request,
							asked === 1 ? stale : facts,
						);
					},
				},
				{
					merchantKey: "ZED CAFE",
					choice: { kind: "name", name: "Zed Cafe" },
					today: TODAY,
				},
			).pipe(Effect.asVoid, Effect.orDie),
		);

		// The first answer would have accepted a name that is no longer offered; the second turns the suggestion down.
		expect(asked).toBe(2);
		expect(
			await db
				.prepare(
					"SELECT display_name AS name, suggestion_status AS status FROM merchants WHERE raw_name = 'ZED CAFE'",
				)
				.first(),
		).toEqual({ name: "Zed Cafe", status: "rejected" });
	});
});

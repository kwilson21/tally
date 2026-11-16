import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it } from "vitest";
import { runWith } from "../src/db/database";
import { decideName, nameFacts } from "../src/db/merchant-names";
import {
	categoryMaybeStatements,
	fileFacts,
	fileInNewCategory,
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

// with_line (migration 0078, decision 225): a Maybe answer records 1 only when it answered a kept line-backed guess, as
// read in the answer's own batch, and 0 for every other answer, always 0 for income and transfer.
describe("with_line: a Maybe answer says whether it answered a kept line-backed guess", () => {
	/** A purchase Tally guessed Eating Out at `confidence`, half of the review's asked range or above it. */
	const guessed = async (confidence: number, transferConfidence?: number) =>
		(
			await db
				.prepare(
					`INSERT INTO transactions (account_id, date, amount_cents, raw_name, jev_category_id, category_confidence, transfer_confidence)
					VALUES ((SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', 2300, 'SQ *LUPITAS TAQ', ?, ?, ?)
					RETURNING id`,
				)
				.bind(
					await categoryId("Eating Out"),
					confidence,
					transferConfidence ?? null,
				)
				.first<{ id: number }>()
		)?.id ?? 0;

	/** The store lookup's line row for `id`: kept or not, and the copies it holds. */
	const keepLine = (
		id: number,
		kept: 0 | 1,
		category: number | null,
		confidence: number | null,
	) =>
		db
			.prepare(
				"INSERT INTO lookup_answers (transaction_id, lookup_text, kept, kept_category_id, kept_confidence) VALUES (?, 'LUPITAS', ?, ?, ?)",
			)
			.bind(id, kept, category, confidence)
			.run();

	/** The category answer's save, as the route makes it: the record and the category the person set. */
	const saveCategory = async (
		id: number,
		category: number,
		record: "yes" | "something_else",
		confidence: number,
	) => {
		const { version } = await maybeFacts(db, "category", id, category);

		await db.batch(
			categoryMaybeStatements(db, {
				transactionId: id,
				categoryId: category,
				today: TODAY,
				who: WHO,
				record,
				confidence,
				expectedVersion: version,
			}),
		);
	};

	const lastAnswer = (kind: string) =>
		db
			.prepare(
				"SELECT with_line AS withLine, answer, confidence FROM maybe_answers WHERE kind = ? ORDER BY id DESC LIMIT 1",
			)
			.bind(kind)
			.first<{ withLine: number; answer: string; confidence: number }>();

	it.each([
		[
			"a Yes on a kept line guess at 95%",
			"category",
			async () => {
				const id = await guessed(0.95);
				await keepLine(id, 1, await categoryId("Eating Out"), 0.95);
				await saveCategory(id, await categoryId("Eating Out"), "yes", 0.95);
			},
			{ withLine: 1, answer: "yes", confidence: 0.95 },
		],
		[
			"a Something else on a kept line guess (Groceries)",
			"category",
			async () => {
				const id = await guessed(0.95);
				await keepLine(id, 1, await categoryId("Eating Out"), 0.95);
				await saveCategory(
					id,
					await categoryId("Groceries"),
					"something_else",
					0.95,
				);
			},
			{ withLine: 1, answer: "something_else", confidence: 0.95 },
		],
		[
			"a filing into an existing category, on a kept line guess",
			"category",
			async () => {
				const id = await guessed(0.95);
				await keepLine(id, 1, await categoryId("Eating Out"), 0.95);
				await fileInNewCategory(db, {
					transactionId: id,
					target: {
						ok: true,
						kind: "existing",
						id: await categoryId("Groceries"),
						name: "Groceries",
					},
					today: TODAY,
					who: WHO,
				});
			},
			{ withLine: 1 },
		],
		[
			"a filing into a new category, on a kept line guess",
			"category",
			async () => {
				const id = await guessed(0.95);
				await keepLine(id, 1, await categoryId("Eating Out"), 0.95);
				await fileInNewCategory(db, {
					transactionId: id,
					target: {
						ok: true,
						kind: "create",
						name: "Books and audio",
						color: "#334455",
					},
					today: TODAY,
					who: WHO,
				});
			},
			{ withLine: 1 },
		],
		[
			"a Yes with no line row, at 60%",
			"category",
			async () => {
				const id = await guessed(0.6);
				await saveCategory(id, await categoryId("Eating Out"), "yes", 0.6);
			},
			{ withLine: 0, answer: "yes", confidence: 0.6 },
		],
		[
			"a Yes on a line row that kept 0",
			"category",
			async () => {
				const id = await guessed(0.95);
				await keepLine(id, 0, null, null);
				await saveCategory(id, await categoryId("Eating Out"), "yes", 0.95);
			},
			{ withLine: 0, answer: "yes", confidence: 0.95 },
		],
		[
			"a Yes on a kept line whose confidence copy is 5 points lower",
			"category",
			async () => {
				const id = await guessed(0.95);
				await keepLine(id, 1, await categoryId("Eating Out"), 0.9);
				await saveCategory(id, await categoryId("Eating Out"), "yes", 0.95);
			},
			{ withLine: 0, answer: "yes", confidence: 0.95 },
		],
		[
			"an income Yes",
			"income",
			async () => {
				const id =
					(
						await db
							.prepare(
								`INSERT INTO transactions (account_id, date, amount_cents, raw_name, income_confidence)
							VALUES ((SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', -500000, 'PAYROLL', 0.5)
							RETURNING id`,
							)
							.first<{ id: number }>()
					)?.id ?? 0;

				const { version } = await maybeFacts(db, "income", id);

				await db.batch(
					moneyMaybeStatements(db, {
						kind: "income",
						answer: "yes",
						transactionId: id,
						today: TODAY,
						who: WHO,
						confidence: 0.5,
						expectedVersion: version,
					}),
				);
			},
			{ withLine: 0, answer: "yes", confidence: 0.5 },
		],
		[
			"a transfer Yes",
			"transfer",
			async () => {
				const id = await guessed(0.95, 0.5);
				const { version } = await maybeFacts(db, "transfer", id);

				await db.batch(
					moneyMaybeStatements(db, {
						kind: "transfer",
						answer: "yes",
						transactionId: id,
						today: TODAY,
						who: WHO,
						confidence: 0.5,
						expectedVersion: version,
					}),
				);
			},
			{ withLine: 0, answer: "yes", confidence: 0.5 },
		],
		[
			"an income Yes on a row with a matching kept line",
			"income",
			async () => {
				const eatingOut = await categoryId("Eating Out");

				const id =
					(
						await db
							.prepare(
								`INSERT INTO transactions (account_id, date, amount_cents, raw_name, income_confidence, jev_category_id, category_confidence)
							VALUES ((SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', -500000, 'PAYROLL', 0.5, ?, 0.95)
							RETURNING id`,
							)
							.bind(eatingOut)
							.first<{ id: number }>()
					)?.id ?? 0;

				await keepLine(id, 1, eatingOut, 0.95);

				const { version } = await maybeFacts(db, "income", id);

				await db.batch(
					moneyMaybeStatements(db, {
						kind: "income",
						answer: "yes",
						transactionId: id,
						today: TODAY,
						who: WHO,
						confidence: 0.5,
						expectedVersion: version,
					}),
				);
			},
			{ withLine: 0, answer: "yes", confidence: 0.5 },
		],
	])(
		"%s records with_line as the batch reads it",
		async (_name, kind, act, expected) => {
			await act();

			expect(await lastAnswer(kind)).toMatchObject(expected);
		},
	);
});

// A stale card writes nothing (decision 190): a Yes saved on the version the card was drawn with raises, and the
// with_line record is not written either, since it sits in the same guarded batch as the answer.
describe("a stale line-backed card writes nothing", () => {
	it("raises for a Yes on the old version, and records no answer", async () => {
		const id = await (async () => {
			const row = await db
				.prepare(
					`INSERT INTO transactions (account_id, date, amount_cents, raw_name, jev_category_id, category_confidence)
					VALUES ((SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', 2300, 'SQ *LUPITAS TAQ', ?, 0.95)
					RETURNING id`,
				)
				.bind(await categoryId("Eating Out"))
				.first<{ id: number }>();

			return row?.id ?? 0;
		})();

		const eatingOut = await categoryId("Eating Out");

		await db
			.prepare(
				"INSERT INTO lookup_answers (transaction_id, lookup_text, kept, kept_category_id, kept_confidence) VALUES (?, 'LUPITAS', 1, ?, 0.95)",
			)
			.bind(id, eatingOut)
			.run();

		const { version } = await maybeFacts(db, "category", id, eatingOut);

		await db
			.prepare("UPDATE transactions SET category_confidence = 0.9 WHERE id = ?")
			.bind(id)
			.run();

		const error = await raised(
			categoryMaybeStatements(db, {
				transactionId: id,
				categoryId: eatingOut,
				today: TODAY,
				who: WHO,
				record: "yes",
				confidence: 0.95,
				expectedVersion: version,
			}),
		);

		expect(error !== null && maybeChangedSinceRead(error)).toBe(true);
		expect(await answers()).toBe(0);
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

// 16. The card guard (#987 part B): a line-backed card's version reads the kept answer, so a card drawn while it stood is
// refused once the answer is no longer kept.
describe("16. a line-backed card's guard", () => {
	const lineRow = async () => {
		const eatingOut = await categoryId("Eating Out");
		const row = await db
			.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, jev_category_id, category_confidence)
				VALUES ((SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-03', 1800, 'SQ *HARBOR BAKERY', ?, 0.6)
				RETURNING id`,
			)
			.bind(eatingOut)
			.first<{ id: number }>();
		const id = row?.id ?? 0;

		await db
			.prepare(
				"INSERT INTO lookup_answers (transaction_id, lookup_text, kept, kept_category_id, kept_confidence) VALUES (?, 'HARBOR BAKERY', 1, ?, 0.6)",
			)
			.bind(id, eatingOut)
			.run();

		return { id, eatingOut };
	};

	const writeFor = (
		kind: "category" | "filing",
		id: number,
		eatingOut: number,
		version: string,
	) =>
		kind === "category"
			? categoryMaybeStatements(db, {
					transactionId: id,
					categoryId: eatingOut,
					today: TODAY,
					who: WHO,
					record: "yes",
					confidence: 0.6,
					expectedVersion: version,
				})
			: fileStatements(db, {
					transactionId: id,
					today: TODAY,
					who: WHO,
					create: null,
					categoryId: eatingOut,
					name: "Eating Out",
					record: "yes",
					confidence: 0.6,
					expectedVersion: version,
				});

	const versionFor = async (
		kind: "category" | "filing",
		id: number,
		eatingOut: number,
	) =>
		kind === "category"
			? (await maybeFacts(db, "category", id, eatingOut)).version
			: (await fileFacts(db, id)).version;

	it.each(["category", "filing"] as const)(
		"%s: refuses a save drawn while the line-backed guess stood, once it is no longer kept",
		async (kind) => {
			const { id, eatingOut } = await lineRow();
			const version = await versionFor(kind, id, eatingOut);

			await db
				.prepare("UPDATE lookup_answers SET kept = 0 WHERE transaction_id = ?")
				.bind(id)
				.run();

			expect(await raised(writeFor(kind, id, eatingOut, version))).not.toBeNull();
		},
	);

	it.each(["category", "filing"] as const)(
		"%s: positive control, the same save is accepted while the guess is still kept",
		async (kind) => {
			const { id, eatingOut } = await lineRow();
			const version = await versionFor(kind, id, eatingOut);

			expect(await raised(writeFor(kind, id, eatingOut, version))).toBeNull();
		},
	);
});

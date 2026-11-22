import { beforeAll, describe, expect, it, vi } from "vitest";
import { NONE_FIT } from "../src/ai/decide";
import { cleanBankText } from "../src/clean-bank-text";
import type { AiSwitches } from "../src/db/ai-switches";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { suggestionQueue } from "../src/db/suggestions-queue";
import { listRowsByIds } from "../src/db/transactions";
import { lookupTextOf } from "../src/lookup/lookup-text";
import { askSecondRow, readSecondAsk } from "../src/lookup/second-ask";
import { ASK_BUDGET_MS, dailyJevCap } from "../src/sort-groups";
import {
	answerOf,
	callsFor,
	categoryId,
	categoryReply,
	DAY,
	dayCount,
	db,
	fakeJev,
	foundStore,
	gateOpen,
	guessOf,
	guessRow,
	isSecondAskBody,
	type JevBody,
	LINE,
	MINUTE,
	NOON_MS,
	params,
	RUN_ID,
	runSecond,
	STORE_A,
	STORE_B,
} from "./second-ask-setup";

// The second ask (#987 part B, spec §7 "The second ask", decision 225), through the sorting instance with fake steps.

/** The owed table's base: store A found with its line, and one posted purchase at it that Jev filed at 0.6 (Eating Out). */
async function base() {
	await foundStore(STORE_A);

	return guessRow(STORE_A);
}

/** A sibling of R1's text with a different raw name and a bank-text rule on its cleaned text (rule 6c). */
const SIDE_RAW = "Harbor Bakery 42 77";

async function addSibling() {
	await guessRow(SIDE_RAW, {
		plaid_transaction_id: "side-10",
		category_confidence: 0.9,
	});
	await db
		.prepare(
			"INSERT INTO bank_text_rules (cleaned_text, category_id) VALUES (?, ?)",
		)
		.bind(cleanBankText(SIDE_RAW), await categoryId("Groceries"))
		.run();
}

/** A Jev reply to any ordinary (group) call: the category at a confidence, every flag low. */
const groupReply = (choice: string, confidence: number) =>
	new Response(
		JSON.stringify({
			answers: {
				category: { type: "choice", choice, confidence },
				transfer: { type: "noul", noul: 0.01 },
				reimbursement: { type: "noul", noul: 0.01 },
				income: { type: "noul", noul: 0.01 },
			},
		}),
		{ status: 200 },
	);

// 4. Rule 14, at the group's call: only the second ask carries the line.
describe("4. firstAskHasNoLine", () => {
	it("sends no line on the group's first ask, and the line on the second", async () => {
		await foundStore(STORE_A);

		const row = await guessRow(STORE_A, {
			category_confidence: null,
			jev_category_id: null,
		});

		const fake = fakeJev((body) =>
			isSecondAskBody(body)
				? categoryReply("Groceries", 0.95)
				: groupReply("Eating Out", 0.6),
		);

		await runSecond(fake.fetchImpl, {
			runParams: { ...params, ids: [row] },
		});

		const [first, second] = fake.bodies;

		expect(first && "store_lookup" in first.state).toBe(false);
		expect(second?.state.store_lookup).toBe(LINE);
	});
});

// 5. Rule 6 and 5.1: the owed table.
describe("5. the owed table", () => {
	const owed: {
		name: string;
		asked: boolean;
		setup?: (r1: number) => Promise<void>;
		/** Run in beforeAttempt of the read, after the fill: the change a read must see (rule 9). */
		during?: () => Promise<void>;
		switches?: Partial<AiSwitches>;
		bySync?: boolean;
	}[] = [
		{ name: "none (positive control)", asked: true },
		{
			name: "Look up new stores on the web off",
			asked: false,
			switches: { lookupStores: false },
		},
		{ name: "Spot paychecks off", asked: false, switches: { income: false } },
		{
			name: "a sync, Sort right away off",
			asked: false,
			bySync: true,
			switches: { sortOnArrival: false },
		},
		{ name: "a sync, Sort right away on", asked: true, bySync: true },
		{
			name: "another purchase waits for Jev",
			asked: false,
			setup: async () => {
				await guessRow(STORE_A, {
					category_confidence: null,
					jev_category_id: null,
					plaid_transaction_id: "wait-1",
				});
			},
		},
		{
			name: "R1 has a lookup_answers row (kept 0)",
			asked: false,
			setup: async (r1) => {
				await db
					.prepare(
						"INSERT INTO lookup_answers (transaction_id, lookup_text, kept) VALUES (?, 'harbor bakery', 0)",
					)
					.bind(r1)
					.run();
			},
		},
		{
			name: "R1 filed by Jev (Eating Out, 0.9)",
			asked: false,
			setup: async (r1) => {
				await db
					.prepare(
						"UPDATE transactions SET category_id = jev_category_id, category_source = 'jev', category_confidence = 0.9 WHERE id = ?",
					)
					.bind(r1)
					.run();
			},
		},
		{
			name: "R1's confidence NULL, Jev gave up on the call",
			asked: false,
			setup: async (r1) => {
				await db
					.prepare(
						"UPDATE transactions SET category_confidence = NULL, jev_failed_at = ? WHERE id = ?",
					)
					.bind(`${DAY} 12:00:00`, r1)
					.run();
			},
		},
		{
			name: "R1 is a split part",
			asked: false,
			setup: async (r1) => {
				const parent = await guessRow(STORE_B, {
					plaid_transaction_id: "parent-1",
				});

				await db
					.prepare("UPDATE transactions SET parent_id = ? WHERE id = ?")
					.bind(parent, r1)
					.run();
			},
		},
		{
			name: "R1 is pending (Q1)",
			asked: false,
			setup: async (r1) => {
				await db
					.prepare("UPDATE transactions SET pending = 1 WHERE id = ?")
					.bind(r1)
					.run();
			},
		},
		{
			name: "R1 is an unreviewed credit (-1200)",
			asked: false,
			setup: async (r1) => {
				await db
					.prepare("UPDATE transactions SET amount_cents = -1200 WHERE id = ?")
					.bind(r1)
					.run();
			},
		},
		{
			name: "R1 is a reviewed credit (-1200)",
			asked: true,
			setup: async (r1) => {
				await db
					.prepare(
						"UPDATE transactions SET amount_cents = -1200, credit_reviewed = 1 WHERE id = ?",
					)
					.bind(r1)
					.run();
			},
		},
		{
			name: "Jev gave up on R1",
			asked: false,
			setup: async (r1) => {
				await db
					.prepare("UPDATE transactions SET jev_attempts = 5 WHERE id = ?")
					.bind(r1)
					.run();
			},
		},
		{
			name: "A is nothing_found",
			asked: false,
			setup: async () => {
				await db
					.prepare(
						"UPDATE merchant_lookups SET status = 'nothing_found' WHERE lookup_text = 'harbor bakery'",
					)
					.run();
			},
		},
		{
			name: "A is found with no line",
			asked: false,
			setup: async () => {
				await db
					.prepare(
						"UPDATE merchant_lookups SET line = NULL WHERE lookup_text = 'harbor bakery'",
					)
					.run();
			},
		},
		{
			name: "a sibling's flag_transfer set after the fill (rule 9)",
			asked: false,
			setup: async () => {
				await guessRow(STORE_A, { plaid_transaction_id: "sibling-9" });
			},
			during: async () => {
				await db
					.prepare(
						"UPDATE transactions SET flag_transfer = 1 WHERE plaid_transaction_id = 'sibling-9'",
					)
					.run();
			},
		},
		{
			name: "another key of the same text is private",
			asked: false,
			setup: async () => {
				await db
					.prepare(
						"INSERT INTO merchant_lookup_texts (merchant_key, lookup_text, private) VALUES ('HARBOR BAKERY 42 SQ', 'harbor bakery', 1)",
					)
					.run();
			},
		},
		{
			name: "a sibling filed by a person (user)",
			asked: false,
			setup: async () => {
				await guessRow(STORE_A, {
					plaid_transaction_id: "user-1",
					category_id: await categoryId("Groceries"),
					category_source: "user",
					jev_category_id: await categoryId("Groceries"),
					category_confidence: 0.9,
				});
			},
		},
		{
			name: "a sibling filed by Always for these merchants (merchant_rule)",
			asked: false,
			setup: async () => {
				await guessRow(STORE_A, {
					plaid_transaction_id: "rule-1",
					category_id: await categoryId("Groceries"),
					category_source: "merchant_rule",
					jev_category_id: await categoryId("Groceries"),
					category_confidence: 0.9,
				});
			},
		},
		{
			name: "an active merchant rule on R1's key",
			asked: false,
			setup: async () => {
				await db
					.prepare(
						"INSERT INTO merchants (raw_name, default_category_id) VALUES (?, ?)",
					)
					.bind(STORE_A, await categoryId("Groceries"))
					.run();
			},
		},
		{
			name: "an archived merchant rule",
			asked: true,
			setup: async () => {
				await db
					.prepare(
						"INSERT INTO merchants (raw_name, default_category_id) VALUES (?, ?)",
					)
					.bind(STORE_A, await categoryId("Groceries"))
					.run();
				await db
					.prepare(
						"UPDATE categories SET archived = 1 WHERE name = 'Groceries'",
					)
					.run();
			},
		},
		{
			name: "a bank-text rule on a sibling's cleaned text",
			asked: false,
			setup: async () => {
				await addSibling();
			},
		},
		{
			name: "a learned line for R1's cleaned text, from a person's row of another text",
			asked: false,
			setup: async () => {
				await guessRow(STORE_A, {
					plaid_transaction_id: "learned-1",
					merchant_name: "Other Store",
					category_id: await categoryId("Groceries"),
					category_source: "user",
					jev_category_id: await categoryId("Groceries"),
					category_confidence: 0.9,
				});
			},
		},
		{
			name: "one sibling filed by Jev, another by a bill",
			asked: true,
			setup: async () => {
				await guessRow(STORE_A, {
					plaid_transaction_id: "jev-sib",
					category_id: await categoryId("Groceries"),
					category_source: "jev",
					jev_category_id: await categoryId("Groceries"),
					category_confidence: 0.9,
				});
				await guessRow(STORE_A, {
					plaid_transaction_id: "bill-sib",
					category_id: await categoryId("Groceries"),
					category_source: "bill",
					jev_category_id: await categoryId("Groceries"),
					category_confidence: 0.9,
				});
			},
		},
		{
			name: "Q-B1: a confident None fit behind a pending new-category suggestion",
			asked: false,
			setup: async (r1) => {
				const suggestion = await db
					.prepare(
						"INSERT INTO category_suggestions (name, status) VALUES ('Pet food', 'pending') RETURNING id",
					)
					.first<{ id: number }>();

				await db
					.prepare(
						"UPDATE transactions SET jev_category_id = NULL, jev_none_fit = 1, category_confidence = 0.85, category_suggestion_id = ? WHERE id = ?",
					)
					.bind(suggestion?.id, r1)
					.run();
			},
		},
		{
			name: "26b: a confident None fit whose suggestion was dismissed (the card no longer asks): asked",
			asked: true,
			setup: async (r1) => {
				const suggestion = await db
					.prepare(
						"INSERT INTO category_suggestions (name, status, decided_at) VALUES ('Pet food', 'dismissed', datetime('now')) RETURNING id",
					)
					.first<{ id: number }>();

				await db
					.prepare(
						"UPDATE transactions SET jev_category_id = NULL, jev_none_fit = 1, category_confidence = 0.85, category_suggestion_id = ? WHERE id = ?",
					)
					.bind(suggestion?.id, r1)
					.run();
			},
		},
	];

	it.each(owed)(
		"$name: asked $asked",
		async ({ asked, setup, during, switches, bySync }) => {
			const r1 = await base();

			if (switches) {
				const { saveAiSwitches, AI_SWITCHES_ALL_ON } = await import(
					"../src/db/ai-switches"
				);

				await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, ...switches });
			}

			await setup?.(r1);

			const fake = fakeJev(() => categoryReply("Groceries", 0.95));

			await runSecond(fake.fetchImpl, {
				runParams: bySync ? { ...params, bySync: true } : params,
				beforeAttempt: async (name) => {
					if (name === "lookup-second-read") await during?.();
				},
			});

			expect(fake.violations).toEqual([]);
			expect(callsFor(fake.bodies, STORE_A) > 0).toBe(asked);
		},
	);
});

// The sibling under another key with the same lookup text (arm (a) of householdAnsweredSql): R1 is under K1, and K2's cleaned
// text differs, so only a person's or a rule's filing under K2 can refuse R1, not a learned line (arm (d)).
const K1 = "Lupitas Taqueria";
const K2 = "LUPITAS TAQUERIA MEMBER1234";
const LUPITAS = "lupitas taqueria";

beforeAll(() => {
	expect(lookupTextOf(K2)).toBe(lookupTextOf(K1));
	expect(cleanBankText(K2)).not.toBe(cleanBankText(K1));
});

/** R1 under K1, at a found store with its line. */
async function lupitasBase() {
	await foundStore(K1);

	return guessRow(K1);
}

/** A row under K2 with the given filing (null: none), and K2's own text row for the same lookup text. */
async function addK2(source: "user" | "merchant_rule" | "jev" | null) {
	const groceries = await categoryId("Groceries");

	await guessRow(K2, {
		plaid_transaction_id: "k2-row",
		category_id: source ? groceries : null,
		category_source: source,
		jev_category_id: groceries,
		category_confidence: source ? 0.9 : 0.6,
	});
	await db
		.prepare(
			"INSERT INTO merchant_lookup_texts (merchant_key, lookup_text, private) VALUES (?, ?, 0) ON CONFLICT(merchant_key) DO NOTHING",
		)
		.bind(K2, LUPITAS)
		.run();
}

// 19b and 20b: a sibling under K2 filed by a person or by a rule means R1 is not asked (owed table, arm (a)).
describe("19b and 20b. a filing under another key of the store", () => {
	it.each([
		{ name: "no sibling (positive control)", source: null, asked: true },
		{
			name: "19b: the K2 sibling is filed by a person (user)",
			source: "user" as const,
			asked: false,
		},
		{
			name: "20b: the K2 sibling is filed by Always for these merchants (merchant_rule)",
			source: "merchant_rule" as const,
			asked: false,
		},
	])("$name", async ({ source, asked }) => {
		await lupitasBase();
		await addK2(source);

		const fake = fakeJev(() => categoryReply("Groceries", 0.95));

		await runSecond(fake.fetchImpl);

		expect(fake.violations).toEqual([]);
		expect(callsFor(fake.bodies, K1) > 0).toBe(asked);

		if (source) {
			const text = await db
				.prepare(
					"SELECT lookup_text AS text FROM merchant_lookup_texts WHERE merchant_key = ?",
				)
				.bind(K2)
				.first<{ text: string }>();

			expect(text?.text).toBe(LUPITAS);
		}
	});
});

// 6. Newest first, ten a run.
describe("6. newest first, 10 a run", () => {
	it("asks the ten newest owed rows in order, then the other two on the next run", async () => {
		await foundStore(STORE_A);

		const names: string[] = [];

		for (let i = 1; i <= 12; i += 1) {
			const name = `Harbor Bakery 4${i}`;

			await foundStore(name);
			names.push(name);
			await guessRow(name, { plaid_transaction_id: `order-${i}` });
		}

		const fake = fakeJev(() => categoryReply("Groceries", 0.95));

		await runSecond(fake.fetchImpl);

		const askedFirst = fake.bodies.map((body) =>
			String(body.state.bank_description),
		);

		expect(askedFirst).toEqual([...names].reverse().slice(0, 10));

		const next = fakeJev(() => categoryReply("Groceries", 0.95));

		await runSecond(next.fetchImpl);

		expect(
			next.bodies.map((body) => String(body.state.bank_description)),
		).toEqual([...names].slice(0, 2).reverse());
	});
});

// 7. The day's cap.
describe("7. the day's cap", () => {
	it("reserves and gives back the calls against the day's count", async () => {
		const cap = await dailyJevCap(db, gateOpen);

		await foundStore(STORE_A);
		await foundStore(STORE_B);
		await guessRow(STORE_A, { plaid_transaction_id: "cap-1" });
		await guessRow(STORE_B, { plaid_transaction_id: "cap-2" });

		await db
			.prepare("INSERT INTO household_settings (key, value) VALUES (?, ?)")
			.bind(`jev_calls_${DAY}`, String(cap - 1))
			.run();

		const fake = fakeJev(() => categoryReply("Groceries", 0.95));

		await runSecond(fake.fetchImpl);

		expect(fake.bodies).toHaveLength(1);
		expect(await dayCount()).toBe(cap);
	});

	it("gives back the calls it did not make, so the count is five less than the cap minus one more", async () => {
		const cap = await dailyJevCap(db, gateOpen);

		await foundStore(STORE_A);
		await guessRow(STORE_A, { plaid_transaction_id: "cap-3" });

		await db
			.prepare("INSERT INTO household_settings (key, value) VALUES (?, ?)")
			.bind(`jev_calls_${DAY}`, String(cap - 5))
			.run();

		const fake = fakeJev(() => categoryReply("Groceries", 0.95));

		await runSecond(fake.fetchImpl);

		expect(fake.bodies).toHaveLength(1);
		expect(await dayCount()).toBe(cap - 4);
	});
});

// 8. The exit table (5.3): R1 is the newer row at store A; R2 the older at store B, always answered Groceries 0.9.
type Exit = {
	name: string;
	reply: (body: JevBody) => Response | Promise<Response>;
	before?: (r1: number) => Promise<void>;
	runOptions?: (r1: number) => Parameters<typeof runSecond>[1];
	kept: number | null;
	r1Confidence: number;
	r1Category: string;
	r2Asked: boolean;
	count: number;
	again: boolean;
};

describe("8. the exit table", () => {
	const rows: Exit[] = [
		{
			name: "1: Groceries 0.95 is kept",
			reply: () => categoryReply("Groceries", 0.95),
			kept: 1,
			r1Confidence: 0.95,
			r1Category: "Groceries",
			r2Asked: true,
			count: 2,
			again: false,
		},
		{
			name: "2: Eating Out 0.9 (same category, more sure) is kept",
			reply: () => categoryReply("Eating Out", 0.9),
			kept: 1,
			r1Confidence: 0.9,
			r1Category: "Eating Out",
			r2Asked: true,
			count: 2,
			again: false,
		},
		{
			name: "3: Groceries 0.6 (a tie) is not kept",
			reply: () => categoryReply("Groceries", 0.6),
			kept: 0,
			r1Confidence: 0.6,
			r1Category: "Eating Out",
			r2Asked: true,
			count: 2,
			again: false,
		},
		{
			name: "4: Groceries 0.5 is not kept",
			reply: () => categoryReply("Groceries", 0.5),
			kept: 0,
			r1Confidence: 0.6,
			r1Category: "Eating Out",
			r2Asked: true,
			count: 2,
			again: false,
		},
		{
			name: "5: None fit 0.99 is not kept (Q2)",
			reply: () => categoryReply(NONE_FIT, 0.99),
			kept: 0,
			r1Confidence: 0.6,
			r1Category: "Eating Out",
			r2Asked: true,
			count: 2,
			again: false,
		},
		{
			name: "6: Jev 500 writes kept 0 and stops",
			reply: () => new Response("", { status: 500 }),
			kept: 0,
			r1Confidence: 0.6,
			r1Category: "Eating Out",
			r2Asked: false,
			count: 1,
			again: false,
		},
		{
			name: "7: a 429 with retry-after writes kept 0 and stops",
			reply: () =>
				new Response("", { status: 429, headers: { "retry-after": "30" } }),
			kept: 0,
			r1Confidence: 0.6,
			r1Category: "Eating Out",
			r2Asked: false,
			count: 1,
			again: false,
		},
		{
			name: "8: a 200 naming a category not offered (Q-B2) writes kept 0 and stops",
			reply: () => categoryReply("Not a category", 0.9),
			kept: 0,
			r1Confidence: 0.6,
			r1Category: "Eating Out",
			r2Asked: false,
			count: 1,
			again: false,
		},
		{
			name: "9: a fetch that throws writes kept 0 and stops",
			reply: () => {
				throw new Error("network");
			},
			kept: 0,
			r1Confidence: 0.6,
			r1Category: "Eating Out",
			r2Asked: false,
			count: 1,
			again: false,
		},
		{
			name: "10: the row step throws once (attempt 2, no call) writes kept 0 and stops",
			reply: () => categoryReply("Groceries", 0.95),
			runOptions: (r1) => ({ throws: { [`lookup-second-row-${r1}`]: 1 } }),
			kept: 0,
			r1Confidence: 0.6,
			r1Category: "Eating Out",
			r2Asked: false,
			count: 1,
			again: false,
		},
		{
			name: "11: the row step is rejected writes kept 0 and stops",
			reply: () => categoryReply("Groceries", 0.95),
			runOptions: (r1) => ({ fails: [`lookup-second-row-${r1}`] }),
			kept: 0,
			r1Confidence: 0.6,
			r1Category: "Eating Out",
			r2Asked: false,
			count: 1,
			again: false,
		},
		{
			name: "12: out of time writes nothing and calls nothing",
			reply: () => categoryReply("Groceries", 0.95),
			runOptions: (r1) => ({
				beforeAttempt: async (name) => {
					if (name === `lookup-second-row-${r1}`)
						vi.setSystemTime(NOON_MS + 3 * MINUTE);
				},
			}),
			kept: null,
			r1Confidence: 0.6,
			r1Category: "Eating Out",
			r2Asked: false,
			count: 0,
			again: true,
		},
		{
			name: "13: the day changed writes nothing and calls nothing",
			reply: () => categoryReply("Groceries", 0.95),
			runOptions: (r1) => ({
				beforeAttempt: async (name) => {
					if (name === `lookup-second-row-${r1}`)
						vi.setSystemTime(NOON_MS + 24 * 60 * MINUTE);
				},
			}),
			kept: null,
			r1Confidence: 0.6,
			r1Category: "Eating Out",
			r2Asked: false,
			count: 0,
			again: true,
		},
		{
			name: "14: A's line dropped before the call: no call for R1, R2 asked",
			reply: () => categoryReply("Groceries", 0.95),
			runOptions: (r1) => ({
				beforeAttempt: async (name) => {
					if (name === `lookup-second-row-${r1}`) {
						await db
							.prepare(
								"UPDATE merchant_lookups SET line = NULL WHERE lookup_text = 'harbor bakery'",
							)
							.run();
					}
				},
			}),
			kept: null,
			r1Confidence: 0.6,
			r1Category: "Eating Out",
			r2Asked: true,
			count: 1,
			again: false,
		},
	];

	it.each(rows)("$name", async (row) => {
		const r1 = await base();
		await foundStore(STORE_B);
		await guessRow(STORE_B, { date: "2026-11-14", plaid_transaction_id: "r2" });

		const fake = fakeJev((body) =>
			body.state.bank_description === STORE_A
				? row.reply(body)
				: categoryReply("Groceries", 0.9),
		);

		await runSecond(fake.fetchImpl, row.runOptions?.(r1));

		const r1After = await guessOf(r1);
		const answer = await answerOf(r1);

		expect(r1After?.confidence).toBe(row.r1Confidence);
		expect(r1After?.jevCategoryId).toBe(await categoryId(row.r1Category));
		expect(r1After?.categoryId).toBeNull();
		expect(r1After?.categorySource).toBeNull();
		expect(r1After?.noneFit).toBe(0);
		expect(answer?.kept ?? null).toBe(row.kept);
		expect(callsFor(fake.bodies, STORE_B) > 0).toBe(row.r2Asked);
		expect(await dayCount()).toBe(row.count);
		expect(fake.violations).toEqual([]);

		vi.setSystemTime(NOON_MS);

		const again = fakeJev(() => categoryReply("Groceries", 0.95));

		await runSecond(again.fetchImpl);

		expect(callsFor(again.bodies, STORE_A) > 0).toBe(row.again);
	});
});

// 9. Rule 12: a line-backed guess kept at 0.95 keeps its guess and its attempts.
describe("9. secondAskKeepsBetter", () => {
	it("files nothing, keeps the attempts and the Maybe, and records the answer", async () => {
		const r1 = await base();
		await db
			.prepare("UPDATE transactions SET jev_attempts = 2 WHERE id = ?")
			.bind(r1)
			.run();

		const lookupCleared = await db
			.prepare(
				"SELECT input_mark AS mark, cleared FROM lookup_cleared WHERE transaction_id = ?",
			)
			.bind(r1)
			.first();

		const fake = fakeJev(() => categoryReply("Groceries", 0.95));

		await runSecond(fake.fetchImpl);

		const after = await guessOf(r1);
		const answer = await answerOf(r1);

		expect(after).toMatchObject({
			categoryId: null,
			categorySource: null,
			attempts: 2,
			noneFit: 0,
			alsoCategoryId: null,
			mixed: null,
			confidence: 0.95,
		});
		expect(answer).toEqual({
			kept: 1,
			keptCategoryId: await categoryId("Groceries"),
			keptConfidence: 0.95,
		});

		// The kept guess as people see it: the queue holds its category card, and the list row shows the Maybe chip.
		const queue = await suggestionQueue(db);

		expect(queue.map((item) => item.id)).toContain(`category-${r1}`);

		const [listed] = await listRowsByIds(db, [r1]);

		expect(listed).toMatchObject({
			categoryId: null,
			maybeCategoryName: "Groceries",
		});

		const lookupAfter = await db
			.prepare(
				"SELECT input_mark AS mark, cleared FROM lookup_cleared WHERE transaction_id = ?",
			)
			.bind(r1)
			.first();

		expect(lookupAfter).toEqual(lookupCleared);
	});
});

// 10. The guards at the save: each change is made while R1's call is in flight. `kept` is what R1's answer record must be:
// "yes" (kept 1), "none" (no record), or "injected" (the record another run wrote, left as it is).
type SaveGuard = {
	name: string;
	/** Run before the read, so the read holds what it holds in the table's row. */
	before?: () => Promise<void>;
	/** R1 is under K1 (the sibling fixtures) rather than STORE_A. */
	lupitas?: boolean;
	change: (r1: number) => Promise<void>;
	r2Asked: boolean;
	kept: "yes" | "none" | "injected";
	bySync?: boolean;
	limits?: Record<string, number>;
};

describe("10. the guards at the save", () => {
	const guards: SaveGuard[] = [
		{
			name: "nothing (positive control)",
			change: async () => {},
			r2Asked: true,
			kept: "yes",
		},
		{
			name: "a person files R1's sibling at A (user)",
			change: async () => {
				await guessRow(STORE_A, {
					plaid_transaction_id: "g10-user",
					category_id: await categoryId("Groceries"),
					category_source: "user",
					jev_category_id: await categoryId("Groceries"),
					category_confidence: 0.9,
				});
			},
			r2Asked: true,
			kept: "none",
		},
		{
			name: "an active merchant rule on A's key",
			change: async () => {
				await db
					.prepare(
						"INSERT INTO merchants (raw_name, default_category_id) VALUES (?, ?)",
					)
					.bind(STORE_A, await categoryId("Groceries"))
					.run();
			},
			r2Asked: true,
			kept: "none",
		},
		{
			name: "a bank-text rule on a sibling's cleaned text",
			// The sibling is there before the read (so the read holds its text); only the rule arrives during the call.
			before: async () => {
				await guessRow(SIDE_RAW, {
					plaid_transaction_id: "side-10",
					category_confidence: 0.9,
				});
			},
			change: async () => {
				await db
					.prepare(
						"INSERT INTO bank_text_rules (cleaned_text, category_id) VALUES (?, ?)",
					)
					.bind(cleanBankText(SIDE_RAW), await categoryId("Groceries"))
					.run();
			},
			r2Asked: true,
			kept: "none",
		},
		{
			name: "a person files a row of another text with R1's cleaned text",
			change: async () => {
				await guessRow(STORE_A, {
					plaid_transaction_id: "g10-learned",
					merchant_name: "Other Store",
					category_id: await categoryId("Groceries"),
					category_source: "user",
					jev_category_id: await categoryId("Groceries"),
					category_confidence: 0.9,
				});
			},
			r2Asked: true,
			kept: "none",
		},
		{
			name: "A's line dropped (skipped, line NULL)",
			change: async () => {
				await db
					.prepare(
						"UPDATE merchant_lookups SET status = 'skipped', line = NULL WHERE lookup_text = 'harbor bakery'",
					)
					.run();
			},
			r2Asked: true,
			kept: "none",
		},
		{
			name: "A's mark set private",
			change: async () => {
				await db
					.prepare(
						"UPDATE merchant_lookup_texts SET private = 1 WHERE lookup_text = 'harbor bakery'",
					)
					.run();
			},
			r2Asked: true,
			kept: "none",
		},
		{
			name: "the lookup switch off",
			change: async () => {
				await saveAiSwitches(db, {
					...AI_SWITCHES_ALL_ON,
					lookupStores: false,
				});
			},
			r2Asked: false,
			kept: "none",
		},
		{
			name: "a sync, Sort right away off",
			change: async () => {
				await saveAiSwitches(db, {
					...AI_SWITCHES_ALL_ON,
					sortOnArrival: false,
				});
			},
			r2Asked: false,
			kept: "none",
			bySync: true,
		},
		{
			name: "a person files the K2 sibling during R1's call (arm (a) at the save)",
			lupitas: true,
			before: async () => {
				await addK2("jev");
			},
			change: async () => {
				await db
					.prepare(
						"UPDATE transactions SET category_source = 'user' WHERE plaid_transaction_id = 'k2-row'",
					)
					.run();
			},
			r2Asked: true,
			kept: "none",
		},
		{
			name: "a new-category card is made pending for R1 during R1's call (the save refuses it)",
			change: async (r1) => {
				await db
					.prepare(
						"INSERT INTO category_suggestions (name, status) VALUES ('Pet food', 'pending')",
					)
					.run();
				await db
					.prepare(
						"UPDATE transactions SET category_suggestion_id = (SELECT id FROM category_suggestions WHERE name = 'Pet food' AND status = 'pending') WHERE id = ?",
					)
					.bind(r1)
					.run();
			},
			r2Asked: true,
			kept: "none",
		},
		{
			name: "R1's note edited",
			change: async (r1) => {
				await db
					.prepare("UPDATE transactions SET note = 'edited' WHERE id = ?")
					.bind(r1)
					.run();
			},
			r2Asked: true,
			kept: "none",
		},
		{
			name: "R1's guess changed to Groceries 0.7",
			change: async (r1) => {
				await db
					.prepare(
						"UPDATE transactions SET jev_category_id = ?, category_confidence = 0.7 WHERE id = ?",
					)
					.bind(await categoryId("Groceries"), r1)
					.run();
			},
			r2Asked: true,
			kept: "none",
		},
		{
			name: "a person files R1 (user, Groceries)",
			change: async (r1) => {
				await db
					.prepare(
						"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
					)
					.bind(await categoryId("Groceries"), r1)
					.run();
			},
			r2Asked: true,
			kept: "none",
		},
		{
			name: "a bill files R1 (bill)",
			change: async (r1) => {
				await db
					.prepare(
						"UPDATE transactions SET category_id = ?, category_source = 'bill' WHERE id = ?",
					)
					.bind(await categoryId("Groceries"), r1)
					.run();
			},
			r2Asked: true,
			kept: "none",
		},
		{
			name: "Groceries archived",
			change: async () => {
				await db
					.prepare(
						"UPDATE categories SET archived = 1 WHERE name = 'Groceries'",
					)
					.run();
			},
			r2Asked: true,
			kept: "none",
		},
		{
			name: "another run writes R1's lookup_answers (kept 0)",
			change: async (r1) => {
				await db
					.prepare(
						"INSERT INTO lookup_answers (transaction_id, lookup_text, kept) VALUES (?, 'harbor bakery', 0)",
					)
					.bind(r1)
					.run();
			},
			r2Asked: true,
			kept: "injected",
		},
		{
			name: "another run takes the sorting turn",
			change: async () => {
				await db
					.prepare(
						"UPDATE household_settings SET value = ? WHERE key = 'sorting_turn'",
					)
					.bind(JSON.stringify({ id: "other", until: NOON_MS + 15 * MINUTE }))
					.run();
			},
			// A caller that lost its turn must not spend another reserved call.
			r2Asked: false,
			kept: "none",
			limits: { "lookup-second-write": 1 },
		},
		{
			name: "R1 deleted during a Jev 500",
			change: async (r1) => {
				await db
					.prepare("DELETE FROM transactions WHERE id = ?")
					.bind(r1)
					.run();
			},
			r2Asked: false,
			kept: "none",
		},
	];

	it.each(guards)(
		"$name",
		async ({
			before,
			change,
			r2Asked,
			kept,
			bySync,
			limits,
			name,
			lupitas,
		}) => {
			const r1 = lupitas ? await lupitasBase() : await base();
			const r1Name = lupitas ? K1 : STORE_A;

			await before?.();

			await foundStore(STORE_B);
			await guessRow(STORE_B, {
				date: "2026-11-14",
				plaid_transaction_id: "r2-10",
			});

			const deleted = name === "R1 deleted during a Jev 500";

			const fake = fakeJev(async (body) => {
				if (body.state.bank_description !== r1Name)
					return categoryReply("Groceries", 0.9);

				await change(r1);

				if (deleted) return new Response("", { status: 500 });

				return categoryReply("Groceries", 0.95);
			});

			await runSecond(fake.fetchImpl, {
				runParams: bySync ? { ...params, bySync: true } : params,
				limits,
			});

			const after = await guessOf(r1);
			const answer = await answerOf(r1);

			if (kept === "yes") {
				expect(after).toMatchObject({
					confidence: 0.95,
					jevCategoryId: await categoryId("Groceries"),
				});
				expect(answer).toEqual({
					kept: 1,
					keptCategoryId: await categoryId("Groceries"),
					keptConfidence: 0.95,
				});
			} else if (kept === "injected") {
				expect(answer?.kept).toBe(0);
				expect(after?.confidence).not.toBe(0.95);
			} else if (!deleted) {
				expect(answer ?? null).toBeNull();
				expect(after?.confidence).not.toBe(0.95);
			}

			expect(callsFor(fake.bodies, STORE_B) > 0).toBe(r2Asked);
			expect(fake.violations).toEqual([]);
		},
	);
});

// 11. The read just before each call.
describe("11. the read just before each call", () => {
	const reads: [string, (r1: number) => Promise<void>, boolean, boolean][] = [
		["nothing", async () => {}, true, true],
		[
			"A's line dropped",
			async () => {
				await db
					.prepare(
						"UPDATE merchant_lookups SET line = NULL WHERE lookup_text = 'harbor bakery'",
					)
					.run();
			},
			false,
			true,
		],
		[
			"A's mark private (rule 9)",
			async () => {
				await db
					.prepare(
						"UPDATE merchant_lookup_texts SET private = 1 WHERE lookup_text = 'harbor bakery'",
					)
					.run();
			},
			false,
			true,
		],
		[
			"R1's sibling filed by a person",
			async () => {
				await guessRow(STORE_A, {
					plaid_transaction_id: "g11-user",
					category_id: await categoryId("Groceries"),
					category_source: "user",
					jev_category_id: await categoryId("Groceries"),
					category_confidence: 0.9,
				});
			},
			false,
			true,
		],
		[
			"a learned line for R1's cleaned text, from another text's person-filed row",
			async () => {
				await guessRow(STORE_A, {
					plaid_transaction_id: "g11-learned",
					merchant_name: "Other Store",
					category_id: await categoryId("Groceries"),
					category_source: "user",
					jev_category_id: await categoryId("Groceries"),
					category_confidence: 0.9,
				});
			},
			false,
			true,
		],
		[
			"the lookup switch off",
			async () => {
				const { saveAiSwitches, AI_SWITCHES_ALL_ON } = await import(
					"../src/db/ai-switches"
				);

				await saveAiSwitches(db, {
					...AI_SWITCHES_ALL_ON,
					lookupStores: false,
				});
			},
			false,
			false,
		],
	];

	it.each(reads)("%s", async (_name, change, r1Called, r2Asked) => {
		const r1 = await base();

		await foundStore(STORE_B);
		await guessRow(STORE_B, {
			date: "2026-11-14",
			plaid_transaction_id: "r2-11",
		});

		const fake = fakeJev(() => categoryReply("Groceries", 0.95));

		await runSecond(fake.fetchImpl, {
			beforeAttempt: async (name) => {
				if (name === `lookup-second-row-${r1}`) await change(r1);
			},
		});

		expect(callsFor(fake.bodies, STORE_A) > 0).toBe(r1Called);
		expect(callsFor(fake.bodies, STORE_B) > 0).toBe(r2Asked);
		expect(Boolean(await answerOf(r1))).toBe(r1Called);
		expect(fake.violations).toEqual([]);
	});
});

// 12. When it runs.
describe("12. when it runs", () => {
	it.each([
		["nightly", { ...params, night: DAY, bySync: false }, true],
		["after sync", { ...params, night: undefined, bySync: true }, true],
		["manual Ask again", { ...params, night: undefined, bySync: false }, false],
		[
			"manual category re-sort",
			{ ...params, night: undefined, bySync: false, rulesApplied: true },
			false,
		],
	] as const)(
		"%s follows the background-only second-ask boundary",
		async (_name, runParams, asks) => {
			await base();
			const fake = fakeJev(() => categoryReply("Groceries", 0.95));
			const steps = await runSecond(fake.fetchImpl, { runParams });
			expect(steps.names().includes("lookup-second-read")).toBe(asks);
			expect(fake.bodies.length > 0).toBe(asks);
		},
	);

	const off = [
		["no Jev key", { ...gateOpen, JEV_API_KEY: undefined }],
		["no Tavily key", { ...gateOpen, TAVILY_API_KEY: undefined }],
		["the demo", { ...gateOpen, DEMO: "true" }],
	] as const;

	it.each(off)(
		"%s: no second-ask step is registered",
		async (_name, instanceEnv) => {
			await base();

			const fake = fakeJev(() => categoryReply("Groceries", 0.95));

			const steps = await runSecond(fake.fetchImpl, { instanceEnv });

			expect(
				steps.names().some((name) => name.startsWith("lookup-second")),
			).toBe(false);
			expect(fake.bodies).toHaveLength(0);
		},
	);

	it("with the lookup switch off, the read runs and returns null (no row is asked)", async () => {
		await base();

		const { saveAiSwitches, AI_SWITCHES_ALL_ON } = await import(
			"../src/db/ai-switches"
		);

		await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, lookupStores: false });

		const fake = fakeJev(() => categoryReply("Groceries", 0.95));
		const steps = await runSecond(fake.fetchImpl);

		expect(steps.names()).toContain("lookup-second-read");
		expect(
			steps.names().some((name) => name.startsWith("lookup-second-row")),
		).toBe(false);
		expect(fake.bodies).toHaveLength(0);
	});

	it("when the privacy re-ask threw, the second ask still runs", async () => {
		await base();

		const fake = fakeJev(() => categoryReply("Groceries", 0.95));

		const steps = await runSecond(fake.fetchImpl, {
			fails: ["lookup-reask-read"],
		});

		expect(steps.names()).toContain("lookup-second-read");
	});

	it("with a row waiting for Jev, the read returns null and nothing is asked", async () => {
		await base();
		await guessRow(STORE_A, {
			plaid_transaction_id: "waiting-12",
			category_confidence: null,
			jev_category_id: null,
		});

		const fake = fakeJev(() => categoryReply("Groceries", 0.95));
		const steps = await runSecond(fake.fetchImpl);

		expect(
			steps.names().some((name) => name.startsWith("lookup-second-row")),
		).toBe(false);
		expect(fake.bodies).toHaveLength(0);
	});
});

// 13. Placement, and a throw.
describe("13. placement and a throw", () => {
	it("runs the second ask after the re-ask and before the night's names, and a throw is logged by its name", async () => {
		await base();

		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		const fake = fakeJev(() => categoryReply("Groceries", 0.95));

		const steps = await runSecond(fake.fetchImpl, {
			runParams: { ...params, night: DAY },
			fails: ["lookup-second-read"],
		});

		const names = steps.names();

		expect(names.indexOf("lookup-second-read")).toBeGreaterThan(-1);
		expect(names.indexOf("lookup-second-read")).toBeLessThan(
			names.indexOf("night-names"),
		);
		expect(names).toContain("night-names");
		expect(errors).toHaveBeenCalledWith("second ask: stopped Error");
	});
});

// 14. Steps: names, configs, the turn's id, nothing left behind, and each step replayed.
describe("14. steps", () => {
	it("names, configs, the turn's id, and what is left after the run", async () => {
		const r1 = await base();

		let turn: string | null = null;

		const fake = fakeJev(() => categoryReply("Groceries", 0.95));

		const steps = await runSecond(fake.fetchImpl, {
			beforeAttempt: async (name) => {
				if (name === `lookup-second-row-${r1}`) {
					const row = await db
						.prepare(
							"SELECT value FROM household_settings WHERE key = 'sorting_turn'",
						)
						.first<{ value: string }>();

					// SAFETY: the turn row is the JSON the sorting turn stores; its id is the only field read here.
					turn = row ? (JSON.parse(row.value) as { id: string }).id : null;
				}
			},
		});

		const second = steps.steps.filter((step) =>
			step.name.startsWith("lookup-second"),
		);

		expect(second.map((step) => step.name)).toEqual(
			expect.arrayContaining([
				"lookup-second-read",
				"lookup-second-reserve",
				`lookup-second-row-${r1}`,
				"lookup-second-write",
			]),
		);

		// The settings as literals, written here rather than imported, so a changed retry count or dropped `sensitive` fails.
		const literal = (name: string) =>
			name === "lookup-second-read"
				? {
						retries: { limit: 4, delay: "10 seconds", backoff: "constant" },
						timeout: "1 minute",
						sensitive: "output",
					}
				: name === "lookup-second-write"
					? {
							retries: { limit: 960, delay: "1 minute", backoff: "constant" },
							timeout: "30 seconds",
							sensitive: "output",
						}
					: {
							retries: { limit: 0, delay: 0 },
							timeout: "1 minute",
							sensitive: "output",
						};

		for (const step of second) {
			expect(step.name).toMatch(/^lookup-second-(read|reserve|row-\d+|write)$/);
			expect(step.config).toEqual(literal(step.name));
		}

		expect(turn).toBe(`${RUN_ID}:lookup-second`);

		const left = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM household_settings WHERE key = 'sorting_turn' OR key GLOB 'jev_reserved_*'",
			)
			.first<{ n: number }>();

		expect(left?.n).toBe(0);
	});

	it.each([
		"lookup-second-read",
		"lookup-second-reserve",
		"lookup-second-row",
		"lookup-second-write",
	])(
		"a replay of %s calls Jev once for R1 and changes no lookup_answers row",
		async (stepPrefix) => {
			const r1 = await base();

			const replayName =
				stepPrefix === "lookup-second-row"
					? `lookup-second-row-${r1}`
					: stepPrefix;

			const fake = fakeJev(() => categoryReply("Groceries", 0.95));

			await runSecond(fake.fetchImpl, { replayAfter: [replayName] });

			expect(callsFor(fake.bodies, STORE_A)).toBe(1);
			expect((await answerOf(r1))?.kept).toBe(1);
		},
	);
});

// Review round 2 (#987): the bank texts are read again before each call and at the save; a row that is waiting for Jev ends the
// step at once; and a grant goes only to a row that makes a call.
const K3 = "Harbor Bakery Annex";

/** A sibling under K3 (the same lookup text as A, a different cleaned text) with a bank-text rule on its cleaned text, arriving mid-run. */
async function addAnnexRule() {
	const groceries = await categoryId("Groceries");

	await guessRow(K3, {
		plaid_transaction_id: "k3-row",
		category_id: groceries,
		category_source: "jev",
		jev_category_id: groceries,
		category_confidence: 0.9,
	});
	await db
		.prepare(
			"INSERT INTO merchant_lookup_texts (merchant_key, lookup_text, private) VALUES (?, 'harbor bakery', 0) ON CONFLICT(merchant_key) DO NOTHING",
		)
		.bind(K3)
		.run();
	await db
		.prepare(
			"INSERT INTO bank_text_rules (cleaned_text, category_id) VALUES (?, ?)",
		)
		.bind(cleanBankText(K3), groceries)
		.run();
}

describe("1a. the bank texts are read again before the call", () => {
	it("a bank-text rule that arrives mid-run refuses the row before its call, and the next row is asked", async () => {
		expect(cleanBankText(K3)).not.toBe(cleanBankText(STORE_A));

		const r1 = await base();

		await foundStore(STORE_B);
		await guessRow(STORE_B, {
			date: "2026-11-14",
			plaid_transaction_id: "r2-1a",
		});

		const fake = fakeJev(() => categoryReply("Groceries", 0.95));

		await runSecond(fake.fetchImpl, {
			beforeAttempt: async (name) => {
				if (name === `lookup-second-row-${r1}`) await addAnnexRule();
			},
		});

		expect(callsFor(fake.bodies, STORE_A)).toBe(0);
		expect(await answerOf(r1)).toBeNull();
		expect(callsFor(fake.bodies, STORE_B) > 0).toBe(true);
		expect(fake.violations).toEqual([]);
	});
});

describe("1b. the bank texts are read again at the save", () => {
	it("a bank-text rule that arrives during R1's call refuses its answer, and no lookup_answers row is written", async () => {
		expect(cleanBankText(K3)).not.toBe(cleanBankText(STORE_A));

		const r1 = await base();

		await foundStore(STORE_B);
		await guessRow(STORE_B, {
			date: "2026-11-14",
			plaid_transaction_id: "r2-1b",
		});

		const fake = fakeJev(async (body) => {
			if (body.state.bank_description !== STORE_A)
				return categoryReply("Groceries", 0.9);

			await addAnnexRule();

			return categoryReply("Groceries", 0.95);
		});

		await runSecond(fake.fetchImpl);

		expect(await answerOf(r1)).toBeNull();
		expect(await guessOf(r1)).toMatchObject({
			confidence: 0.6,
			jevCategoryId: await categoryId("Eating Out"),
		});
		expect(callsFor(fake.bodies, STORE_B) > 0).toBe(true);
		expect(fake.violations).toEqual([]);
	});
});

describe("2. a row that waits for Jev yields the step", () => {
	it("yields before R2's call, writes nothing for R2, gives its call back, and the write still lands", async () => {
		const r1 = await base();

		await foundStore(STORE_B);

		const r2 = await guessRow(STORE_B, {
			date: "2026-11-14",
			plaid_transaction_id: "r2-2",
		});

		const fake = fakeJev(() => categoryReply("Groceries", 0.95));

		await runSecond(fake.fetchImpl, {
			beforeAttempt: async (name) => {
				if (name === `lookup-second-row-${r2}`) {
					await guessRow("Waiting Cafe", {
						plaid_transaction_id: "wait-2",
						category_confidence: null,
						jev_category_id: null,
					});
				}
			},
		});

		expect(callsFor(fake.bodies, STORE_A)).toBe(1);
		expect(callsFor(fake.bodies, STORE_B)).toBe(0);
		expect(await answerOf(r2)).toBeNull();
		expect(await answerOf(r1)).toMatchObject({ kept: 1 });
		expect(await dayCount()).toBe(1);
	});
});

describe("3. grants go to rows that make a call", () => {
	it("a row with no line takes no grant, so the next owed row is asked and the day's count rises by one", async () => {
		const cap = await dailyJevCap(db, gateOpen);

		const r1 = await base();

		await foundStore(STORE_B);

		const r2 = await guessRow(STORE_B, {
			date: "2026-11-14",
			plaid_transaction_id: "r2-3",
		});

		await db
			.prepare("INSERT INTO household_settings (key, value) VALUES (?, ?)")
			.bind(`jev_calls_${DAY}`, String(cap - 1))
			.run();

		const fake = fakeJev(() => categoryReply("Groceries", 0.95));

		await runSecond(fake.fetchImpl, {
			beforeAttempt: async (name) => {
				if (name === `lookup-second-row-${r1}`) {
					await db
						.prepare(
							"UPDATE merchant_lookups SET line = NULL WHERE lookup_text = 'harbor bakery'",
						)
						.run();
				}
			},
		});

		expect(callsFor(fake.bodies, STORE_A)).toBe(0);
		expect(callsFor(fake.bodies, STORE_B)).toBe(1);
		expect(await answerOf(r2)).toMatchObject({ kept: 1 });
		expect(await dayCount()).toBe(cap);
	});
});

// 15. Logging: nothing given to the console carries the text, the line, the raw name or a cleaned text.
describe("15. logging", () => {
	it("logs nothing that carries the text, the line, the raw name or a cleaned text", async () => {
		await base();

		const cleaned = cleanBankText(STORE_A);
		const logs: string[] = [];

		for (const method of ["log", "error", "warn", "info", "debug"] as const) {
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				logs.push(args.map(String).join(" "));
			});
		}

		const kept = fakeJev(() => categoryReply("Groceries", 0.95));
		await runSecond(kept.fetchImpl);

		await foundStore(STORE_B);
		await guessRow(STORE_B, {
			date: "2026-11-14",
			plaid_transaction_id: "log-2",
		});

		const failing = fakeJev(() => new Response("", { status: 500 }));
		await runSecond(failing.fetchImpl);

		const thrown = fakeJev(() => {
			throw new Error("network");
		});

		await runSecond(thrown.fetchImpl);

		const joined = logs.join("\n");

		expect(joined).not.toContain(LINE);
		expect(joined).not.toContain(STORE_A);
		expect(joined).not.toContain(STORE_B);
		expect(joined).not.toContain(cleaned);
		expect(joined).not.toContain("harbor bakery");
	});
});

// A save-time guard cannot undo sending a note that a person removed before the call.
describe("the planned row is revalidated immediately before its call", () => {
	it.each([
		["note removed", "UPDATE transactions SET note = NULL WHERE id = ?"],
		["note edited", "UPDATE transactions SET note = 'New note' WHERE id = ?"],
		["pending", "UPDATE transactions SET pending = 1 WHERE id = ?"],
		["split", "UPDATE transactions SET is_split = 1 WHERE id = ?"],
		[
			"bill filed",
			"UPDATE transactions SET category_id = jev_category_id, category_source = 'bill' WHERE id = ?",
		],
		[
			"guess changed",
			"UPDATE transactions SET category_confidence = 0.7 WHERE id = ?",
		],
		["deleted", "DELETE FROM transactions WHERE id = ?"],
	] as const)(
		"%s: no stale data leaves, no call is spent or recorded",
		async (_name, sql) => {
			await foundStore(STORE_A);
			const id = await guessRow(STORE_A, { note: "Private note" });
			const fake = fakeJev(() => categoryReply("Groceries", 0.95));
			await runSecond(fake.fetchImpl, {
				beforeAttempt: async (step) => {
					if (step === `lookup-second-row-${id}`)
						await db.prepare(sql).bind(id).run();
				},
			});
			expect(fake.bodies).toHaveLength(0);
			expect(await answerOf(id)).toBeNull();
			expect(await dayCount()).toBe(0);
		},
	);
});

describe("a reused transaction id is not the transaction Jev was asked about", () => {
	it.each(["answered", "failed", "lost"] as const)(
		"%s never marks a replacement as asked",
		async (outcome) => {
			const id = await base();
			let replacement = 0;

			const replace = async () => {
				await db
					.prepare("DELETE FROM transactions WHERE id = ?")
					.bind(id)
					.run();
				replacement = await guessRow(STORE_A, {
					plaid_transaction_id: "replacement-bank-row",
				});
				expect(replacement).toBe(id);
			};

			const fake = fakeJev(async () => {
				await replace();

				return outcome === "failed"
					? new Response("", { status: 500 })
					: categoryReply("Groceries", 0.95);
			});

			await runSecond(fake.fetchImpl, {
				beforeAttempt: async (step) => {
					if (outcome === "lost" && step === `lookup-second-row-${id}`) {
						await replace();
						throw new Error("lost ask step");
					}
				},
			});
			expect(replacement).toBe(id);
			expect(await answerOf(replacement)).toBeNull();
			expect((await guessOf(replacement))?.confidence).toBe(0.6);
		},
	);
});

/** Inject a concurrent change at the final pre-call read, not in the earlier store read. */
function beforeFinalRead(change: () => Promise<void>) {
	const prepare = db.prepare.bind(db);
	let injected = false;
	vi.spyOn(db, "prepare").mockImplementation((sql) => {
		const statement = prepare(sql);

		if (
			!(
				sql.startsWith("SELECT") ||
				sql.startsWith("INSERT INTO lookup_second_claims")
			) ||
			!sql.includes("transactions.id = ?")
		)
			return statement;
		const bind = statement.bind.bind(statement);
		vi.spyOn(statement, "bind").mockImplementation((...values) => {
			const bound = bind(...values);
			const first = bound.first.bind(bound);
			vi.spyOn(bound, "first").mockImplementation(
				async <T>(column?: string): Promise<T | null> => {
					if (!injected) {
						injected = true;
						await change();
					}

					return column === undefined ? first<T>() : first<T>(column);
				},
			);

			return bound;
		});

		return statement;
	});
}

describe("the final pre-call read keeps store and transaction guards together", () => {
	it.each([
		[
			"private store",
			"UPDATE merchant_lookup_texts SET private = 1 WHERE lookup_text = 'harbor bakery'",
		],
		[
			"disabled lookup",
			"UPDATE household_settings SET value = 'off' WHERE key = 'ai_lookup_stores'",
		],
		[
			"household answer",
			"INSERT INTO merchants (raw_name, default_category_id) SELECT 'Harbor Bakery 42', id FROM categories WHERE name = 'Groceries'",
		],
	] as const)(
		"%s at the final read prevents transmission",
		async (_name, sql) => {
			const id = await base();
			const fake = fakeJev(() => categoryReply("Groceries", 0.95));
			await runSecond(fake.fetchImpl, {
				beforeAttempt: async (step) => {
					if (step === `lookup-second-row-${id}`)
						beforeFinalRead(async () => {
							await db.prepare(sql).run();
						});
				},
			});
			expect(fake.bodies).toHaveLength(0);
			expect(await answerOf(id)).toBeNull();
			expect(await dayCount()).toBe(0);
		},
	);
});

describe("known preflight failures are not lost transmissions", () => {
	it.each(["first prepare", "final query"])(
		"%s failure spends no call and records no answer",
		async (where) => {
			const id = await base();
			const fake = fakeJev(() => categoryReply("Groceries", 0.95));
			await runSecond(fake.fetchImpl, {
				beforeAttempt: async (step) => {
					if (step !== `lookup-second-row-${id}`) return;

					if (where === "first prepare")
						vi.spyOn(db, "prepare").mockImplementationOnce(() => {
							throw new Error("D1 unavailable");
						});
					else
						beforeFinalRead(async () => {
							throw new Error("D1 unavailable");
						});
				},
			});
			expect(fake.bodies).toHaveLength(0);
			expect(await answerOf(id)).toBeNull();
			expect(await dayCount()).toBe(0);
		},
	);
});

// These changes land after the separate preflight queries, in the final database snapshot.
describe("final-snapshot concurrency guards", () => {
	it.each(["mapping", "sibling", "queue", "day", "budget"] as const)(
		"refuses a concurrent %s change without transmission or charge",
		async (change) => {
			const id = await base();
			const fake = fakeJev(() => categoryReply("Groceries", 0.95));
			await runSecond(fake.fetchImpl, {
				beforeAttempt: async (step) => {
					if (step !== `lookup-second-row-${id}`) return;
					beforeFinalRead(async () => {
						if (change === "mapping") {
							await db
								.prepare(
									"UPDATE merchant_lookup_texts SET lookup_text = 'private replacement', private = 1 WHERE merchant_key = ?",
								)
								.bind(STORE_A)
								.run();
						} else if (change === "sibling") {
							await addSibling();
							await db
								.prepare(
									"INSERT INTO merchant_lookup_texts (merchant_key, lookup_text, private) VALUES (?, 'harbor bakery', 0)",
								)
								.bind(SIDE_RAW)
								.run();
						} else if (change === "queue") {
							await guessRow(STORE_B, {
								category_confidence: null,
								jev_category_id: null,
								plaid_transaction_id: "new-waiting",
							});
						} else {
							vi.setSystemTime(
								NOON_MS +
									(change === "day" ? 24 * 60 * MINUTE : ASK_BUDGET_MS + 1),
							);
						}
					});
				},
			});
			expect(fake.bodies).toHaveLength(0);
			expect(await answerOf(id)).toBeNull();
			expect(await dayCount()).toBe(0);
			expect(
				await db
					.prepare(
						"SELECT transaction_id FROM lookup_second_claims WHERE transaction_id = ?",
					)
					.bind(id)
					.first(),
			).toBeNull();

			if (change === "day" || change === "budget") {
				await runSecond(fake.fetchImpl, { runId: "new-day-run" });
				expect(fake.bodies).toHaveLength(1);
			}
		},
	);
});

describe("durable second-ask claims", () => {
	it("does not repeat a transmitted row after the sorting lease expires before save", async () => {
		const id = await base();
		const fake = fakeJev(() => categoryReply("Groceries", 0.95));
		await runSecond(fake.fetchImpl, {
			beforeAttempt: async (step) => {
				if (step === "lookup-second-write") throw new Error("save unavailable");
			},
		});
		expect(fake.bodies).toHaveLength(1);
		expect(await answerOf(id)).toBeNull();
		vi.setSystemTime(NOON_MS + 16 * MINUTE);
		await runSecond(fake.fetchImpl, { runId: "later-second-run" });
		expect(fake.bodies).toHaveLength(1);
	});
});

describe("dispatch claim lifecycle", () => {
	it("allows only one concurrent dispatch of the same planned row", async () => {
		await base();

		const plan = await readSecondAsk(gateOpen, {
			turnId: "concurrent",
			bySync: false,
		});

		if (!plan?.rows[0]) throw new Error("missing positive-control plan");
		const row = plan.rows[0];
		const fake = fakeJev(() => categoryReply("Groceries", 0.95));

		const outcomes = await Promise.all(
			[1, 2].map(() =>
				askSecondRow("jev", db, plan, row, fake.fetchImpl, {
					attempt: 1,
				}),
			),
		);

		expect(fake.bodies).toHaveLength(1);
		expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual([
			"answered",
			"no-line",
		]);
	});

	it("retains a claim when the database committed but its reply was lost", async () => {
		const id = await base();
		const fake = fakeJev(() => categoryReply("Groceries", 0.95));
		const prepare = db.prepare.bind(db);
		let injected = false;
		vi.spyOn(db, "prepare").mockImplementation((sql) => {
			const statement = prepare(sql);

			if (!sql.startsWith("INSERT INTO lookup_second_claims")) return statement;
			const bind = statement.bind.bind(statement);
			vi.spyOn(statement, "bind").mockImplementation((...values) => {
				const bound = bind(...values);
				const first = bound.first.bind(bound);
				vi.spyOn(bound, "first").mockImplementation(
					async <T>(): Promise<T | null> => {
						const result = await first<T>();

						if (!injected) {
							injected = true;
							throw new Error("committed reply lost");
						}

						return result;
					},
				);

				return bound;
			});

			return statement;
		});
		await runSecond(fake.fetchImpl);
		await runSecond(fake.fetchImpl, { runId: "after-crash" });
		expect(fake.bodies).toHaveLength(0);
		expect(await answerOf(id)).toBeNull();
		expect(
			await db
				.prepare(
					"SELECT transaction_id FROM lookup_second_claims WHERE transaction_id = ?",
				)
				.bind(id)
				.first(),
		).not.toBeNull();
		await db.prepare("DELETE FROM transactions WHERE id = ?").bind(id).run();
		expect(
			await db
				.prepare(
					"SELECT transaction_id FROM lookup_second_claims WHERE transaction_id = ?",
				)
				.bind(id)
				.first(),
		).toBeNull();
	});

	it("refuses a successful answer after its live mapping moves", async () => {
		const id = await base();

		const fake = fakeJev(async () => {
			await db
				.prepare(
					"UPDATE merchant_lookup_texts SET lookup_text = 'private replacement', private = 1 WHERE merchant_key = ?",
				)
				.bind(STORE_A)
				.run();

			return categoryReply("Groceries", 0.95);
		});

		await runSecond(fake.fetchImpl);
		expect(fake.bodies).toHaveLength(1);
		expect(await answerOf(id)).toBeNull();
		expect((await guessOf(id))?.confidence).toBe(0.6);
	});
});

describe("learned-line source races across lookup texts", () => {
	it.each(["dispatch", "save"] as const)(
		"refuses a new cross-text learned line at %s",
		async (boundary) => {
			const id = await base();
			await foundStore("Other Store");
			const fake = fakeJev(() => categoryReply("Groceries", 0.95));
			let injected = false;

			const change = async () => {
				injected = true;
				await guessRow(STORE_A, {
					plaid_transaction_id: "late-cross-text-answer",
					merchant_name: "Other Store",
					category_id: await categoryId("Groceries"),
					category_source: "user",
				});
			};

			await runSecond(fake.fetchImpl, {
				beforeAttempt: async (step) => {
					if (boundary === "dispatch" && step === `lookup-second-row-${id}`)
						beforeFinalRead(change);

					if (boundary === "save" && step === "lookup-second-write") {
						const batch = db.batch.bind(db);
						vi.spyOn(db, "batch").mockImplementation(async (statements) => {
							if (!injected) await change();

							return batch(statements);
						});
					}
				},
			});
			expect(injected).toBe(true);
			expect(fake.bodies).toHaveLength(boundary === "dispatch" ? 0 : 1);
			expect(await answerOf(id)).toBeNull();
			expect((await guessOf(id))?.confidence).toBe(0.6);
			expect(await dayCount()).toBe(boundary === "dispatch" ? 0 : 1);
		},
	);

	it.each(["dispatch", "save"] as const)(
		"refuses a cross-text learned line restored by Undo Forget at %s",
		async (boundary) => {
			const id = await base();
			await foundStore("Other Store");
			await guessRow(STORE_A, {
				plaid_transaction_id: "forgotten-cross-text-answer",
				merchant_name: "Other Store",
				category_id: await categoryId("Groceries"),
				category_source: "user",
			});
			await db
				.prepare(
					"INSERT INTO forgotten_texts (cleaned_text, forgotten_at) VALUES (?, '2099-01-01 00:00:00')",
				)
				.bind(cleanBankText(STORE_A))
				.run();
			const fake = fakeJev(() => categoryReply("Groceries", 0.95));
			let injected = false;

			const change = async () => {
				injected = true;
				await db
					.prepare("DELETE FROM forgotten_texts WHERE cleaned_text = ?")
					.bind(cleanBankText(STORE_A))
					.run();
			};

			await runSecond(fake.fetchImpl, {
				beforeAttempt: async (step) => {
					if (boundary === "dispatch" && step === `lookup-second-row-${id}`)
						beforeFinalRead(change);

					if (boundary === "save" && step === "lookup-second-write") {
						const batch = db.batch.bind(db);
						vi.spyOn(db, "batch").mockImplementation(async (statements) => {
							if (!injected) await change();

							return batch(statements);
						});
					}
				},
			});
			expect(injected).toBe(true);
			expect(fake.bodies).toHaveLength(boundary === "dispatch" ? 0 : 1);
			expect(await answerOf(id)).toBeNull();
			expect((await guessOf(id))?.confidence).toBe(0.6);
			expect(await dayCount()).toBe(boundary === "dispatch" ? 0 : 1);
		},
	);
});

describe("bounded learned-line dispatch evidence", () => {
	it("makes no call when a synthetic answer expands the source snapshot beyond its bound", async () => {
		const id = await base();
		const fake = fakeJev(() => categoryReply("Groceries", 0.95));
		await runSecond(fake.fetchImpl, {
			beforeAttempt: async (step) => {
				if (step !== `lookup-second-row-${id}`) return;

				await guessRow(`synthetic oversized ${"x".repeat(600_000)}`, {
					plaid_transaction_id: "oversized-learned-source",
					merchant_name: "Other Store",
					category_id: await categoryId("Groceries"),
					category_source: "user",
				});
			},
		});
		expect(fake.bodies).toHaveLength(0);
		expect(await answerOf(id)).toBeNull();
		expect((await guessOf(id))?.confidence).toBe(0.6);
		expect(await dayCount()).toBe(0);
	});
});

describe("learned-line save evidence failures", () => {
	it("settles the paid call without saving a guess when the source snapshot read fails", async () => {
		const id = await base();
		const fake = fakeJev(() => categoryReply("Groceries", 0.95));
		let injected = false;
		await runSecond(fake.fetchImpl, {
			beforeAttempt: async (step) => {
				if (step !== "lookup-second-write") return;

				const prepare = db.prepare.bind(db);
				vi.spyOn(db, "prepare").mockImplementation((sql) => {
					const statement = prepare(sql);

					if (
						sql.startsWith("SELECT") &&
						sql.endsWith(" AS source") &&
						!injected
					) {
						vi.spyOn(statement, "first").mockImplementationOnce(async () => {
							injected = true;
							throw new Error("snapshot read unavailable");
						});
					}

					return statement;
				});
			},
		});
		expect(injected).toBe(true);
		expect(fake.bodies).toHaveLength(1);
		expect(await answerOf(id)).toBeNull();
		expect((await guessOf(id))?.confidence).toBe(0.6);
		expect(await dayCount()).toBe(1);

		const left = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM household_settings WHERE key = 'sorting_turn' OR key GLOB 'jev_reserved_*'",
			)
			.first<{ n: number }>();

		expect(left?.n).toBe(0);
	});
});

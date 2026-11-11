import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Decision } from "../src/ai/decide";
import { summarizeMonth } from "../src/budget";
import { categorizePending } from "../src/categorize-pending";
import { householdToday } from "../src/dates";
import { readAiTally } from "../src/db/ai-log";
import {
	AI_SWITCHES_ALL_ON,
	type AiSwitches,
	saveAiSwitches,
} from "../src/db/ai-switches";
import { reserveJevCalls } from "../src/db/jev-calls";
import { forgetText, loadLearnedLines } from "../src/db/learned-lines";
import { loadMonth } from "../src/db/month";
import {
	monthCounts,
	needsCategoryCount,
	pendingForJev,
	saveJevResult,
} from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { jevCallLimit } from "../src/sort-groups";
import { seedMerchant } from "./helpers/merchants";

const db = env.DB;
const TODAY = "2026-09-22";
const MONTH = "2026-09";

/** A Jev reply: Eating Out at the given confidence, no flags. */
const reply = (confidence: number) =>
	new Response(
		JSON.stringify({
			answers: {
				category: { type: "choice", choice: "Eating Out", confidence },
				transfer: { type: "noul", noul: 0.01 },
				reimbursement: { type: "noul", noul: 0.01 },
				income: { type: "noul", noul: 0.01 },
			},
		}),
		{ status: 200 },
	);

/** A fake Jev answering each call in turn; later calls reuse the last answer. */
function fakeJev(...responses: (() => Response)[]) {
	let calls = 0;

	const fetchImpl = async () => {
		const respond = responses[Math.min(calls, responses.length - 1)];
		calls += 1;

		return (respond as () => Response)();
	};

	return { fetchImpl, calls: () => calls };
}

const withKey = { DB: db, JEV_API_KEY: "test-key" };

type SentRequest = { state: Record<string, unknown> };

const countWhere = async (where: string) =>
	(
		await db
			.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${where}`)
			.first<{ n: number }>()
	)?.n ?? 0;

/** Spent in a month, as Home shows it (spec §6): the counted transactions, uncategorized ones included. */
const spentIn = async (month: string) =>
	summarizeMonth({
		month,
		...(await loadMonth(db, month)),
		unpaidDueBillsCents: 0,
	}).totalSpentCents;

/** The household's next day: yesterday's Jev count no longer applies. */
const newDay = () =>
	db
		.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'")
		.run();

/** How many of the household day's calls are spoken for (spec §8.6); 40 is the demo's cap. */
const callsUsed = async (day?: string) =>
	Number(
		(
			await db
				.prepare("SELECT value FROM household_settings WHERE key = ?")
				.bind(`jev_calls_${day ?? (await householdToday(db))}`)
				.first<{ value: string }>()
		)?.value ?? 0,
	);

const switchTo = (over: Partial<typeof AI_SWITCHES_ALL_ON>) =>
	saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, details: false, ...over });

/**
 * The database as a run sees it, where a Settings save lands while the first answer is being saved: the
 * answer's own batch completes first, so it is saved under the switches as they were, and then `off` is
 * saved, before the run reads the switches again for its next call.
 */
function saveDuringFirstAnswer(
	off: Partial<AiSwitches>,
	jev: { calls: () => number },
): D1Database {
	let saved = false;

	return new Proxy(db, {
		get(target, property) {
			const value = Reflect.get(target, property);

			if (property === "batch")
				return async (statements: D1PreparedStatement[]) => {
					const results = await target.batch(statements);

					if (!saved && jev.calls() >= 1) {
						saved = true;
						await saveAiSwitches(target, off);
					}

					return results;
				};

			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as D1Database;
}

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await saveAiSwitches(db, { details: false });
	// The demo's reset keeps the day's Jev count, so each test starts a day of its own.
	await newDay();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("categorizePending", () => {
	it("leaves an unasked category eligible when the household has no active categories", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await db.prepare("UPDATE categories SET archived=1").run();
		await switchTo({ categories: true, income: true });

		// A credit: with no active categories it is asked for its income answer (an outgoing purchase is asked once for its transfer flag, below).
		const id = Number(
			(
				await db
					.prepare(
						"INSERT INTO transactions(account_id,date,amount_cents,raw_name) VALUES(1,?,-500,'NO ACTIVE CATEGORIES') RETURNING id",
					)
					.bind(`${MONTH}-20`)
					.first<{ id: number }>()
			)?.id,
		);

		// Only the transfer, reimbursement and income answers come back: no category question was asked.
		expect(
			await categorizePending(
				withKey,
				async () =>
					Response.json({
						answers: {
							transfer: { noul: 0.01 },
							reimbursement: { noul: 0.01 },
							income: { noul: 0.01 },
						},
					}),
				{ rulesApplied: true, onlyIds: [id] },
			),
		).toEqual({ asked: 1, applied: 0 });
		expect(
			await db
				.prepare(
					"SELECT category_confidence, jev_category_id, jev_none_fit, excluded, transfer_confidence, income_confidence FROM transactions WHERE id=?",
				)
				.bind(id)
				.first(),
		).toEqual({
			category_confidence: null,
			jev_category_id: null,
			jev_none_fit: 0,
			excluded: 0,
			transfer_confidence: 0.01,
			income_confidence: 0.01,
		});
		await db.prepare("UPDATE categories SET archived=0").run();
		await switchTo({ categories: true, income: true });
		expect((await pendingForJev(db, 50)).some((row) => row.id === id)).toBe(
			true,
		);
	});

	it("asks about an outgoing purchase once for its transfer flag when no categories are active, credits first, and keeps the payment out of Spent", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await db.prepare("UPDATE categories SET archived=1").run();
		await switchTo({ categories: true, income: true });
		// The demo's pending rows have a category answer, so only the rows this test adds are asked about.
		await db.prepare("UPDATE transactions SET category_confidence = 0.5").run();

		for (const [date, amount, rawName] of [
			[`${MONTH}-21`, 50000, "CARD PAYMENT"],
			[`${MONTH}-20`, 700, "NEWER PURCHASE"],
			[`${MONTH}-05`, -2000, "OLDER CREDIT"],
		] as const)
			await db
				.prepare(
					"INSERT INTO transactions(account_id,date,amount_cents,raw_name,plaid_category,excluded) VALUES(1,?,?,?,NULL,0)",
				)
				.bind(date, amount, rawName)
				.run();
		const sent: string[] = [];

		const fetchImpl = async (_url: string, init?: RequestInit) => {
			const body = String(init?.body);
			sent.push(body);

			return Response.json({
				answers: {
					transfer: { noul: body.includes("CARD PAYMENT") ? 0.99 : 0.01 },
					reimbursement: { noul: 0.01 },
					income: { noul: 0.01 },
				},
			});
		};

		const spentBefore = await spentIn(MONTH);

		// Night one asks each of the three once, and the credit first.
		expect(
			await categorizePending(withKey, fetchImpl, {
				rulesApplied: true,
				maxCalls: 10,
			}),
		).toEqual({ asked: 3, applied: 0 });
		expect(sent).toHaveLength(3);
		expect(sent[0]).toContain("OLDER CREDIT");

		for (const rawName of ["CARD PAYMENT", "NEWER PURCHASE", "OLDER CREDIT"])
			expect(sent.filter((body) => body.includes(rawName))).toHaveLength(1);
		expect(
			await db
				.prepare(
					"SELECT flag_transfer, excluded, excluded_source FROM transactions WHERE raw_name = 'CARD PAYMENT'",
				)
				.first(),
		).toEqual({ flag_transfer: 1, excluded: 1, excluded_source: "jev" });
		expect(
			await db
				.prepare(
					"SELECT transfer_confidence, excluded, category_confidence FROM transactions WHERE raw_name = 'NEWER PURCHASE'",
				)
				.first(),
		).toEqual({
			transfer_confidence: 0.01,
			excluded: 0,
			category_confidence: null,
		});
		expect(
			await db
				.prepare(
					"SELECT income_confidence FROM transactions WHERE raw_name = 'OLDER CREDIT'",
				)
				.first(),
		).toEqual({ income_confidence: 0.01 });
		expect(await spentIn(MONTH)).toBe(spentBefore - 50000);

		// Night two has nothing left to ask: every answer is kept.
		sent.length = 0;
		expect(
			await categorizePending(withKey, fetchImpl, {
				rulesApplied: true,
				maxCalls: 10,
			}),
		).toEqual({ asked: 0, applied: 0 });
		expect(sent).toEqual([]);

		// Once a category is active, the purchase is pending for its category; the excluded payment is not.
		await db.prepare("UPDATE categories SET archived=0").run();

		const pending = (await pendingForJev(db, 10, { categoryAsked: true })).map(
			(row) => row.rawName,
		);

		expect(pending).toContain("NEWER PURCHASE");
		expect(pending).toContain("OLDER CREDIT");
		expect(pending).not.toContain("CARD PAYMENT");
	});

	it("asks about an older credit first, then the newest purchases two a night, when the household has no active categories, and never asks about a row twice", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await db.prepare("UPDATE categories SET archived=1").run();
		await switchTo({ categories: true, income: true });
		await db.prepare("UPDATE transactions SET category_confidence = 0.5").run();

		for (const [date, amount, rawName] of [
			[`${MONTH}-21`, 500, "NEWER PURCHASE A"],
			[`${MONTH}-20`, 700, "NEWER PURCHASE B"],
			[`${MONTH}-19`, 900, "NEWER PURCHASE C"],
			[`${MONTH}-05`, -2000, "OLDER CREDIT"],
		] as const)
			await db
				.prepare(
					"INSERT INTO transactions(account_id,date,amount_cents,raw_name) VALUES(1,?,?,?)",
				)
				.bind(date, amount, rawName)
				.run();
		const sent: string[] = [];

		const fetchImpl = async (_url: string, init?: RequestInit) => {
			sent.push(String(init?.body));

			return Response.json({
				answers: {
					transfer: { noul: 0.01 },
					reimbursement: { noul: 0.01 },
					income: { noul: 0.99 },
				},
			});
		};

		// Two calls a night: the credit comes first, then the newest purchase, then the next two purchases.
		expect(
			await categorizePending(withKey, fetchImpl, {
				rulesApplied: true,
				maxCalls: 2,
			}),
		).toEqual({ asked: 2, applied: 0 });
		expect(sent[0]).toContain("OLDER CREDIT");
		expect(sent[1]).toContain("NEWER PURCHASE A");

		expect(
			await categorizePending(withKey, fetchImpl, {
				rulesApplied: true,
				maxCalls: 2,
			}),
		).toEqual({ asked: 2, applied: 0 });
		expect(sent[2]).toContain("NEWER PURCHASE B");
		expect(sent[3]).toContain("NEWER PURCHASE C");

		// Every answer is kept, so nothing is asked again and no raw name is sent twice.
		expect(
			await categorizePending(withKey, fetchImpl, {
				rulesApplied: true,
				maxCalls: 2,
			}),
		).toEqual({ asked: 0, applied: 0 });
		expect(sent).toHaveLength(4);
		expect(new Set(sent).size).toBe(4);
	});

	it("asks each credit once, even one Jev answers as not income, before any purchase when no categories are active, and never asks about a zero amount", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await db.prepare("UPDATE categories SET archived=1").run();
		await switchTo({ categories: true, income: true });
		await db.prepare("UPDATE transactions SET category_confidence = 0.5").run();

		for (const [date, amount, rawName] of [
			[`${MONTH}-22`, 0, "ZERO AMOUNT"],
			[`${MONTH}-21`, 500, "NEWER PURCHASE"],
			[`${MONTH}-20`, -1500, "NEWER CREDIT"],
			[`${MONTH}-05`, -2000, "OLDER CREDIT"],
		] as const)
			await db
				.prepare(
					"INSERT INTO transactions(account_id,date,amount_cents,raw_name) VALUES(1,?,?,?)",
				)
				.bind(date, amount, rawName)
				.run();
		const sent: string[] = [];

		// The newer credit is not income (a low answer); the older one is (flag_income drops it from the queue).
		const fetchImpl = async (_url: string, init?: RequestInit) => {
			const body = String(init?.body);
			sent.push(body);

			return Response.json({
				answers: {
					transfer: { noul: 0.01 },
					reimbursement: { noul: 0.01 },
					income: { noul: body.includes("NEWER CREDIT") ? 0.01 : 0.99 },
				},
			});
		};

		// One call a run: a credit answered as not income must not keep the run on it night after night.
		expect(
			await categorizePending(withKey, fetchImpl, {
				rulesApplied: true,
				maxCalls: 1,
			}),
		).toEqual({ asked: 1, applied: 0 });
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("NEWER CREDIT");

		expect(
			await categorizePending(withKey, fetchImpl, {
				rulesApplied: true,
				maxCalls: 1,
			}),
		).toEqual({ asked: 1, applied: 0 });
		expect(sent).toHaveLength(2);
		expect(sent[1]).toContain("OLDER CREDIT");

		// The purchase comes after both credits, and its transfer answer is kept, so the next night has nothing.
		expect(
			await categorizePending(withKey, fetchImpl, {
				rulesApplied: true,
				maxCalls: 1,
			}),
		).toEqual({ asked: 1, applied: 0 });
		expect(sent).toHaveLength(3);
		expect(sent[2]).toContain("NEWER PURCHASE");

		expect(
			await categorizePending(withKey, fetchImpl, {
				rulesApplied: true,
				maxCalls: 1,
			}),
		).toEqual({ asked: 0, applied: 0 });
		expect(sent).toHaveLength(3);
		expect(sent.join("\n")).not.toContain("ZERO AMOUNT");
	});

	it("doesn't ask about an outgoing purchase with no active categories while the categories switch is off, since its flags would be dropped", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await db.prepare("UPDATE categories SET archived=1").run();
		await switchTo({ categories: false, income: true });
		await db.prepare("UPDATE transactions SET category_confidence = 0.5").run();

		for (const [date, amount, rawName] of [
			[`${MONTH}-21`, 700, "OUTGOING PURCHASE"],
			[`${MONTH}-05`, -2000, "OLDER CREDIT"],
		] as const)
			await db
				.prepare(
					"INSERT INTO transactions(account_id,date,amount_cents,raw_name) VALUES(1,?,?,?)",
				)
				.bind(date, amount, rawName)
				.run();
		const sent: string[] = [];

		const fetchImpl = async (_url: string, init?: RequestInit) => {
			sent.push(String(init?.body));

			return Response.json({
				answers: {
					transfer: { noul: 0.01 },
					reimbursement: { noul: 0.01 },
					income: { noul: 0.01 },
				},
			});
		};

		// Only the credit is asked; the purchase is never sent, so it isn't sent again the next night either.
		expect(
			await categorizePending(withKey, fetchImpl, {
				rulesApplied: true,
				maxCalls: 10,
			}),
		).toEqual({ asked: 1, applied: 0 });
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("OLDER CREDIT");
		expect(
			await categorizePending(withKey, fetchImpl, {
				rulesApplied: true,
				maxCalls: 10,
			}),
		).toEqual({ asked: 0, applied: 0 });
		expect(sent).toHaveLength(1);
	});

	it("doesn't ask about an outgoing purchase a person put back into the budget while no category is active, since nothing would mark it asked", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await db.prepare("UPDATE categories SET archived=1").run();
		await switchTo({ categories: true, income: true });
		await db.prepare("UPDATE transactions SET category_confidence = 0.5").run();
		await db
			.prepare(
				"INSERT INTO transactions(account_id,date,amount_cents,raw_name,plaid_category,excluded,excluded_source) VALUES(1,?,700,'PUT BACK',NULL,0,'user')",
			)
			.bind(`${MONTH}-21`)
			.run();
		const jev = fakeJev(() => reply(0.95));
		expect(
			await categorizePending(withKey, jev.fetchImpl, { rulesApplied: true }),
		).toEqual({ asked: 0, applied: 0 });
		expect(jev.calls()).toBe(0);
		expect(
			await countWhere(
				"raw_name = 'PUT BACK' AND excluded = 0 AND transfer_confidence IS NULL",
			),
		).toBe(1);
	});

	it("asks about an outgoing purchase in the details call with no active categories, keeps its transfer answer, and doesn't ask again", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await db.prepare("UPDATE categories SET archived=1").run();
		await switchTo({ categories: true, income: false, details: true });
		// The demo's pending rows are set aside, so the purchase below is the only one this run can ask about.
		await db
			.prepare(
				"UPDATE transactions SET category_confidence = 0.5, details_asked = 1",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO transactions(account_id,date,amount_cents,raw_name,plaid_category,excluded) VALUES(1,?,50000,'CARD PAYMENT',NULL,0)",
			)
			.bind(`${MONTH}-21`)
			.run();
		const sent: string[] = [];

		const fetchImpl = async (_url: string, init?: RequestInit) => {
			sent.push(String(init?.body));

			return Response.json({
				answers: {
					transfer: { noul: 0.99 },
					reimbursement: { noul: 0.01 },
					income: { noul: 0.01 },
					kind: { type: "choice", choice: "one_off", confidence: 0.9 },
					for_person: { type: "choice", choice: "none", confidence: 0.9 },
					note_worth_writing: { noul: 0.01 },
				},
			});
		};

		expect(
			await categorizePending(withKey, fetchImpl, { rulesApplied: true }),
		).toEqual({ asked: 1, applied: 0 });
		expect(sent).toHaveLength(1);
		expect(
			await db
				.prepare(
					"SELECT flag_transfer, excluded, excluded_source FROM transactions WHERE raw_name = 'CARD PAYMENT'",
				)
				.first(),
		).toEqual({ flag_transfer: 1, excluded: 1, excluded_source: "jev" });
		expect(
			await categorizePending(withKey, fetchImpl, { rulesApplied: true }),
		).toEqual({ asked: 0, applied: 0 });
		expect(sent).toHaveLength(1);
	});

	it("asks about an outgoing purchase whose details were asked before, with categories on, income off and no active category, and never about a credit", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await db.prepare("UPDATE categories SET archived=1").run();
		await switchTo({ categories: true, income: false, details: true });
		// The demo's pending rows are set aside, so only the two rows this test adds can be asked about.
		await db
			.prepare(
				"UPDATE transactions SET category_confidence = 0.5, details_asked = 1",
			)
			.run();

		for (const [date, amount, rawName] of [
			[`${MONTH}-21`, 700, "DETAILS ASKED PURCHASE"],
			[`${MONTH}-05`, -2000, "OLDER CREDIT"],
		] as const)
			await db
				.prepare(
					"INSERT INTO transactions(account_id,date,amount_cents,raw_name,plaid_category,excluded,details_asked) VALUES(1,?,?,?,NULL,0,1)",
				)
				.bind(date, amount, rawName)
				.run();
		const sent: string[] = [];

		const fetchImpl = async (_url: string, init?: RequestInit) => {
			sent.push(String(init?.body));

			return Response.json({
				answers: {
					transfer: { noul: 0.99 },
					reimbursement: { noul: 0.01 },
					income: { noul: 0.01 },
				},
			});
		};

		// Only the purchase is asked: the income switch is off, so the credit is never sent.
		expect(
			await categorizePending(withKey, fetchImpl, { rulesApplied: true }),
		).toEqual({ asked: 1, applied: 0 });
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("DETAILS ASKED PURCHASE");
		expect(
			await db
				.prepare(
					"SELECT flag_transfer, excluded, excluded_source FROM transactions WHERE raw_name = 'DETAILS ASKED PURCHASE'",
				)
				.first(),
		).toEqual({ flag_transfer: 1, excluded: 1, excluded_source: "jev" });
		expect(
			await categorizePending(withKey, fetchImpl, { rulesApplied: true }),
		).toEqual({ asked: 0, applied: 0 });
		expect(sent).toHaveLength(1);
	});

	it("asks a card payment once for its transfer flag with only Guess categories on and no active category, and takes it out of Spent", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await db.prepare("UPDATE categories SET archived=1").run();
		// Only Guess categories is on: the transfer and reimbursement answers are the only ones asked about.
		await switchTo({ categories: true, income: false });
		// The demo's pending rows have a category answer, so only the rows this test adds are asked about.
		await db.prepare("UPDATE transactions SET category_confidence = 0.5").run();

		for (const [date, amount, rawName] of [
			[`${MONTH}-21`, 50000, "CARD PAYMENT"],
			[`${MONTH}-05`, -2000, "OLDER CREDIT"],
		] as const)
			await db
				.prepare(
					"INSERT INTO transactions(account_id,date,amount_cents,raw_name,plaid_category,excluded) VALUES(1,?,?,?,NULL,0)",
				)
				.bind(date, amount, rawName)
				.run();
		const sent: string[] = [];

		const fetchImpl = async (_url: string, init?: RequestInit) => {
			sent.push(String(init?.body));

			return Response.json({
				answers: {
					transfer: { noul: 0.99 },
					reimbursement: { noul: 0.01 },
					income: { noul: 0.01 },
				},
			});
		};

		const spentBefore = await spentIn(MONTH);

		// Night one asks only the purchase: the income switch is off, so the credit is never sent.
		expect(
			await categorizePending(withKey, fetchImpl, { rulesApplied: true }),
		).toEqual({ asked: 1, applied: 0 });
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("CARD PAYMENT");
		expect(
			await db
				.prepare(
					"SELECT flag_transfer, excluded, excluded_source, category_confidence FROM transactions WHERE raw_name = 'CARD PAYMENT'",
				)
				.first(),
		).toEqual({
			flag_transfer: 1,
			excluded: 1,
			excluded_source: "jev",
			category_confidence: null,
		});
		expect(await spentIn(MONTH)).toBe(spentBefore - 50000);

		// Night two has nothing left to ask.
		expect(
			await categorizePending(withKey, fetchImpl, { rulesApplied: true }),
		).toEqual({ asked: 0, applied: 0 });
		expect(sent).toHaveLength(1);
	});

	describe("Jev is sent only the learned line that applies (decisions 156 and 162)", () => {
		beforeEach(async () => {
			await switchTo({ categories: true, income: true });
		});

		/** An answer a person (or a merchant rule) gave earlier. Its updated_at is old unless a test says otherwise. */
		const answer = (
			rawName: string,
			categoryName: string,
			day: number,
			source = "user",
			updatedAt = "2020-01-01 00:00:00",
		) =>
			db
				.prepare(
					`INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source, updated_at)
					VALUES (1, ?, 100, ?, (SELECT id FROM categories WHERE name = ?), ?, ?)`,
				)
				.bind(
					`${MONTH}-${String(day).padStart(2, "0")}`,
					rawName,
					categoryName,
					source,
					updatedAt,
				)
				.run();

		/**
		 * Inserts one new transaction per raw name and asks Jev about them in one run. Counts the line loads (a read of
		 * forgotten_texts comes with each) and the calls made.
		 */
		async function askRows(rawNames: string[]) {
			vi.spyOn(console, "log").mockImplementation(() => {});
			const ids: number[] = [];

			for (const rawName of rawNames) {
				const row = await db
					.prepare(
						"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 1200, ?) RETURNING id",
					)
					.bind(`${MONTH}-20`, rawName)
					.first<{ id: number }>();

				ids.push(Number(row?.id));
			}

			let loads = 0;

			const counted = new Proxy(db, {
				get(target, property) {
					const value = Reflect.get(target, property);

					if (property === "prepare")
						return (sql: string) => {
							if (sql.includes("FROM forgotten_texts")) loads += 1;

							return target.prepare(sql);
						};

					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as D1Database;

			const sent: SentRequest[] = [];
			let calls = 0;
			await categorizePending(
				{ DB: counted, JEV_API_KEY: "test-key" },
				async (_url, init) => {
					calls += 1;
					sent.push(JSON.parse(String(init?.body)));

					return reply(0.5);
				},
				{ rulesApplied: true, onlyIds: ids },
			);

			return { sent, loads, calls };
		}

		const sentFor = (sent: SentRequest[], rawName: string) =>
			sent.find((request) => request.state.bank_description === rawName);

		it("sends the learned line as its category name and answers count, and no merchant history", async () => {
			for (const day of [1, 2, 3])
				await answer("TIGER BOOKS", "Eating Out", day);
			const { sent } = await askRows(["TIGER BOOKS"]);
			expect(sent).toHaveLength(1);
			expect(sent[0]?.state.learned_category).toEqual({
				category: "Eating Out",
				from_answers: 3,
			});
			expect(sent[0]?.state).not.toHaveProperty("merchant_category_history");
		});

		it("sends no learned line for a text nobody has answered", async () => {
			const { sent } = await askRows(["UNSEEN SHOP 77"]);
			expect(sent).toHaveLength(1);
			expect(sent[0]?.state).not.toHaveProperty("learned_category");
			expect(sent[0]?.state).not.toHaveProperty("merchant_category_history");
		});

		it("sends no learned line for a forgotten text", async () => {
			for (const day of [1, 2])
				await answer("FORGET ME SHOP", "Eating Out", day);
			await forgetText(db, "forget me shop");
			const { sent } = await askRows(["FORGET ME SHOP"]);
			expect(sent[0]?.state).not.toHaveProperty("learned_category");
		});

		it("brings a forgotten text's line back once it is answered again after the Forget", async () => {
			for (const day of [1, 2, 3])
				await answer("FORGET ME SHOP", "Eating Out", day);
			await forgetText(db, "forget me shop");
			await answer(
				"FORGET ME SHOP",
				"Eating Out",
				4,
				"user",
				"2999-01-01 00:00:00",
			);
			const { sent } = await askRows(["FORGET ME SHOP"]);
			expect(sent[0]?.state.learned_category).toEqual({
				category: "Eating Out",
				from_answers: 1,
			});
		});

		it("never makes a line from Jev's own guesses", async () => {
			for (const day of [1, 2, 3])
				await answer("JEV GUESS SHOP", "Eating Out", day, "jev");
			const { sent } = await askRows(["JEV GUESS SHOP"]);
			expect(sent[0]?.state).not.toHaveProperty("learned_category");
		});

		it("sends no line for a vague text such as APPLE.COM/BILL", async () => {
			for (const day of [1, 2, 3])
				await answer("APPLE.COM/BILL", "Eating Out", day);

			// The line exists and is marked vague: the send is what is left out, not the line.
			const line = (await loadLearnedLines(db)).find(
				(l) => l.cleanedText === "apple.com/bill",
			);

			expect(line?.vague).toBe(true);
			const { sent } = await askRows(["APPLE.COM/BILL"]);
			expect(sent[0]?.state).not.toHaveProperty("learned_category");
		});

		it("sends no line whose category is archived", async () => {
			for (const day of [1, 2, 3])
				await answer("ARCHIVED LINE SHOP", "Eating Out", day);
			await db
				.prepare("UPDATE categories SET archived = 1 WHERE name = 'Eating Out'")
				.run();
			const { sent } = await askRows(["ARCHIVED LINE SHOP"]);
			expect(sent[0]?.state).not.toHaveProperty("learned_category");
		});

		it("loads the lines once for a group of rows, and still asks once per transaction", async () => {
			for (const day of [1, 2])
				await answer("GROUP LINE SHOP", "Eating Out", day);

			const { sent, loads, calls } = await askRows([
				"GROUP LINE SHOP",
				"OTHER SHOP 5",
				"THIRD SHOP 6",
			]);

			expect(loads).toBe(1);
			expect(calls).toBe(3);
			expect(sentFor(sent, "GROUP LINE SHOP")?.state.learned_category).toEqual({
				category: "Eating Out",
				from_answers: 2,
			});
			expect(sentFor(sent, "OTHER SHOP 5")?.state).not.toHaveProperty(
				"learned_category",
			);
		});

		it("loads no lines while category guessing is off", async () => {
			for (const day of [1, 2])
				await answer("GROUP LINE SHOP", "Eating Out", day);
			await switchTo({ categories: false, income: true });
			const { sent, loads } = await askRows(["GROUP LINE SHOP"]);
			expect(loads).toBe(0);
			expect(
				sent.every((request) => !("learned_category" in request.state)),
			).toBe(true);
		});

		it("sends no line for a text named like an inherited object key, when it has no line", async () => {
			const { sent, calls } = await askRows([
				"constructor",
				"__proto__",
				"tostring",
				"hasownproperty",
			]);

			expect(calls).toBe(4);

			for (const request of sent)
				expect(request.state).not.toHaveProperty("learned_category");
		});

		it("sends a real line named like an inherited object key, and none for the others", async () => {
			for (const day of [1, 2]) await answer("constructor", "Eating Out", day);
			const { sent } = await askRows(["constructor", "tostring"]);
			expect(sentFor(sent, "constructor")?.state.learned_category).toEqual({
				category: "Eating Out",
				from_answers: 2,
			});
			expect(sentFor(sent, "tostring")?.state).not.toHaveProperty(
				"learned_category",
			);
		});

		it("gives the line to every raw name that cleans to its text", async () => {
			for (const day of [1, 2])
				await answer("AUDIBLE*QQ11W2 WA 05/26", "Eating Out", day);

			const { sent } = await askRows([
				"AUDIBLE*TE3E10I7 WA 07/26",
				"AUDIBLE*ZZ99X1 WA 08/04",
			]);

			for (const rawName of [
				"AUDIBLE*TE3E10I7 WA 07/26",
				"AUDIBLE*ZZ99X1 WA 08/04",
			]) {
				expect(sentFor(sent, rawName)?.state.learned_category).toEqual({
					category: "Eating Out",
					from_answers: 2,
				});
			}
		});
	});
	describe("the merchant Jev is told when a person hasn't chosen one", () => {
		/** Sends one transaction for Jev and returns the merchant it was told. */
		const merchantJevIsTold = async (
			rawName: string,
			merchantName: string | null,
		) => {
			vi.spyOn(console, "log").mockImplementation(() => {});

			const target = await db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name) VALUES (1, ?, 1200, ?, ?) RETURNING id",
				)
				.bind(`${MONTH}-20`, rawName, merchantName)
				.first<{ id: number }>();

			let sent: SentRequest | undefined;
			await categorizePending(
				withKey,
				async (_url, init) => {
					sent = JSON.parse(String(init?.body));

					return reply(0.5);
				},
				{ rulesApplied: true, onlyIds: [target?.id as number] },
			);

			return sent?.state.merchant;
		};

		it("tells Jev the bank's own store name when no name is chosen", async () => {
			await db
				.prepare(
					"INSERT INTO merchants (raw_name, suggestion_status, names_asked) VALUES ('Blue Bottle Coffee', 'pending', 0)",
				)
				.run();
			await db
				.prepare(
					"INSERT INTO merchant_suggested_names (merchant_key, position, name) VALUES ('Blue Bottle Coffee', 0, 'Blue Bottle Coffee')",
				)
				.run();
			expect(await merchantJevIsTold("BL BTTL COF", "Blue Bottle Coffee")).toBe(
				"Blue Bottle Coffee",
			);
		});

		it("doesn't tell Jev a name Tally guessed", async () => {
			await db
				.prepare(
					"INSERT INTO merchants (raw_name, suggestion_status, names_asked) VALUES ('BL BTTL COF', 'pending', 0)",
				)
				.run();
			await db
				.prepare(
					"INSERT INTO merchant_suggested_names (merchant_key, position, name) VALUES ('BL BTTL COF', 0, 'Blue Bottle Coffee')",
				)
				.run();
			expect(await merchantJevIsTold("BL BTTL COF", null)).toBeNull();
		});

		it("tells Jev the chosen name over the bank's own", async () => {
			// A person chose "Blue Bottle" from the suggestion, so the row is accepted with the name they chose.
			await seedMerchant(db, {
				key: "Blue Bottle Coffee",
				status: "accepted",
				names: ["Blue Bottle Coffee"],
				displayName: "Blue Bottle",
			});
			expect(await merchantJevIsTold("BL BTTL COF", "Blue Bottle Coffee")).toBe(
				"Blue Bottle",
			);
		});

		it("doesn't tell Jev a bank name the person turned down", async () => {
			await db
				.prepare(
					"INSERT INTO merchants (raw_name, suggestion_status, names_asked) VALUES ('Blue Bottle Coffee', 'rejected', 0)",
				)
				.run();
			await db
				.prepare(
					"INSERT INTO merchant_suggested_names (merchant_key, position, name) VALUES ('Blue Bottle Coffee', 0, 'Blue Bottle Coffee')",
				)
				.run();
			expect(
				await merchantJevIsTold("BL BTTL COF", "Blue Bottle Coffee"),
			).toBeNull();
		});
	});

	it("sends a transaction with no merchant history exactly as it did before", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});

		const target = await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 1200, 'ONE-OFF SHOP') RETURNING id",
			)
			.bind(`${MONTH}-20`)
			.first<{ id: number }>();

		let sent: Record<string, unknown> | undefined;
		await categorizePending(
			withKey,
			async (_url, init) => {
				sent = JSON.parse(String(init?.body));

				return reply(0.5);
			},
			{ rulesApplied: true, onlyIds: [target?.id as number] },
		);
		expect(sent?.state).toEqual({
			bank_description: "ONE-OFF SHOP",
			merchant: null,
			amount_cents: 1200,
			direction: "money out",
			account_type: "depository",
		});
	});

	it.each([
		{ enabled: true, income: 1, source: "jev", reviewed: 1 },
		{ enabled: false, income: 0, source: null, reviewed: 0 },
	])(
		"applies the income answer only when the income switch is $enabled",
		async ({ enabled, income, source, reviewed }) => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			const id = 1;
			await db.batch([
				db
					.prepare(
						"UPDATE transactions SET amount_cents = -500, category_id = NULL, category_source = NULL, category_confidence = NULL, flag_income = 0, income_source = NULL, credit_reviewed = 0, credit_reviewed_by = NULL, excluded = 0, excluded_source = NULL WHERE id = ?",
					)
					.bind(id),
				db
					.prepare(
						"UPDATE transactions SET category_confidence = 0.5 WHERE id != ?",
					)
					.bind(id),
			]);

			const jev = fakeJev(
				() =>
					new Response(
						JSON.stringify({
							answers: {
								category: {
									type: "choice",
									choice: "None of these fit",
									confidence: 0.5,
								},
								transfer: { type: "noul", noul: 0.01 },
								reimbursement: { type: "noul", noul: 0.01 },
								income: { type: "noul", noul: 0.99 },
							},
						}),
						{ status: 200 },
					),
			);

			await saveAiSwitches(db, {
				...AI_SWITCHES_ALL_ON,
				details: false,
				income: enabled,
			});
			await categorizePending(withKey, jev.fetchImpl);
			expect(
				await db
					.prepare(
						"SELECT flag_income, income_source, credit_reviewed FROM transactions WHERE id = ?",
					)
					.bind(id)
					.first(),
			).toEqual({
				flag_income: income,
				income_source: source,
				credit_reviewed: reviewed,
			});
		},
	);

	it.each([
		[0.19, true],
		[0.2, true],
		[0.21, false],
		[0.79, false],
		[0.8, true],
		[0.81, true],
	] as const)(
		"Jev-settled income confidence %s reviews a credit: %s",
		async (incomeConfidence, reviewed) => {
			const inserted = await db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, credit_reviewed) VALUES (1, ?, -500, 'INCOME CONFIDENCE EDGE', 0) RETURNING id",
				)
				.bind(`${MONTH}-20`)
				.first<{ id: number }>();

			const id = inserted?.id as number;

			const answer = new Response(
				JSON.stringify({
					answers: {
						category: { type: "choice", choice: "Groceries", confidence: 0.9 },
						transfer: { type: "noul", noul: 0.01 },
						reimbursement: { type: "noul", noul: 0.01 },
						income: { type: "noul", noul: incomeConfidence },
					},
				}),
				{ status: 200 },
			);

			await categorizePending(withKey, async () => answer.clone(), {
				rulesApplied: true,
				onlyIds: [id],
			});

			const saved = await db
				.prepare(
					"SELECT flag_income, income_confidence, credit_reviewed, category_confidence FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first();

			expect(saved).toEqual({
				flag_income: incomeConfidence >= 0.8 ? 1 : 0,
				income_confidence: incomeConfidence >= 0.8 ? null : incomeConfidence,
				credit_reviewed: reviewed ? 1 : 0,
				category_confidence: 0.9,
			});

			if (incomeConfidence === 0.2) {
				const retry = fakeJev(() => reply(0.95));
				expect(
					await categorizePending(withKey, retry.fetchImpl, {
						rulesApplied: true,
						onlyIds: [id],
					}),
				).toEqual({ asked: 0, applied: 0 });
				expect(retry.calls()).toBe(0);
			}
		},
	);

	it.each([
		[0.19, false],
		[0.2, false],
		[0.21, false],
		[0.79, false],
		[0.8, true],
		[0.81, true],
	] as const)(
		"Jev-settled category confidence %s reviews a non-income credit: %s",
		async (categoryConfidence, reviewed) => {
			const inserted = await db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, credit_reviewed) VALUES (1, ?, -500, 'CATEGORY CONFIDENCE EDGE', 0) RETURNING id",
				)
				.bind(`${MONTH}-20`)
				.first<{ id: number }>();

			const id = inserted?.id as number;

			const answer = new Response(
				JSON.stringify({
					answers: {
						category: {
							type: "choice",
							choice: "Groceries",
							confidence: categoryConfidence,
						},
						transfer: { type: "noul", noul: 0.01 },
						reimbursement: { type: "noul", noul: 0.01 },
						income: { type: "noul", noul: 0.1 },
					},
				}),
				{ status: 200 },
			);

			await categorizePending(withKey, async () => answer.clone(), {
				rulesApplied: true,
				onlyIds: [id],
			});

			const saved = await db
				.prepare(
					"SELECT category_id, category_confidence, income_confidence, credit_reviewed FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first();

			expect(saved).toEqual({
				category_id: categoryConfidence >= 0.8 ? 1 : null,
				category_confidence: categoryConfidence,
				income_confidence: 0.1,
				credit_reviewed: reviewed ? 1 : 0,
			});
		},
	);

	it("does nothing without a key", async () => {
		const jev = fakeJev(() => reply(0.95));
		const result = await categorizePending({ DB: db }, jev.fetchImpl);
		expect(jev.calls()).toBe(0);
		expect(result).toEqual({ asked: 0, applied: 0 });
		expect(await needsCategoryCount(db, MONTH)).toBe(10);
	});

	it("offers category-only help for a user-reviewed credit and never overwrites the decision", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const id = 1;
		await db
			.prepare(
				"UPDATE transactions SET raw_name = 'SYNTHETIC USER REVIEWED CREDIT', category_id = NULL, category_source = NULL, category_confidence = NULL, amount_cents = -500, flag_income = 0, income_source = 'user', credit_reviewed = 1, credit_reviewed_by = 'user', excluded = 0, excluded_source = NULL, flag_transfer = 0, flag_reimbursement = 0 WHERE id = ?",
			)
			.bind(id)
			.run();
		await db
			.prepare(
				"UPDATE transactions SET category_confidence = 0.5 WHERE id != ?",
			)
			.bind(id)
			.run();
		const pending = await pendingForJev(db, 40);
		expect(pending).toContainEqual(
			expect.objectContaining({ id, categoryOnly: true }),
		);

		const jev = fakeJev(
			() =>
				new Response(
					JSON.stringify({
						answers: {
							category: {
								type: "choice",
								choice: "Eating Out",
								confidence: 0.95,
							},
							transfer: { type: "noul", noul: 0.99 },
							reimbursement: { type: "noul", noul: 0.99 },
							income: { type: "noul", noul: 0.99 },
						},
					}),
					{ status: 200 },
				),
		);

		expect(await categorizePending(withKey, jev.fetchImpl)).toEqual({
			asked: 1,
			applied: 1,
		});
		expect(jev.calls()).toBe(1);

		const category = await db
			.prepare("SELECT id FROM categories WHERE name = 'Eating Out'")
			.first<{ id: number }>();

		expect(
			await db
				.prepare(
					"SELECT category_id, category_source, category_confidence, flag_income, income_source, credit_reviewed, credit_reviewed_by, excluded, flag_transfer, flag_reimbursement FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({
			category_id: category?.id,
			category_source: "jev",
			category_confidence: 0.95,
			flag_income: 0,
			income_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: "user",
			excluded: 0,
			flag_transfer: 0,
			flag_reimbursement: 0,
		});
		const secondRun = fakeJev(() => reply(0.95));
		expect(await categorizePending(withKey, secondRun.fetchImpl)).toEqual({
			asked: 0,
			applied: 0,
		});
		expect(secondRun.calls()).toBe(0);
		expect(
			await db
				.prepare(
					"SELECT amount_cents, income_source, credit_reviewed_by FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({
			amount_cents: -500,
			income_source: "user",
			credit_reviewed_by: "user",
		});
	});

	it("applies confident answers and stores the confidence of unsure ones", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});

		// First 4 calls confident, the rest unsure.
		const jev = fakeJev(
			() => reply(0.95),
			() => reply(0.95),
			() => reply(0.95),
			() => reply(0.95),
			() => reply(0.5),
		);

		const result = await categorizePending(withKey, jev.fetchImpl);

		expect(jev.calls()).toBe(10);
		expect(result).toEqual({ asked: 10, applied: 4 });
		expect(await needsCategoryCount(db, MONTH)).toBe(6);
		expect(
			await countWhere(
				"category_source IS NULL AND category_id IS NULL AND category_confidence = 0.5",
			),
		).toBe(6);
	});

	it.each(["merchant_rule", "user"] as const)(
		"remembers an uncertain answer for a $categorySource-categorized credit and retries after Plaid changes it",
		async (categorySource) => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			await db
				.prepare(
					"UPDATE transactions SET category_confidence = 0.5 WHERE category_confidence IS NULL",
				)
				.run();
			const heldBefore = (await monthCounts(db, MONTH)).heldForReview;

			const inserted = await db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source, category_confidence, flag_income, income_source, credit_reviewed, credit_reviewed_by) VALUES (1, ?, -777, 'SYNTHETIC UNCERTAIN CREDIT', 1, ?, NULL, 0, NULL, 0, NULL) RETURNING id",
				)
				.bind(`${MONTH}-20`, categorySource)
				.first<{ id: number }>();

			const id = inserted?.id as number;
			const jev = fakeJev(() => reply(0.5));
			expect(await categorizePending(withKey, jev.fetchImpl)).toEqual({
				asked: 1,
				applied: 0,
			});
			expect(jev.calls()).toBe(1);
			expect(
				await db
					.prepare(
						"SELECT flag_income, income_source, credit_reviewed, category_confidence, category_id, category_source FROM transactions WHERE id = ?",
					)
					.bind(id)
					.first(),
			).toEqual({
				flag_income: 0,
				income_source: null,
				credit_reviewed: 0,
				category_confidence: 0.5,
				category_id: 1,
				category_source: categorySource,
			});
			expect((await monthCounts(db, MONTH)).heldForReview).toBe(heldBefore + 1);
			expect(
				(await loadMonth(db, MONTH)).transactions.some(
					(transaction) => transaction.amountCents === -777,
				),
			).toBe(false);
			const next = fakeJev(() => reply(0.95));
			expect(await categorizePending(withKey, next.fetchImpl)).toEqual({
				asked: 0,
				applied: 0,
			});
			expect(next.calls()).toBe(0);

			// Plaid amount corrections clear Jev's saved confidence and make the transaction eligible again.
			await db
				.prepare(
					"UPDATE transactions SET amount_cents = -888, category_confidence = NULL WHERE id = ?",
				)
				.bind(id)
				.run();
			expect(
				(await pendingForJev(db, 40)).map((transaction) => transaction.id),
			).toContain(id);
			const changed = fakeJev(() => reply(0.95));
			expect(await categorizePending(withKey, changed.fetchImpl)).toEqual({
				asked: 1,
				applied: 1,
			});
			expect(changed.calls()).toBe(1);
			expect((await monthCounts(db, MONTH)).heldForReview).toBe(heldBefore);
		},
	);

	it("doesn't ask again about transactions it already looked at", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await categorizePending(withKey, fakeJev(() => reply(0.5)).fetchImpl);
		const second = fakeJev(() => reply(0.95));
		await categorizePending(withKey, second.fetchImpl);
		expect(second.calls()).toBe(0);
	});

	it("stops the run on a failure and retries the rest the next night", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});

		const jev = fakeJev(
			() => reply(0.95),
			() => reply(0.95),
			() =>
				new Response("{}", {
					status: 429,
					headers: { "x-typesafe-request-id": "req_9" },
				}),
		);

		const first = await categorizePending(withKey, jev.fetchImpl);

		expect(jev.calls()).toBe(3);
		expect(first).toEqual({ asked: 3, applied: 2 });
		expect(await needsCategoryCount(db, MONTH)).toBe(8);
		// The only thing logged about a failure: the status and Jev's request id.
		expect(errors).toHaveBeenCalledTimes(1);
		expect(errors).toHaveBeenCalledWith("jev: 429 req_9");

		const next = fakeJev(() => reply(0.95));
		await categorizePending(withKey, next.fetchImpl);
		expect(next.calls()).toBe(8);
		expect(await needsCategoryCount(db, MONTH)).toBe(0);
	});

	it("counts only categories it actually wrote, not ones a person chose mid-run", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		let calls = 0;

		const fetchImpl = async () => {
			calls += 1;

			// While Jev is answering the first call, a person categorizes every pending row.
			if (calls === 1) {
				await db
					.prepare(
						"UPDATE transactions SET category_id = 1, category_source = 'user' WHERE category_id IS NULL AND flag_income = 0",
					)
					.run();
			}

			return reply(0.95);
		};

		const result = await categorizePending(withKey, fetchImpl);
		expect(result.applied).toBe(0);
	});

	it("logs only counts on success, never transaction details", async () => {
		const logs = vi.spyOn(console, "log").mockImplementation(() => {});
		await categorizePending(withKey, fakeJev(() => reply(0.95)).fetchImpl);
		expect(logs).toHaveBeenCalledTimes(1);
		expect(logs).toHaveBeenCalledWith("jev: asked 10, applied 10");
	});

	it("applies merchant rules before asking Jev", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await db
			.prepare(
				"UPDATE merchants SET default_category_id = 1 WHERE raw_name = 'SQ *FARMERS MKT'",
			)
			.run();
		const jev = fakeJev(() => reply(0.5));
		await categorizePending(withKey, jev.fetchImpl);
		expect(jev.calls()).toBe(9);
		expect(await countWhere("category_source = 'merchant_rule'")).toBe(1);
	});

	it("skips its own rules pass when the sync just ran it", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await db
			.prepare(
				"UPDATE merchants SET default_category_id = 1 WHERE raw_name = 'SQ *FARMERS MKT'",
			)
			.run();
		const jev = fakeJev(() => reply(0.5));
		await categorizePending(withKey, jev.fetchImpl, { rulesApplied: true });
		expect(await countWhere("category_source = 'merchant_rule'")).toBe(0);
	});

	it("caps a run at 40 calls in the demo and 500 in production (decision 56)", () => {
		expect(jevCallLimit({ DEMO: "true" })).toBe(40);
		expect(jevCallLimit({})).toBe(40);
		expect(jevCallLimit({ DEMO: "false" })).toBe(500);
	});

	it("stops the demo's run at its cap", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});

		// Make 50 more transactions that need a category.
		for (let i = 0; i < 50; i++) {
			await db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 100, ?)",
				)
				.bind(`${MONTH}-01`, `EXTRA ${i}`)
				.run();
		}

		const jev = fakeJev(() => reply(0.5));
		await categorizePending({ ...withKey, DEMO: "true" }, jev.fetchImpl);
		expect(jev.calls()).toBe(40);
	});

	it("goes past the demo's cap in production, so a new bank's backfill isn't held to 40 a day", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});

		for (let i = 0; i < 50; i++) {
			await db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 100, ?)",
				)
				.bind(`${MONTH}-01`, `EXTRA ${i}`)
				.run();
		}

		const jev = fakeJev(() => reply(0.5));
		await categorizePending({ ...withKey, DEMO: "false" }, jev.fetchImpl);
		expect(jev.calls()).toBeGreaterThan(50);
		// Nothing is left for the next night.
		const again = fakeJev(() => reply(0.5));
		await categorizePending({ ...withKey, DEMO: "false" }, again.fetchImpl);
		expect(again.calls()).toBe(0);
	});

	describe("the day's cap, shared with the runs right after a sync (spec §8.6)", () => {
		/** 50 more transactions that need a category, so more are waiting than the demo's cap. */
		async function addExtras() {
			for (let i = 0; i < 50; i++) {
				await db
					.prepare(
						"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 100, ?)",
					)
					.bind(`${MONTH}-01`, `EXTRA ${i}`)
					.run();
			}
		}

		/** Counts n calls against today's cap, as earlier runs the same day would have. */
		async function spend(n: number, cap = 40) {
			await reserveJevCalls(
				db,
				await householdToday(db),
				cap,
				n,
				crypto.randomUUID(),
			);
		}

		const quiet = () => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			vi.spyOn(console, "error").mockImplementation(() => {});
		};

		it("asks only about what an earlier run left of the day's cap", async () => {
			quiet();
			await addExtras();
			await spend(35);
			const jev = fakeJev(() => reply(0.5));
			const result = await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(5);
			expect(result.asked).toBe(5);
			expect(await callsUsed()).toBe(40);
		});

		it("splits one day's cap between two runs, never past it", async () => {
			quiet();
			// A run right after a sync sorts the seed's 12 ...
			const first = fakeJev(() => reply(0.5));
			await categorizePending(withKey, first.fetchImpl, {
				rulesApplied: true,
			});
			expect(first.calls()).toBe(10);
			// ... then 50 more arrive, and the nightly run gets the 28 left of 40.
			await addExtras();
			const second = fakeJev(() => reply(0.5));
			await categorizePending(withKey, second.fetchImpl);
			expect(second.calls()).toBe(30);
			expect(await callsUsed()).toBe(40);
		});

		it("asks nothing once the day's cap is used, leaving the rest for the next day", async () => {
			quiet();
			await spend(40);
			const waiting = (await pendingForJev(db, 100)).length;
			expect(waiting).toBe(10);
			const jev = fakeJev(() => reply(0.95));
			const result = await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(0);
			expect(result).toEqual({ asked: 0, applied: 0 });
			expect(await pendingForJev(db, 100)).toHaveLength(waiting);
		});

		it("counts a call that failed, since it was asked", async () => {
			quiet();
			const jev = fakeJev(() => new Response("{}", { status: 503 }));
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(1);
			expect(await callsUsed()).toBe(1);
		});

		it("doesn't count a transaction it didn't ask about", async () => {
			quiet();
			await saveAiSwitches(db, {
				...AI_SWITCHES_ALL_ON,
				details: false,
				categories: false,
				income: false,
			});
			const jev = fakeJev(() => reply(0.95));
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(0);
			expect(await callsUsed()).toBe(0);
		});

		it("starts the next household day at zero", async () => {
			quiet();
			await spend(40);
			await newDay();
			const jev = fakeJev(() => reply(0.5));
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(10);
		});

		it("never goes over the cap when runs go at the same moment", async () => {
			quiet();
			await addExtras();

			const runs = await Promise.all(
				[1, 2, 3].map(() => {
					const jev = fakeJev(() => reply(0.5));

					return categorizePending(withKey, jev.fetchImpl).then(() =>
						jev.calls(),
					);
				}),
			);

			expect(runs.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(40);
			expect(await callsUsed()).toBe(40);
		});
	});

	describe("the calls it reserves for the day (spec §8.6)", () => {
		const quiet = () => {
			vi.spyOn(console, "log").mockImplementation(() => {});

			return vi.spyOn(console, "error").mockImplementation(() => {});
		};

		/** A DB that counts every statement a run prepares, for D1's 1,000 queries per invocation. */
		function countingDb() {
			let statements = 0;

			const counted = new Proxy(db, {
				get(target, property) {
					const value = Reflect.get(target, property);

					if (property === "prepare")
						return (sql: string) => {
							statements += 1;

							return target.prepare(sql);
						};

					return typeof value === "function" ? value.bind(target) : value;
				},
			});

			return { db: counted as D1Database, statements: () => statements };
		}

		it("costs at most three queries a call, none of them for the cap", async () => {
			quiet();
			const ids = (await pendingForJev(db, 100)).map((t) => t.id);
			const few = countingDb();
			await categorizePending(
				{ ...withKey, DB: few.db },
				fakeJev(() => reply(0.95)).fetchImpl,
				{ rulesApplied: true, onlyIds: ids.slice(0, 6) },
			);
			// Another day, so the same cap and the same twelve waiting.
			await resetDemo(db, TODAY);
			await newDay();
			const many = countingDb();
			await categorizePending(
				{ ...withKey, DB: many.db },
				fakeJev(() => reply(0.95)).fetchImpl,
				{ rulesApplied: true, onlyIds: ids },
			);
			// Six calls cost three each, plus the run's one bulk details save and history read.
			expect(many.statements() - few.statements()).toBeLessThanOrEqual(20);
		});

		it("gives back what it reserved and didn't ask when the run stops early", async () => {
			quiet();
			const jev = fakeJev(() => new Response("{}", { status: 503 }));
			await categorizePending(withKey, jev.fetchImpl);
			// It reserved the twelve waiting, asked one, and the other eleven are free again.
			expect(jev.calls()).toBe(1);
			expect(await callsUsed()).toBe(1);
			const next = fakeJev(() => reply(0.95));
			await categorizePending(withKey, next.fetchImpl);
			expect(next.calls()).toBe(10);
			expect(await callsUsed()).toBe(11);
		});

		it("starts no new call once its deadline has passed, and gives back what it didn't ask", async () => {
			quiet();
			let now = 0;

			const jev = fakeJev(() => {
				now += 1_000;

				return reply(0.95);
			});

			// Calls start at 0, 1,000 and 2,000; the next would start at 3,000, past the deadline.
			expect(
				await categorizePending(withKey, jev.fetchImpl, {
					time: { deadline: 2_500, now: () => now },
				}),
			).toMatchObject({ asked: 3 });
			expect(jev.calls()).toBe(3);
			// It reserved the twelve waiting, and the other nine are free again.
			expect(await callsUsed()).toBe(3);
		});

		it("reserves and asks nothing when its deadline has passed before it starts", async () => {
			quiet();
			const jev = fakeJev(() => reply(0.95));
			expect(
				await categorizePending(withKey, jev.fetchImpl, {
					time: { deadline: 5_000, now: () => 5_000 },
				}),
			).toEqual({ asked: 0, applied: 0 });
			expect(jev.calls()).toBe(0);
			expect(await callsUsed()).toBe(0);
		});

		it("rolls the group's save back when giving the unused calls back fails, and the calls stay counted for the day", async () => {
			const errors = quiet();
			await db
				.prepare(
					`CREATE TRIGGER fail_give_back BEFORE UPDATE ON household_settings
					 WHEN OLD.key GLOB 'jev_calls_*' BEGIN SELECT RAISE(ABORT, 'nope'); END`,
				)
				.run();

			try {
				const jev = fakeJev(() => new Response("{}", { status: 503 }));
				// The save fails (in-process, a step runs once): the run ends and logs the error's name alone.
				await categorizePending(withKey, jev.fetchImpl);
				expect(JSON.stringify(errors.mock.calls)).toContain(
					"sorting: save step Error",
				);
				// The save is one batch, so nothing in it landed; the reserved calls stay counted: never over-spent.
				expect(await callsUsed()).toBe(10);
				expect(JSON.stringify(errors.mock.calls)).not.toContain("nope");
			} finally {
				await db.prepare("DROP TRIGGER fail_give_back").run();
			}
		});

		describe("when the household's day changes under a run", () => {
			// Eastern, the demo's zone: 03:59:50 UTC is 23:59:50 the evening before.
			const BEFORE_MIDNIGHT = "2026-10-06T03:59:50Z";
			const AFTER_MIDNIGHT = "2026-10-06T04:00:05Z";

			it("stops before the next call, and charges nothing to the new day", async () => {
				quiet();
				vi.useFakeTimers({ toFake: ["Date"] });
				vi.setSystemTime(new Date(BEFORE_MIDNIGHT));
				let calls = 0;

				const asked = async () => {
					calls += 1;

					// Midnight passes while the second call is on its way.
					if (calls === 2) vi.setSystemTime(new Date(AFTER_MIDNIGHT));

					return reply(0.95);
				};

				const result = await categorizePending(withKey, asked);
				// The second call was already made; the third is never sent.
				expect(calls).toBe(2);
				expect(result.asked).toBe(2);
				// The evening's day keeps its two; the new day has nothing charged to it.
				expect(await callsUsed("2026-10-05")).toBe(2);
				expect(await callsUsed("2026-10-06")).toBe(0);
			});

			it("leaves the rest for a run on the new day, which has the whole cap", async () => {
				quiet();
				vi.useFakeTimers({ toFake: ["Date"] });
				vi.setSystemTime(new Date(BEFORE_MIDNIGHT));
				let calls = 0;
				await categorizePending(withKey, async () => {
					calls += 1;

					if (calls === 2) vi.setSystemTime(new Date(AFTER_MIDNIGHT));

					return reply(0.95);
				});
				const next = fakeJev(() => reply(0.95));
				await categorizePending(withKey, next.fetchImpl);
				expect(next.calls()).toBe(8);
				expect(await callsUsed("2026-10-06")).toBe(8);
			});

			it("takes the household's own zone, not the server's", async () => {
				quiet();
				vi.useFakeTimers({ toFake: ["Date"] });
				// Tokyo's date is already the 6th at 15:00 UTC on the 5th, and turns the 7th at 15:00 UTC the 6th.
				await db
					.prepare(
						"UPDATE household_settings SET value = 'Asia/Tokyo' WHERE key = 'time_zone'",
					)
					.run();
				vi.setSystemTime(new Date("2026-10-06T14:59:55Z"));
				let calls = 0;

				const result = await categorizePending(withKey, async () => {
					calls += 1;

					if (calls === 1) vi.setSystemTime(new Date("2026-10-06T15:00:05Z"));

					return reply(0.95);
				});

				expect(result.asked).toBe(1);
				expect(await callsUsed("2026-10-06")).toBe(1);
			});

			it("dates the log row of an answer that comes back after midnight with the new day, in the new month", async () => {
				quiet();
				await db.prepare("DELETE FROM ai_log").run();
				vi.useFakeTimers({ toFake: ["Date"] });
				// Eastern, the demo's zone: 03:59:50 UTC on the 1st is 23:59:50 on the 31st, and the answer
				// comes back at 04:00:05 UTC, 00:00:05 on the 1st, before the zone's clocks change that day.
				vi.setSystemTime(new Date("2026-11-01T03:59:50Z"));

				const jev = fakeJev(() => {
					vi.setSystemTime(new Date("2026-11-01T04:00:05Z"));

					return reply(0.95);
				});

				await categorizePending(withKey, jev.fetchImpl);
				expect(jev.calls()).toBe(1);

				const logged = await db
					.prepare("SELECT kind, household_day FROM ai_log")
					.all<{ kind: string; household_day: string }>();

				expect([
					...new Set(logged.results.map((row) => row.household_day)),
				]).toEqual(["2026-11-01"]);
				expect(logged.results.map((row) => row.kind)).toContain("category");
				// The call stays charged to the day it was sent.
				expect(await callsUsed("2026-10-31")).toBe(1);
				expect(await callsUsed("2026-11-01")).toBe(0);
				const tally = await readAiTally(db, "2026-11-01");
				expect(tally.month).toBe("2026-11");
				expect(tally.sorted).toBe(1);
			});

			it("reads the household's zone once for the group's read and once for its save, not for every call", async () => {
				quiet();
				const zoneReads = countingDb();
				const spy = vi.spyOn(zoneReads.db, "prepare");
				await categorizePending(
					{ ...withKey, DB: zoneReads.db },
					fakeJev(() => reply(0.95)).fetchImpl,
				);

				const reads = spy.mock.calls.filter(([sql]) =>
					String(sql).includes("key = 'time_zone'"),
				);

				// One group: its read, then its save (which dates the log rows in the zone as it is now, decision 143).
				expect(reads).toHaveLength(2);
			});
		});
	});

	describe("asking only about the rows it's given", () => {
		const quiet = () => {
			vi.spyOn(console, "log").mockImplementation(() => {});

			return vi.spyOn(console, "error").mockImplementation(() => {});
		};

		const waitingIds = async () =>
			(await pendingForJev(db, 100)).map((t) => t.id);

		it("asks about those and leaves older waiting ones for the night", async () => {
			quiet();
			const [a, b, c] = await waitingIds();
			const jev = fakeJev(() => reply(0.95));

			const result = await categorizePending(withKey, jev.fetchImpl, {
				rulesApplied: true,
				onlyIds: [a as number, b as number, c as number],
			});

			expect(jev.calls()).toBe(3);
			expect(result.asked).toBe(3);
			// The nine older ones are still waiting, and the night's run takes them.
			expect(await pendingForJev(db, 100)).toHaveLength(7);
			const night = fakeJev(() => reply(0.95));
			await categorizePending(withKey, night.fetchImpl);
			expect(night.calls()).toBe(7);
		});

		it("counts only the calls it makes against the day", async () => {
			quiet();
			const [a, b] = await waitingIds();
			await categorizePending(withKey, fakeJev(() => reply(0.95)).fetchImpl, {
				rulesApplied: true,
				onlyIds: [a as number, b as number],
			});
			expect(await callsUsed()).toBe(2);
		});

		it("asks about nothing for an empty list, and counts nothing", async () => {
			const jev = fakeJev(() => reply(0.95));
			await categorizePending(withKey, jev.fetchImpl, { onlyIds: [] });
			expect(jev.calls()).toBe(0);
			expect(await callsUsed()).toBe(0);
		});

		it("skips a listed row that was already looked at, or already has a category", async () => {
			quiet();
			const [a, b, c] = (await waitingIds()) as [number, number, number];
			await db.batch([
				db
					.prepare(
						"UPDATE transactions SET category_confidence = 0.4 WHERE id = ?",
					)
					.bind(a),
				db
					.prepare(
						"UPDATE transactions SET category_id = 1, category_source = 'user' WHERE id = ?",
					)
					.bind(b),
			]);
			const jev = fakeJev(() => reply(0.95));
			await categorizePending(withKey, jev.fetchImpl, {
				rulesApplied: true,
				onlyIds: [a, b, c],
			});
			expect(jev.calls()).toBe(1);
		});

		it("lets a merchant rule sort a listed row before Jev is asked", async () => {
			quiet();
			await db
				.prepare(
					"UPDATE merchants SET default_category_id = 1 WHERE raw_name = 'SQ *FARMERS MKT'",
				)
				.run();
			const ids = await waitingIds();
			const jev = fakeJev(() => reply(0.95));

			const result = await categorizePending(withKey, jev.fetchImpl, {
				onlyIds: ids,
			});

			expect(result.asked).toBe(9);
			expect(
				await db
					.prepare(
						"SELECT category_source FROM transactions WHERE raw_name = 'SQ *FARMERS MKT'",
					)
					.first(),
			).toEqual({ category_source: "merchant_rule" });
		});

		it("takes more rows than D1's 100 bound values in one statement", async () => {
			quiet();
			await db
				.prepare(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250)
					 INSERT INTO transactions (account_id, date, amount_cents, raw_name)
					 SELECT 1, '2026-09-01', 100, 'EXTRA ' || i FROM n`,
				)
				.run();

			const { results } = await db
				.prepare("SELECT id FROM transactions WHERE raw_name LIKE 'EXTRA %'")
				.all<{ id: number }>();

			const ids = results.map((r) => r.id);
			expect(ids).toHaveLength(250);
			const jev = fakeJev(() => reply(0.95));
			await categorizePending({ ...withKey, DEMO: "false" }, jev.fetchImpl, {
				rulesApplied: true,
				onlyIds: ids,
			});
			expect(jev.calls()).toBe(250);
			// The seed's twelve weren't listed, so they still wait.
			expect(await pendingForJev(db, 100)).toHaveLength(10);
		}, 30_000);
	});

	// A run right after a sync honors "Sort new transactions as they arrive" before each call (spec §8.6).
	describe("a run started by a sync", () => {
		const quiet = () => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			vi.spyOn(console, "error").mockImplementation(() => {});
		};

		const bySync = async () => ({
			rulesApplied: true,
			bySync: true,
			onlyIds: (await pendingForJev(db, 100)).map((t) => t.id),
		});

		/** A Jev that runs `during` as its nth answer is on its way back, then answers. */
		function jevWith(during: (call: number) => Promise<void>) {
			let calls = 0;

			return {
				calls: () => calls,
				fetchImpl: async () => {
					calls += 1;
					await during(calls);

					return reply(0.95);
				},
			};
		}

		it("asks nothing when the switch is off to begin with, and counts nothing", async () => {
			await switchTo({ sortOnArrival: false });
			const jev = fakeJev(() => reply(0.95));
			await categorizePending(withKey, jev.fetchImpl, await bySync());
			expect(jev.calls()).toBe(0);
			expect(await callsUsed()).toBe(0);
		});

		it("finishes the group under way once the switch is turned off mid-run, and applies none of it", async () => {
			quiet();

			const jev = jevWith(async (call) => {
				if (call === 2) await switchTo({ sortOnArrival: false });
			});

			const result = await categorizePending(
				withKey,
				jev.fetchImpl,
				await bySync(),
			);

			// The group under way was read with the switch on, so all ten are asked; its save applies none of them.
			expect(jev.calls()).toBe(10);
			expect(result).toEqual({ asked: 10, applied: 0 });
			expect(await needsCategoryCount(db, MONTH)).toBe(10);
			expect(await callsUsed()).toBe(10);
		});

		it("keeps its group's answers when the switch goes off while they are saved, and starts nothing after", async () => {
			quiet();
			const jev = fakeJev(() => reply(0.95));

			const result = await categorizePending(
				{
					...withKey,
					DB: saveDuringFirstAnswer({ sortOnArrival: false }, jev),
				},
				jev.fetchImpl,
				await bySync(),
			);

			// The group was saved in one batch before the switch went off, so all ten answers are kept.
			expect(jev.calls()).toBe(10);
			expect(result).toEqual({ asked: 10, applied: 10 });
			expect(await callsUsed()).toBe(10);
		});

		it("is not what stops the nightly run, which has no such switch", async () => {
			quiet();

			const jev = jevWith(async (call) => {
				if (call === 2) await switchTo({ sortOnArrival: false });
			});

			const result = await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(10);
			expect(result.asked).toBe(10);
		});

		it("asks the group under way, and applies none of it, once the Jev switches are off", async () => {
			quiet();

			const jev = jevWith(async (call) => {
				if (call === 1) await switchTo({ categories: false, income: false });
			});

			const waiting = await needsCategoryCount(db, MONTH);

			const result = await categorizePending(
				withKey,
				jev.fetchImpl,
				await bySync(),
			);

			expect(jev.calls()).toBe(10);
			expect(result.applied).toBe(0);
			expect(await needsCategoryCount(db, MONTH)).toBe(waiting);
		});
	});

	it("skips one transaction Jev can't answer usefully and carries on with the rest", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		// The first (newest) transaction always gets an answer that isn't one of the options.
		let calls = 0;

		const fetchImpl = async () => {
			calls += 1;

			if (calls === 1) {
				return new Response(
					JSON.stringify({
						answers: {
							category: {
								type: "choice",
								choice: "eating out",
								confidence: 0.9,
							},
							transfer: { type: "noul", noul: 0.01 },
							reimbursement: { type: "noul", noul: 0.01 },
							income: { type: "noul", noul: 0.01 },
						},
					}),
					{ status: 200, headers: { "x-typesafe-request-id": "req_bad" } },
				);
			}

			return reply(0.95);
		};

		const result = await categorizePending(withKey, fetchImpl);

		expect(calls).toBe(10);
		expect(result).toEqual({ asked: 10, applied: 9 });
		expect(await needsCategoryCount(db, MONTH)).toBe(1);
		expect(errors).toHaveBeenCalledWith("jev: 200 req_bad");
	});

	it.each([422, 400])(
		"skips a transaction Jev rejects with %i instead of stopping",
		async (status) => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			vi.spyOn(console, "log").mockImplementation(() => {});
			let calls = 0;

			const fetchImpl = async () => {
				calls += 1;

				return calls === 1 ? new Response("{}", { status }) : reply(0.95);
			};

			await categorizePending(withKey, fetchImpl);
			expect(calls).toBe(10);
		},
	);

	it.each([401, 403, 429, 500, 529])(
		"stops the whole run on %i, which would fail every call",
		async (status) => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			const jev = fakeJev(() => new Response("{}", { status }));
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(1);
		},
	);

	it("doesn't ask Jev at all when there are no categories to offer", async () => {
		await db.prepare("UPDATE categories SET archived = 1").run();
		await saveAiSwitches(db, {
			categories: false,
			income: false,
			details: false,
		});
		const jev = fakeJev(() => reply(0.95));
		const result = await categorizePending(withKey, jev.fetchImpl);
		expect(jev.calls()).toBe(0);
		expect(result).toEqual({ asked: 0, applied: 0 });
		// Nothing was marked as looked at, so Jev asks once categories exist.
		expect(
			await countWhere(
				"category_confidence IS NOT NULL AND category_source IS NULL",
			),
		).toBe(0);
	});

	it("stops after three failures in a row, which point at every call, not one transaction", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const jev = fakeJev(() => new Response("{}", { status: 422 }));
		const result = await categorizePending(withKey, jev.fetchImpl);
		expect(jev.calls()).toBe(3);
		expect(result).toEqual({ asked: 3, applied: 0 });
	});

	it("resets the count after a good answer, so scattered bad rows are still skipped", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		let calls = 0;

		// Two failures, a success, two failures, then successes: never three in a row.
		const fetchImpl = async () => {
			calls += 1;

			return [1, 2, 4, 5].includes(calls)
				? new Response("{}", { status: 422 })
				: reply(0.95);
		};

		const result = await categorizePending(withKey, fetchImpl);
		expect(calls).toBe(10);
		expect(result.applied).toBe(6);
	});

	it("asks about transactions that failed before last, so they never block the rest", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		// The three newest pending transactions always get an unusable answer.
		const newest = (await pendingForJev(db, 3)).map((t) => t.id);

		const fetchImpl = async (_url: string, init?: RequestInit) => {
			const state = JSON.parse(String(init?.body)).state;

			const bad = await db
				.prepare("SELECT id FROM transactions WHERE raw_name = ?")
				.bind(state.bank_description)
				.first<{ id: number }>();

			return newest.includes(bad?.id ?? -1)
				? new Response("{}", { status: 422 })
				: reply(0.95);
		};

		// Night 1: the three bad ones come first, so the run stops after them.
		expect(await categorizePending(withKey, fetchImpl)).toEqual({
			asked: 3,
			applied: 0,
		});
		// Night 2: the other nine are asked first and applied; the three bad ones are last.
		expect(await categorizePending(withKey, fetchImpl)).toEqual({
			asked: 10,
			applied: 7,
		});
		expect(await needsCategoryCount(db, MONTH)).toBe(3);
	});

	it("doesn't mark a transaction as failed when Jev itself is down", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		await categorizePending(
			withKey,
			fakeJev(() => new Response("{}", { status: 503 })).fetchImpl,
		);
		expect(await countWhere("jev_failed_at IS NOT NULL")).toBe(0);
	});
});

// Spec §8.6: every run honors the household's AI switches, nightly and at sync alike. Off means
// Tally works from rules and people's choices alone, and nothing already decided changes.
describe("the AI switches", () => {
	const setSwitches = (over: Partial<typeof AI_SWITCHES_ALL_ON>) =>
		saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, details: false, ...over });

	/** A Jev reply with a flag's probability set, whatever the category. */
	const flagged = (flags: {
		transfer?: number;
		reimbursement?: number;
		income?: number;
	}) =>
		new Response(
			JSON.stringify({
				answers: {
					category: { type: "choice", choice: "Eating Out", confidence: 0.95 },
					transfer: { type: "noul", noul: flags.transfer ?? 0.01 },
					reimbursement: { type: "noul", noul: flags.reimbursement ?? 0.01 },
					income: { type: "noul", noul: flags.income ?? 0.01 },
				},
			}),
			{ status: 200 },
		);

	/** Only transaction 1 is left for Jev, as a credit nobody has decided about. */
	async function onlyOneCreditPending() {
		await db.batch([
			db.prepare(
				"UPDATE transactions SET amount_cents = -500, category_id = NULL, category_source = NULL, category_confidence = NULL, flag_income = 0, income_source = NULL, credit_reviewed = 0, credit_reviewed_by = NULL, excluded = 0, excluded_source = NULL WHERE id = 1",
			),
			db.prepare(
				"UPDATE transactions SET category_confidence = 0.5 WHERE id != 1",
			),
		]);
	}

	const snapshot = async () =>
		(
			await db
				.prepare(
					`SELECT id, category_id, category_source, category_confidence, jev_category_id, flag_transfer,
						flag_reimbursement, flag_income, income_source, credit_reviewed, excluded, excluded_source
					FROM transactions ORDER BY id`,
				)
				.all()
		).results;

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	it("never calls Jev with categories and income both off, however many transactions wait", async () => {
		await setSwitches({ categories: false, income: false });
		const before = await snapshot();
		const jev = fakeJev(() => reply(0.95));
		expect(await categorizePending(withKey, jev.fetchImpl)).toEqual({
			asked: 0,
			applied: 0,
		});
		expect(jev.calls()).toBe(0);
		expect(await snapshot()).toEqual(before);
	});

	it("still applies the household's merchant rules with every Jev switch off, since a rule is a person's choice", async () => {
		await setSwitches({ categories: false, income: false });
		await db
			.prepare(
				"UPDATE merchants SET default_category_id = 1 WHERE raw_name = 'SQ *FARMERS MKT'",
			)
			.run();
		const jev = fakeJev(() => reply(0.95));
		await categorizePending(withKey, jev.fetchImpl);
		expect(jev.calls()).toBe(0);
		expect(await countWhere("category_source = 'merchant_rule'")).toBe(1);
	});

	it("asks Jev nightly with names and sorting-as-they-arrive off, since neither gates the nightly run", async () => {
		await setSwitches({ names: false, sortOnArrival: false });
		const jev = fakeJev(() => reply(0.95));
		const result = await categorizePending(withKey, jev.fetchImpl);
		expect(jev.calls()).toBe(10);
		expect(result.applied).toBe(10);
	});

	describe("with categories and exclusions off, and income on", () => {
		beforeEach(() => setSwitches({ categories: false }));

		it("asks Jev for the income answer, but applies and keeps no category", async () => {
			const asked = (await pendingForJev(db, 40)).map((t) => t.id);
			const jev = fakeJev(() => reply(0.97));
			const result = await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(10);
			expect(result.applied).toBe(0);

			// Neither applied nor kept as a suggestion to show; only that it was asked is kept.
			const rows = await db
				.prepare(
					`SELECT category_id, category_source, jev_category_id, category_confidence
					FROM transactions WHERE id IN (${asked.join(",")})`,
				)
				.all();

			expect(rows.results).toHaveLength(10);

			for (const row of rows.results)
				expect(row).toEqual({
					category_id: null,
					category_source: null,
					jev_category_id: null,
					category_confidence: 0.97,
				});
			expect(await needsCategoryCount(db, MONTH)).toBe(10);
		});

		it("lets Jev's transfer and reimbursement flags exclude nothing", async () => {
			const excludedBefore = await countWhere("excluded = 1");

			const flagsBefore = await countWhere(
				"flag_transfer = 1 OR flag_reimbursement = 1",
			);

			const jev = fakeJev(() =>
				flagged({ transfer: 0.99, reimbursement: 0.99 }),
			);

			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(10);
			expect(await countWhere("excluded = 1")).toBe(excludedBefore);
			expect(
				await countWhere("flag_transfer = 1 OR flag_reimbursement = 1"),
			).toBe(flagsBefore);
			expect(await countWhere("excluded_source = 'jev'")).toBe(0);
		});

		it("still stores Jev's income answer on a credit", async () => {
			await onlyOneCreditPending();
			const jev = fakeJev(() => flagged({ income: 0.99 }));
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(1);
			expect(
				await db
					.prepare(
						"SELECT category_id, flag_income, income_source, credit_reviewed FROM transactions WHERE id = 1",
					)
					.first(),
			).toEqual({
				category_id: null,
				flag_income: 1,
				income_source: "jev",
				credit_reviewed: 1,
			});
		});

		it("still asks about an older credit whose review was never recorded (NULL), and stores its income answer", async () => {
			await onlyOneCreditPending();
			await db
				.prepare(
					"UPDATE transactions SET credit_reviewed = NULL, credit_reviewed_by = NULL, income_source = NULL WHERE id = 1",
				)
				.run();
			const jev = fakeJev(() => flagged({ income: 0.99 }));
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(1);
			expect(
				await db
					.prepare(
						"SELECT flag_income, income_source FROM transactions WHERE id = 1",
					)
					.first(),
			).toEqual({ flag_income: 1, income_source: "jev" });
		});

		it("marks what it asked about as looked at, so the same ones aren't asked every night", async () => {
			const jev = fakeJev(() => reply(0.97));
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(10);
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(10);
		});

		it("doesn't ask about a credit a person already reviewed, since only its category could be asked", async () => {
			await onlyOneCreditPending();
			await db
				.prepare(
					"UPDATE transactions SET income_source = 'user', credit_reviewed = 1, credit_reviewed_by = 'user' WHERE id = 1",
				)
				.run();
			const jev = fakeJev(() => reply(0.97));
			expect(await categorizePending(withKey, jev.fetchImpl)).toEqual({
				asked: 0,
				applied: 0,
			});
			expect(jev.calls()).toBe(0);
		});
	});

	describe("with income off, and categories on", () => {
		beforeEach(() => setSwitches({ income: false }));

		it("applies Jev's category but not its income answer", async () => {
			await onlyOneCreditPending();
			const jev = fakeJev(() => flagged({ income: 0.99 }));
			const result = await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(1);
			expect(result.applied).toBe(1);
			expect(
				await db
					.prepare(
						"SELECT category_id, category_source, flag_income, income_source FROM transactions WHERE id = 1",
					)
					.first(),
			).toEqual({
				category_id: 2,
				category_source: "jev",
				flag_income: 0,
				income_source: null,
			});
		});

		it("still lets its transfer flag exclude, which the categories switch owns", async () => {
			const jev = fakeJev(() => flagged({ transfer: 0.99 }));
			await categorizePending(withKey, jev.fetchImpl);
			expect(await countWhere("excluded_source = 'jev'")).toBeGreaterThan(0);
		});
	});

	it("changes nothing already decided when switches are turned off after a run", async () => {
		await categorizePending(withKey, fakeJev(() => reply(0.95)).fetchImpl);
		const decided = await snapshot();
		expect(await needsCategoryCount(db, MONTH)).toBe(0);
		await setSwitches({
			names: false,
			categories: false,
			income: false,
			sortOnArrival: false,
		});
		const jev = fakeJev(() => reply(0.5));
		await categorizePending(withKey, jev.fetchImpl);
		expect(jev.calls()).toBe(0);
		expect(await snapshot()).toEqual(decided);
	});

	it("is back on after the demo's nightly reset", async () => {
		await setSwitches({ categories: false, income: false });
		await resetDemo(db, TODAY);
		await saveAiSwitches(db, { details: false });
		const jev = fakeJev(() => reply(0.95));
		await categorizePending(withKey, jev.fetchImpl);
		expect(jev.calls()).toBe(10);
	});

	// Someone can save the switches while a run is going. They are read before each call, and a save checks
	// that the switches its call was asked under are still on, so an answer that arrives after one of them went
	// off is thrown away and its transaction waits for the next run.
	describe("turned off while a run is going", () => {
		/** A Jev that runs `during` as its nth answer is on its way back, then answers. */
		function jevWith(
			during: (call: number) => Promise<void>,
			response: () => Response,
		) {
			let calls = 0;

			return {
				calls: () => calls,
				fetchImpl: async () => {
					calls += 1;
					await during(calls);

					return response();
				},
			};
		}

		it("finishes the group under way once both Jev switches are off, and saves nothing from it", async () => {
			const before = await snapshot();

			const jev = jevWith(
				async (call) => {
					if (call === 1)
						await setSwitches({ categories: false, income: false });
				},
				() => reply(0.95),
			);

			const result = await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(10);
			expect(result.applied).toBe(0);
			expect(await snapshot()).toEqual(before);
			expect(await needsCategoryCount(db, MONTH)).toBe(10);
		});

		it("keeps the group's answers when the switches go off while they are saved, and starts nothing after", async () => {
			const jev = fakeJev(() => reply(0.95));

			const result = await categorizePending(
				{
					...withKey,
					DB: saveDuringFirstAnswer(
						{ categories: false, income: false, details: false },
						jev,
					),
				},
				jev.fetchImpl,
			);

			// The group was saved in one batch under the switches it was read with, before they went off.
			expect(jev.calls()).toBe(10);
			expect(result).toEqual({ asked: 10, applied: 10 });
			expect(await needsCategoryCount(db, MONTH)).toBe(0);
		});

		it("finishes the group under way, and applies none of it once the switches are off", async () => {
			const jev = jevWith(
				async (call) => {
					if (call === 2)
						await setSwitches({ categories: false, income: false });
				},
				() => reply(0.95),
			);

			const result = await categorizePending(withKey, jev.fetchImpl);
			// The group under way was read with the switches on: all ten are asked, and its save applies none of them.
			expect(jev.calls()).toBe(10);
			expect(result.applied).toBe(0);
			expect(await needsCategoryCount(db, MONTH)).toBe(10);
		});

		it("throws away the group's answers once categories went off, since they were asked under categories", async () => {
			const asked = (await pendingForJev(db, 40)).map((t) => t.id);

			const jev = jevWith(
				async (call) => {
					if (call === 2) await setSwitches({ categories: false });
				},
				() => reply(0.95),
			);

			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(10);

			const rows = (
				await db
					.prepare(
						`SELECT category_id, jev_category_id FROM transactions WHERE id IN (${asked.join(",")}) ORDER BY id`,
					)
					.all()
			).results;

			// The group was asked under categories, so once they went off its save applies none of its answers.
			expect(rows.filter((r) => r.category_id !== null)).toHaveLength(0);
			expect(rows.filter((r) => r.jev_category_id !== null)).toHaveLength(0);
			expect(
				await db
					.prepare("SELECT category_confidence FROM transactions WHERE id = ?")
					.bind(asked[1])
					.first(),
			).toEqual({ category_confidence: null });
		});

		it("throws away an income answer that arrives after income went off, so its transaction waits for the next run", async () => {
			await onlyOneCreditPending();

			const jev = jevWith(
				async () => {
					await setSwitches({ income: false });
				},
				() => flagged({ income: 0.99 }),
			);

			await categorizePending(withKey, jev.fetchImpl);
			// The whole answer was asked under income, so none of it is kept, not even its category.
			expect(
				await db
					.prepare(
						"SELECT category_id, flag_income, income_source FROM transactions WHERE id = 1",
					)
					.first(),
			).toEqual({ category_id: null, flag_income: 0, income_source: null });
			expect((await pendingForJev(db, 40)).map((t) => t.id)).toContain(1);
		});

		describe("saving one answer whose switches went off", () => {
			const eatingOutId = async () =>
				(
					await db
						.prepare("SELECT id FROM categories WHERE name = 'Eating Out'")
						.first<{ id: number }>()
				)?.id as number;

			const answerFor = (categoryId: number): Decision => ({
				categoryId,
				suggestedCategoryId: categoryId,
				confidence: 0.95,
				flags: { transfer: false, reimbursement: false, income: false },
			});

			const logRowsFor = async (id: number) =>
				(
					await db
						.prepare(
							"SELECT COUNT(*) AS n FROM ai_log WHERE transaction_id = ?",
						)
						.bind(id)
						.first<{ n: number }>()
				)?.n;

			it("writes neither the answer nor its log row once categories went off, since it was asked under them", async () => {
				await onlyOneCreditPending();
				await db.prepare("DELETE FROM ai_log WHERE transaction_id = 1").run();

				const options = {
					categoryAsked: true,
					switches: { income: true, categories: true },
					log: { day: TODAY, category: true, income: false },
				};

				const answer = answerFor(await eatingOutId());
				await setSwitches({ categories: false });
				const before = await snapshot();
				expect(await saveJevResult(db, 1, answer, options)).toBe(false);
				expect(await snapshot()).toEqual(before);
				expect(await logRowsFor(1)).toBe(0);
				// Once categories are on again, the same answer is written and logged.
				await setSwitches({});
				expect(await saveJevResult(db, 1, answer, options)).toBe(true);
				expect(await logRowsFor(1)).toBe(1);
			});

			it("writes neither the category nor its log row for a reviewed credit once categories went off", async () => {
				await db
					.prepare(
						"UPDATE transactions SET amount_cents = -500, category_id = NULL, category_source = NULL, category_confidence = NULL, flag_income = 0, income_source = 'user', credit_reviewed = 1, credit_reviewed_by = 'user', excluded = 0, excluded_source = NULL, flag_transfer = 0, flag_reimbursement = 0 WHERE id = 1",
					)
					.run();
				await db.prepare("DELETE FROM ai_log WHERE transaction_id = 1").run();

				const options = {
					categoryOnly: true,
					categoryAsked: true,
					switches: { income: true, categories: true },
					log: { day: TODAY, category: true, income: false },
				};

				const answer = answerFor(await eatingOutId());
				await setSwitches({ categories: false });
				const before = await snapshot();
				expect(await saveJevResult(db, 1, answer, options)).toBe(false);
				expect(await snapshot()).toEqual(before);
				expect(await logRowsFor(1)).toBe(0);
				await setSwitches({});
				expect(await saveJevResult(db, 1, answer, options)).toBe(true);
				expect(await logRowsFor(1)).toBe(1);
			});
		});

		it("asks the group under way, both credits included, once categories are off", async () => {
			await db.batch([
				db.prepare(
					"UPDATE transactions SET category_confidence = 0.5 WHERE id NOT IN (1, 2)",
				),
				db.prepare(
					"UPDATE transactions SET date = '2026-09-21', amount_cents = -500, category_id = NULL, category_source = NULL, category_confidence = NULL, flag_income = 0, income_source = NULL, credit_reviewed = 0, credit_reviewed_by = NULL, excluded = 0, excluded_source = NULL WHERE id = 1",
				),
				db.prepare(
					"UPDATE transactions SET date = '2026-09-20', amount_cents = -700, category_id = NULL, category_source = NULL, category_confidence = NULL, flag_income = 0, income_source = 'user', credit_reviewed = 1, credit_reviewed_by = 'user', excluded = 0, excluded_source = NULL WHERE id = 2",
				),
			]);
			expect((await pendingForJev(db, 40)).map((t) => t.id)).toEqual([1, 2]);

			const jev = jevWith(
				async (call) => {
					if (call === 1) await setSwitches({ categories: false });
				},
				() => reply(0.97),
			);

			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(2);
		});
	});
});

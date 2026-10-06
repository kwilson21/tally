import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { categorizePending, jevCallLimit } from "../src/categorize-pending";
import { householdToday } from "../src/dates";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { claimJevCall, jevCallsLeft } from "../src/db/jev-calls";
import { loadMonth } from "../src/db/month";
import {
	monthCounts,
	needsCategoryCount,
	pendingForJev,
} from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";

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

const countWhere = async (where: string) =>
	(
		await db
			.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${where}`)
			.first<{ n: number }>()
	)?.n ?? 0;

/** The household's next day: yesterday's Jev count no longer applies. */
const newDay = () =>
	db
		.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'")
		.run();

beforeEach(async () => {
	await resetDemo(db, TODAY);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("categorizePending", () => {
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

			await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, income: enabled });
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

	it("does nothing without a key", async () => {
		const jev = fakeJev(() => reply(0.95));
		const result = await categorizePending({ DB: db }, jev.fetchImpl);
		expect(jev.calls()).toBe(0);
		expect(result).toEqual({ asked: 0, applied: 0 });
		expect(await needsCategoryCount(db, MONTH)).toBe(12);
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

		expect(jev.calls()).toBe(12);
		expect(result).toEqual({ asked: 12, applied: 4 });
		expect(await needsCategoryCount(db, MONTH)).toBe(8);
		expect(
			await countWhere(
				"category_source IS NULL AND category_id IS NULL AND category_confidence = 0.5",
			),
		).toBe(8);
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
		expect(await needsCategoryCount(db, MONTH)).toBe(10);
		// The only thing logged about a failure: the status and Jev's request id.
		expect(errors).toHaveBeenCalledTimes(1);
		expect(errors).toHaveBeenCalledWith("jev: 429 req_9");

		const next = fakeJev(() => reply(0.95));
		await categorizePending(withKey, next.fetchImpl);
		expect(next.calls()).toBe(10);
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
		expect(logs).toHaveBeenCalledWith("jev: asked 12, applied 12");
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
		expect(jev.calls()).toBe(11);
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

	it("goes past the demo's cap in production, so a new bank's backfill is sorted in a night", async () => {
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

	it("stops production's run at 500, leaving the rest for the next night", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		// 510 more transactions that need a category, in one statement.
		await db
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 510)
				 INSERT INTO transactions (account_id, date, amount_cents, raw_name)
				 SELECT 1, ?, 100, 'EXTRA ' || i FROM n`,
			)
			.bind(`${MONTH}-01`)
			.run();
		const jev = fakeJev(() => reply(0.5));
		await categorizePending({ ...withKey, DEMO: "false" }, jev.fetchImpl);
		expect(jev.calls()).toBe(500);
		// The cap is the day's: another run the same day gets nothing.
		const sameDay = fakeJev(() => reply(0.5));
		await categorizePending({ ...withKey, DEMO: "false" }, sameDay.fetchImpl);
		expect(sameDay.calls()).toBe(0);
		// The next household day starts at zero.
		await newDay();
		const next = fakeJev(() => reply(0.5));
		await categorizePending({ ...withKey, DEMO: "false" }, next.fetchImpl);
		expect(next.calls()).toBeGreaterThan(0);
		// 500 Jev round trips take a few seconds on a busy CI runner.
	}, 30_000);

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
			const today = await householdToday(db);
			for (let i = 0; i < n; i++) await claimJevCall(db, today, cap);
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
			expect(await jevCallsLeft(db, await householdToday(db), 40)).toBe(0);
		});

		it("splits one day's cap between two runs, never past it", async () => {
			quiet();
			// A run right after a sync sorts the seed's 12 ...
			const first = fakeJev(() => reply(0.5));
			await categorizePending(withKey, first.fetchImpl, {
				rulesApplied: true,
			});
			expect(first.calls()).toBe(12);
			// ... then 50 more arrive, and the nightly run gets the 28 left of 40.
			await addExtras();
			const second = fakeJev(() => reply(0.5));
			await categorizePending(withKey, second.fetchImpl);
			expect(second.calls()).toBe(28);
			expect(await jevCallsLeft(db, await householdToday(db), 40)).toBe(0);
		});

		it("asks nothing once the day's cap is used, leaving the rest for the next day", async () => {
			quiet();
			await spend(40);
			const waiting = (await pendingForJev(db, 100)).length;
			expect(waiting).toBe(12);
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
			expect(await jevCallsLeft(db, await householdToday(db), 40)).toBe(39);
		});

		it("doesn't count a transaction it didn't ask about", async () => {
			quiet();
			await saveAiSwitches(db, {
				...AI_SWITCHES_ALL_ON,
				categories: false,
				income: false,
			});
			const jev = fakeJev(() => reply(0.95));
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(0);
			expect(await jevCallsLeft(db, await householdToday(db), 40)).toBe(40);
		});

		it("starts the next household day at zero", async () => {
			quiet();
			await spend(40);
			await newDay();
			const jev = fakeJev(() => reply(0.5));
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(12);
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
			expect(await jevCallsLeft(db, await householdToday(db), 40)).toBe(0);
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

		expect(calls).toBe(12);
		expect(result).toEqual({ asked: 12, applied: 11 });
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
			expect(calls).toBe(12);
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
		expect(calls).toBe(12);
		expect(result.applied).toBe(8);
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
			asked: 12,
			applied: 9,
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
		saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, ...over });

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
		expect(jev.calls()).toBe(12);
		expect(result.applied).toBe(12);
	});

	describe("with categories and exclusions off, and income on", () => {
		beforeEach(() => setSwitches({ categories: false }));

		it("asks Jev for the income answer, but applies and keeps no category", async () => {
			const asked = (await pendingForJev(db, 40)).map((t) => t.id);
			const jev = fakeJev(() => reply(0.97));
			const result = await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(12);
			expect(result.applied).toBe(0);
			// Neither applied nor kept as a suggestion to show; only that it was asked is kept.
			const rows = await db
				.prepare(
					`SELECT category_id, category_source, jev_category_id, category_confidence
					FROM transactions WHERE id IN (${asked.join(",")})`,
				)
				.all();
			expect(rows.results).toHaveLength(12);
			for (const row of rows.results)
				expect(row).toEqual({
					category_id: null,
					category_source: null,
					jev_category_id: null,
					category_confidence: 0.97,
				});
			expect(await needsCategoryCount(db, MONTH)).toBe(12);
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
			expect(jev.calls()).toBe(12);
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
			expect(jev.calls()).toBe(12);
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(12);
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
		const jev = fakeJev(() => reply(0.95));
		await categorizePending(withKey, jev.fetchImpl);
		expect(jev.calls()).toBe(12);
	});

	// Someone can save the switches while a run is going, so each transaction reads them again: before
	// it's sent, and before its answer is saved.
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

		it("stops sending once both Jev switches are off, and saves nothing from the answer on its way back", async () => {
			const before = await snapshot();
			const jev = jevWith(
				async (call) => {
					if (call === 1)
						await setSwitches({ categories: false, income: false });
				},
				() => reply(0.95),
			);
			const result = await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(1);
			expect(result.applied).toBe(0);
			expect(await snapshot()).toEqual(before);
			expect(await needsCategoryCount(db, MONTH)).toBe(12);
		});

		it("keeps what it saved before they went off, and sends nothing after", async () => {
			const jev = jevWith(
				async (call) => {
					if (call === 2)
						await setSwitches({ categories: false, income: false });
				},
				() => reply(0.95),
			);
			const result = await categorizePending(withKey, jev.fetchImpl);
			// The first answer was saved; the second arrived with the switches off, and no third went out.
			expect(jev.calls()).toBe(2);
			expect(result.applied).toBe(1);
			expect(await needsCategoryCount(db, MONTH)).toBe(11);
		});

		it("drops a category from the answer on its way back when categories went off, and carries on for income", async () => {
			const asked = (await pendingForJev(db, 40)).map((t) => t.id);
			const jev = jevWith(
				async (call) => {
					if (call === 2) await setSwitches({ categories: false });
				},
				() => reply(0.95),
			);
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(12);
			const rows = (
				await db
					.prepare(
						`SELECT category_id, jev_category_id FROM transactions WHERE id IN (${asked.join(",")}) ORDER BY id`,
					)
					.all()
			).results;
			// Only the first answer, which arrived while categories were on, was applied.
			expect(rows.filter((r) => r.category_id !== null)).toHaveLength(1);
			expect(rows.filter((r) => r.jev_category_id !== null)).toHaveLength(1);
		});

		it("doesn't use an income answer that arrives after income went off", async () => {
			await onlyOneCreditPending();
			const jev = jevWith(
				async () => {
					await setSwitches({ income: false });
				},
				() => flagged({ income: 0.99 }),
			);
			await categorizePending(withKey, jev.fetchImpl);
			expect(
				await db
					.prepare(
						"SELECT category_id, flag_income, income_source FROM transactions WHERE id = 1",
					)
					.first(),
			).toEqual({ category_id: 2, flag_income: 0, income_source: null });
		});

		it("skips a credit a person reviewed once categories are off, since only its category could be asked", async () => {
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
			expect(jev.calls()).toBe(1);
		});
	});
});

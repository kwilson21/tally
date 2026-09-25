import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { categorizePending, MAX_JEV_CALLS } from "../src/categorize-pending";
import { needsCategoryCount } from "../src/db/transactions";
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

beforeEach(async () => {
	await resetDemo(db, TODAY);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("categorizePending", () => {
	it("does nothing without a key", async () => {
		const jev = fakeJev(() => reply(0.95));
		const result = await categorizePending({ DB: db }, jev.fetchImpl);
		expect(jev.calls()).toBe(0);
		expect(result).toEqual({ asked: 0, applied: 0 });
		expect(await needsCategoryCount(db, MONTH)).toBe(12);
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

	it("makes at most MAX_JEV_CALLS calls a run", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		expect(MAX_JEV_CALLS).toBe(40);
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
		await categorizePending(withKey, jev.fetchImpl);
		expect(jev.calls()).toBe(40);
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
});

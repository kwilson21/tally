import { describe, expect, it } from "vitest";
import { askJev, JEV_THRESHOLD, JEV_URL } from "../src/ai/categorize";
import { NONE_FIT } from "../src/ai/decide";

const input = {
	rawName: "SQ *LOCAL BAKERY 4432",
	displayName: "Local Bakery",
	amountCents: 1200,
	accountType: "credit",
};
const categories = ["Groceries", "Eating Out", "Gas"];

type Call = { url: string; init: RequestInit };

/** A fake fetch that records each call and answers with the given response. */
function fakeFetch(respond: () => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fetchImpl = async (url: string, init?: RequestInit) => {
		calls.push({ url, init: init ?? {} });
		return respond();
	};
	return { calls, fetchImpl };
}

const ok = (body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json", ...headers },
	});

const goodBody = {
	model: "jev-latest",
	answers: {
		category: {
			type: "choice",
			choice: "Eating Out",
			confidence: 0.93,
			probabilities: { Groceries: 0.05, "Eating Out": 0.93, Gas: 0.02 },
		},
		transfer: { type: "noul", noul: 0.02 },
		reimbursement: { type: "noul", noul: 0.01 },
		income: { type: "noul", noul: 0.03 },
	},
	usage: { input_tokens: 120, output_tokens: 4 },
};

describe("askJev", () => {
	it.each(["kind", "for_person"])(
		"rejects an answer that omits requested %s",
		async (detail) => {
			const { fetchImpl } = fakeFetch(() =>
				ok({
					answers: {
						...goodBody.answers,
						[detail === "kind" ? "for_person" : "kind"]: {
							choice: detail === "kind" ? "none" : "one_off",
							confidence: 0.99,
						},
					},
				}),
			);
			expect(
				await askJev(input, categories, "k", fetchImpl, {
					details: true,
					people: [{ id: 4, name: "Morgan" }],
				}),
			).toMatchObject({ ok: false, status: 200 });
		},
	);

	it("gives the unknown-person choice an id distinct from household names", async () => {
		const { calls, fetchImpl } = fakeFetch(() => ok(goodBody));
		await askJev(input, [], "k", fetchImpl, {
			details: true,
			people: [{ id: 4, name: "Not sure" }],
		});
		const body = JSON.parse(String(calls[0]?.init.body));
		expect(Object.keys(body.questions.for_person.criteria)).toEqual([
			"person:4",
			"none",
		]);
	});

	it("makes one POST with the key, and asks the category and all flags together", async () => {
		const { calls, fetchImpl } = fakeFetch(() => ok(goodBody));
		await askJev(input, categories, "test-key", fetchImpl);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call?.url).toBe(JEV_URL);
		expect(call?.url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(call?.init.method).toBe("POST");
		const headers = new Headers(call?.init.headers);
		expect(headers.get("authorization")).toBe("Bearer test-key");
		expect(headers.get("content-type")).toBe("application/json");

		const body = JSON.parse(String(call?.init.body));
		expect(body.model).toBe("jev-latest");
		expect(Object.keys(body.questions).sort()).toEqual([
			"category",
			"income",
			"reimbursement",
			"transfer",
		]);
		expect(body.questions.category.type).toBe("choice");
		expect(Object.keys(body.questions.category.criteria)).toEqual([
			...categories,
			NONE_FIT,
		]);
		expect(body.questions.category.criteria[NONE_FIT]).toMatch(/none/i);
		for (const flag of ["transfer", "reimbursement", "income"]) {
			expect(body.questions[flag].type).toBe("noul");
		}
	});

	it("keeps the no-history request byte-for-byte equal to the origin/main body", async () => {
		const { calls, fetchImpl } = fakeFetch(() => ok(goodBody));
		await askJev(input, categories, "k", fetchImpl);
		expect(String(calls[0]?.init.body)).toBe(
			'{"model":"jev-latest","state":{"bank_description":"SQ *LOCAL BAKERY 4432","merchant":"Local Bakery","amount_cents":1200,"direction":"money out","account_type":"credit"},"questions":{"category":{"type":"choice","instructions":"Which of this household\'s budget categories does this bank transaction belong to?","criteria":{"Groceries":null,"Eating Out":null,"Gas":null,"None of these fit":"None of these categories fits this transaction, so a person should decide."}},"transfer":{"type":"noul","instructions":"Is this a transfer between the household\'s own accounts, rather than spending?"},"reimbursement":{"type":"noul","instructions":"Is this money paid back to the household for an earlier expense, such as a reimbursement?"},"income":{"type":"noul","instructions":"Is this income, such as pay, a salary, or interest?"}}}',
		);
	});

	it("tells Jev only the name, merchant, amount, direction and account type, and a note when there is one", async () => {
		const { calls, fetchImpl } = fakeFetch(() => ok(goodBody));
		await askJev(input, categories, "k", fetchImpl);
		const body = JSON.parse(String(calls[0]?.init.body));
		expect(body.state).toEqual({
			bank_description: "SQ *LOCAL BAKERY 4432",
			merchant: "Local Bakery",
			amount_cents: 1200,
			direction: "money out",
			account_type: "credit",
		});

		await askJev(
			{ ...input, displayName: null, amountCents: -5000 },
			categories,
			"k",
			fetchImpl,
		);
		const second = JSON.parse(String(calls[1]?.init.body));
		expect(second.state.merchant).toBeNull();
		expect(second.state.amount_cents).toBe(5000);
		expect(second.state.direction).toBe("money in");
	});

	it("sends merchant history as category names in state, without the earlier transaction details", async () => {
		const { calls, fetchImpl } = fakeFetch(() => ok(goodBody));
		await askJev(
			{ ...input, merchantCategoryHistory: [["Groceries"], ["Groceries"]] },
			categories,
			"k",
			fetchImpl,
		);
		const body = JSON.parse(String(calls[0]?.init.body));
		expect(body.state).toEqual({
			bank_description: "SQ *LOCAL BAKERY 4432",
			merchant: "Local Bakery",
			amount_cents: 1200,
			direction: "money out",
			account_type: "credit",
			merchant_category_history: [["Groceries"], ["Groceries"]],
		});
		expect(body.questions.category.instructions).toContain(
			"use them as context for this category guess",
		);
	});

	it("adds the note a person wrote, so it can help the transaction sort (decision 64), and nothing when there is none", async () => {
		const { calls, fetchImpl } = fakeFetch(() => ok(goodBody));
		await askJev(
			{ ...input, note: "Birthday cake for Sam" },
			categories,
			"k",
			fetchImpl,
		);
		await askJev({ ...input, note: "" }, categories, "k", fetchImpl);
		await askJev({ ...input, note: null }, categories, "k", fetchImpl);
		const states = calls.map(
			(call) => JSON.parse(String(call.init.body)).state,
		);
		expect(states[0].note).toBe("Birthday cake for Sam");
		expect(states[1]).not.toHaveProperty("note");
		expect(states[2]).not.toHaveProperty("note");
	});

	it("includes Plaid's category hint when present", async () => {
		const { calls, fetchImpl } = fakeFetch(() => ok(goodBody));
		await askJev(
			{ ...input, plaidCategory: "FOOD_AND_DRINK" },
			categories,
			"k",
			fetchImpl,
		);
		const body = JSON.parse(String(calls[0]?.init.body));
		expect(body.state.plaid_category).toBe("FOOD_AND_DRINK");
	});

	it("parses the category pick and the flag probabilities", async () => {
		const { fetchImpl } = fakeFetch(() => ok(goodBody));
		expect(await askJev(input, categories, "k", fetchImpl)).toEqual({
			ok: true,
			answer: {
				category: { label: "Eating Out", confidence: 0.93 },
				flags: { transfer: 0.02, reimbursement: 0.01, income: 0.03 },
			},
		});
	});

	it.each([401, 403, 422, 429, 500, 529])(
		"returns a failure for HTTP %i with the request id, never throwing",
		async (status) => {
			const { fetchImpl } = fakeFetch(
				() =>
					new Response("{}", {
						status,
						headers: { "x-typesafe-request-id": "req_123" },
					}),
			);
			expect(await askJev(input, categories, "k", fetchImpl)).toEqual({
				ok: false,
				status,
				requestId: "req_123",
			});
		},
	);

	it("returns a failure when the request can't be made or times out", async () => {
		const { fetchImpl } = fakeFetch(() => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		});
		expect(await askJev(input, categories, "k", fetchImpl)).toEqual({
			ok: false,
			status: null,
			requestId: null,
		});
	});

	it("passes a timeout signal to fetch", async () => {
		const { calls, fetchImpl } = fakeFetch(() => ok(goodBody));
		await askJev(input, categories, "k", fetchImpl);
		expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
	});

	it("treats a category that wasn't one of the options as a malformed answer", async () => {
		const { fetchImpl } = fakeFetch(() =>
			ok({
				...goodBody,
				answers: {
					...goodBody.answers,
					category: { type: "choice", choice: "Travel", confidence: 0.9 },
				},
			}),
		);
		expect(await askJev(input, categories, "k", fetchImpl)).toEqual({
			ok: false,
			status: 200,
			requestId: null,
		});
	});

	it("accepts None of these fit as an answer", async () => {
		const { fetchImpl } = fakeFetch(() =>
			ok({
				...goodBody,
				answers: {
					...goodBody.answers,
					category: { type: "choice", choice: NONE_FIT, confidence: 0.9 },
				},
			}),
		);
		const result = await askJev(input, categories, "k", fetchImpl);
		expect(result.ok && result.answer.category.label).toBe(NONE_FIT);
	});

	it("treats a malformed answer as a failure", async () => {
		const { fetchImpl } = fakeFetch(() =>
			ok({ answers: { category: { type: "choice", choice: 3 } } }),
		);
		expect(await askJev(input, categories, "k", fetchImpl)).toEqual({
			ok: false,
			status: 200,
			requestId: null,
		});
	});

	it("starts with a threshold of 0.80", () => {
		expect(JEV_THRESHOLD).toBe(0.8);
	});
});

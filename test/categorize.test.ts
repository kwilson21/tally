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

	it("tells Jev only the name, merchant, amount, direction and account type", async () => {
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

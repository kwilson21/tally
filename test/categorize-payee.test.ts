import { describe, expect, it } from "vitest";
import { askJev, PAYEE_QUESTION } from "../src/ai/categorize";

const input = {
	rawName: "APPLE.COM/BILL",
	displayName: null,
	amountCents: 999,
	accountType: "credit",
};

const categories = ["Groceries", "Eating Out"];

/** A Jev reply with a category, the flags and, when given, a payee answer. */
const reply = (payee?: {
	type: string;
	choice: string;
	confidence: number;
}) => {
	const base = {
		category: { type: "choice", choice: "Eating Out", confidence: 0.9 },
		transfer: { type: "noul", noul: 0.01 },
		reimbursement: { type: "noul", noul: 0.01 },
		income: { type: "noul", noul: 0.01 },
	};

	const answers = payee ? { ...base, payee } : base;

	return new Response(JSON.stringify({ answers }), { status: 200 });
};

/** Records the body sent to Jev, and answers with the given reply. */
function recordingFetch(respond: () => Response) {
	const bodies: string[] = [];

	const fetchImpl = async (_url: string, init?: RequestInit) => {
		bodies.push(String(init?.body));

		return respond();
	};

	return { bodies, fetchImpl };
}

describe("the payee question", () => {
	it("is asked only when payee is set, and is the question the comparison script measured", async () => {
		const { bodies, fetchImpl } = recordingFetch(() => reply());
		await askJev(input, categories, "k", fetchImpl, { payee: true });

		const body = JSON.parse(bodies[0] ?? "{}");
		expect(body.questions.payee).toEqual(PAYEE_QUESTION);
		expect(PAYEE_QUESTION.criteria).toEqual({
			business: "A shop, company, organisation or service.",
			person: "A private individual.",
		});
	});

	it("leaves the body byte-for-byte as before when payee is not set", async () => {
		const plain = recordingFetch(() => reply());
		await askJev(input, categories, "k", plain.fetchImpl);

		const off = recordingFetch(() => reply());
		await askJev(input, categories, "k", off.fetchImpl, { payee: false });

		expect(off.bodies[0]).toBe(plain.bodies[0]);
		expect(JSON.parse(plain.bodies[0] ?? "{}").questions).not.toHaveProperty(
			"payee",
		);
	});

	it("reads a business or a person answer with its confidence", async () => {
		const business = await askJev(
			input,
			categories,
			"k",
			recordingFetch(() =>
				reply({ type: "choice", choice: "business", confidence: 0.93 }),
			).fetchImpl,
			{ payee: true },
		);

		expect(business).toMatchObject({
			ok: true,
			answer: { payee: { label: "business", confidence: 0.93 } },
		});

		const person = await askJev(
			input,
			categories,
			"k",
			recordingFetch(() =>
				reply({ type: "choice", choice: "person", confidence: 0.4 }),
			).fetchImpl,
			{ payee: true },
		);

		expect(person).toMatchObject({
			ok: true,
			answer: { payee: { label: "person", confidence: 0.4 } },
		});
	});

	it("a missing or malformed payee answer leaves the rest of the answer as it was", async () => {
		const missing = await askJev(
			input,
			categories,
			"k",
			recordingFetch(() => reply()).fetchImpl,
			{ payee: true },
		);

		expect(missing).toMatchObject({
			ok: true,
			answer: { category: { label: "Eating Out" } },
		});
		expect(missing.ok && missing.answer.payee).toBeUndefined();

		const malformed = await askJev(
			input,
			categories,
			"k",
			recordingFetch(() =>
				reply({ type: "choice", choice: "shop", confidence: 0.9 }),
			).fetchImpl,
			{ payee: true },
		);

		expect(malformed).toMatchObject({
			ok: true,
			answer: { category: { label: "Eating Out" } },
		});
		expect(malformed.ok && malformed.answer.payee).toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";
import { askJev } from "../src/ai/categorize";
import type { JevAnswer } from "../src/ai/decide";
import { type JevSeen, jevInputOf } from "../src/db/transactions";
import {
	clearsForLookup,
	inputMark,
	markState,
	sha256Hex,
} from "../src/lookup/input-mark";

const seen: JevSeen = {
	rawName: "APPLE.COM/BILL",
	ownName: null,
	merchantKey: "apple",
	merchantName: null,
	suggestedNames: null,
	suggestionStatus: null,
	amountCents: 999,
	accountId: 1,
	accountType: "credit",
	plaidCategory: null,
	note: null,
	kind: null,
	forPersonId: null,
	forPersonName: null,
};

/** One value changed for each fact Jev is told, in JevSeen's key order. */
const changes: Partial<JevSeen>[] = [
	{ rawName: "APPLE.COM/BILL 2" },
	{ ownName: "Music" },
	{ merchantKey: "apple music" },
	{ merchantName: "Apple" },
	{ amountCents: 1000 },
	{ accountId: 2 },
	{ accountType: "checking" },
	{ plaidCategory: "Subscription" },
	{ note: "family plan" },
	{ kind: "subscription" },
	{ forPersonId: 3 },
	{ forPersonName: "Sam" },
];

const payee = (label: string, confidence: number) => ({ label, confidence });

/** A Jev answer whose flags are all unsure-free and low, so only the payee and the flag under test decide. */
function answer(
	flags: Partial<JevAnswer["flags"]> = {},
	payeeAnswer?: { label: string; confidence: number },
): JevAnswer {
	return {
		category: { label: "Eating Out", confidence: 0.9 },
		flags: {
			transfer: 0.01,
			reimbursement: 0.01,
			income: 0.01,
			...flags,
		},
		payee: payeeAnswer,
	};
}

describe("sha256Hex", () => {
	it("gives the SHA-256 of a known vector, so the fingerprint's hash is the standard one", async () => {
		expect(await sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("inputMark", () => {
	it("is the same for the same facts, and a 64-character hex text", async () => {
		const mark = await inputMark(seen);
		expect(mark).toMatch(/^[0-9a-f]{64}$/);
		expect(await inputMark({ ...seen })).toBe(mark);
	});

	it("changes when any one fact Jev is told changes, and each fact is listed once", async () => {
		// The suggestions and their status change the mark only through the name Jev is told (see the test below).
		expect(changes.flatMap((change) => Object.keys(change))).toEqual(
			Object.keys(seen).filter(
				(key) => key !== "suggestedNames" && key !== "suggestionStatus",
			),
		);
		const mark = await inputMark(seen);

		for (const change of changes) {
			expect(await inputMark({ ...seen, ...change })).not.toBe(mark);
		}
	});

	it("does not depend on a value's position in the object, so key order cannot change it", async () => {
		// SAFETY: reversing the entries keeps every key and value, so the object still has JevSeen's shape.
		const reordered = Object.fromEntries(
			Object.entries(seen).reverse(),
		) as JevSeen;

		expect(await inputMark(reordered)).toBe(await inputMark(seen));
	});
});

/** Every combination of own name, chosen name, suggestion status and suggestions, on one merchant whose key is "apple". */
function nameVariants(): JevSeen[] {
	const variants: JevSeen[] = [];

	for (const ownName of [null, "Corner Shop"])
		for (const merchantName of [null, "Chosen"])
			for (const suggestionStatus of [
				null,
				"none",
				"pending",
				"accepted",
				"rejected",
			])
				for (const suggestedNames of [
					null,
					'["apple"]',
					'["Tally Guess"]',
					'["apple","Tally Guess"]',
				])
					variants.push({
						...seen,
						ownName,
						merchantName,
						suggestionStatus,
						suggestedNames,
					});

	return variants;
}

/** The body askJev sends for a row, with no categories and the payee question on. */
async function bodyOf(row: JevSeen): Promise<string> {
	let sent = "";

	await askJev(
		jevInputOf(row),
		[],
		"test-key",
		async (_url, init) => {
			sent = String(init?.body);

			return new Response("{}", { status: 200 });
		},
		{ payee: true },
	);

	return sent;
}

describe("inputMark: the name Jev is told", () => {
	it("is equal for two rows exactly when the name Jev is told is equal", async () => {
		const variants = nameVariants();
		const marks = await Promise.all(variants.map((row) => inputMark(row)));

		const told = variants.map((row) => jevInputOf(row).displayName);

		for (let i = 0; i < variants.length; i++) {
			for (let j = i + 1; j < variants.length; j++) {
				expect(marks[i] === marks[j]).toBe(told[i] === told[j]);
			}
		}
	});

	it("gives equal requests for equal marks, so no fact Jev is told is left out of the hash", async () => {
		const variants = nameVariants();
		const marks = await Promise.all(variants.map((row) => inputMark(row)));
		const bodies = await Promise.all(variants.map((row) => bodyOf(row)));

		for (let i = 0; i < variants.length; i++) {
			for (let j = i + 1; j < variants.length; j++) {
				if (marks[i] === marks[j]) expect(bodies[i]).toBe(bodies[j]);
			}
		}
	});

	it("changes when the merchant key alone changes, since the search text is read from it", async () => {
		expect(await inputMark({ ...seen, merchantKey: "apple pay" })).not.toBe(
			await inputMark(seen),
		);
	});
});

describe("clearsForLookup", () => {
	it("clears for a business that Jev is sure of, with no flag at the threshold", () => {
		expect(clearsForLookup(answer({}, payee("business", 0.8)))).toBe(true);
	});

	it("does not clear for a person, for a business Jev is not sure of, or for a missing payee (BUG_PERSON_MARKS)", () => {
		expect(clearsForLookup(answer({}, payee("person", 0.99)))).toBe(false);
		expect(clearsForLookup(answer({}, payee("business", 0.79)))).toBe(false);
		expect(clearsForLookup(answer({}, undefined))).toBe(false);
	});

	it("does not clear when a transfer, income or reimbursement answer is at the threshold", () => {
		const business = payee("business", 0.95);

		expect(clearsForLookup(answer({ transfer: 0.8 }, business))).toBe(false);
		expect(clearsForLookup(answer({ income: 0.8 }, business))).toBe(false);
		expect(clearsForLookup(answer({ reimbursement: 0.8 }, business))).toBe(
			false,
		);
	});

	it("does not clear when the transfer, reimbursement or income answer is in its Maybe range", () => {
		const business = payee("business", 0.95);

		expect(clearsForLookup(answer({ transfer: 0.5 }, business))).toBe(false);
		expect(clearsForLookup(answer({ reimbursement: 0.5 }, business))).toBe(
			false,
		);
		expect(clearsForLookup(answer({ income: 0.5 }, business))).toBe(false);
		// The income range starts at 20%, so a 0.3 income answer is still unsure.
		expect(clearsForLookup(answer({ income: 0.3 }, business))).toBe(false);
	});

	it("clears when a transfer answer is below its Maybe range, which is not unsure", () => {
		expect(
			clearsForLookup(answer({ transfer: 0.3 }, payee("business", 0.95))),
		).toBe(true);
	});
});

describe("markState", () => {
	const mark = "abc";

	it("is owed when there is no row, and when the row's mark is not the current one (BUG_NO_FINGERPRINT)", () => {
		expect(markState(null, mark)).toBe("owed");
		expect(markState({ inputMark: "old", cleared: 1 }, mark)).toBe("owed");
		expect(markState({ inputMark: "old", cleared: 0 }, mark)).toBe("owed");
	});

	it("is cleared when the mark matches and the answer cleared", () => {
		expect(markState({ inputMark: mark, cleared: 1 }, mark)).toBe("cleared");
	});

	it("is asked, not owed, when the mark matches and the answer did not clear (BUG_PRIVACY_ASK_FOREVER)", () => {
		expect(markState({ inputMark: mark, cleared: 0 }, mark)).toBe("asked");
	});

	it("is owed again once a fact Jev was told changes, after a not-cleared answer (privacyAskedAgainAfterChange)", async () => {
		const first = await inputMark(seen);
		expect(markState({ inputMark: first, cleared: 0 }, first)).toBe("asked");

		const changed = await inputMark({ ...seen, note: "new note" });
		expect(markState({ inputMark: first, cleared: 0 }, changed)).toBe("owed");
	});
});

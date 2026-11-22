import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { cleanLine } from "../src/ai/lookup-store";
import { resetDemo } from "../src/demo/reset";
import {
	SEED_LINE_GUESSES,
	SEED_STORED_LOOKUP,
	seedMerchantKey,
} from "../src/demo/seed";
import { privateTextReason, lookupTextOf } from "../src/lookup/lookup-text";
import { suggestionQueue } from "../src/db/suggestions-queue";
import { getTransaction } from "../src/db/transactions";

// #988: the demo's two store lines and one stored lookup, added by the scheduled reset only (decision 216 and the plan, Task 8).

const TODAY = "2026-10-05";
const db = env.DB;

const count = async (table: string) =>
	(
		await db
			.prepare(`SELECT COUNT(*) AS n FROM ${table}`)
			.first<{ n: number }>()
	)?.n;

describe("resetDemo with storeLookups (#988)", () => {
	it("gives La Coop id 900 and Maple Street Hardware id 901, each a held Maybe the review asks about with its line", async () => {
		await resetDemo(db, TODAY, { categoryExample: true, storeLookups: true });

		const queue = await suggestionQueue(db);
		const laCoop = queue.find((i) => i.id === "category-900");
		const maple = queue.find((i) => i.id === "category-901");

		expect(laCoop).toMatchObject({
			kind: "category",
			category: "Eating Out",
			sure: 88,
			lookupLine: "Coffee shop in Arlington, VA",
		});
		expect(maple).toMatchObject({
			kind: "category",
			category: "Household",
			sure: 64,
			lookupLine: SEED_LINE_GUESSES[1].line,
		});
		expect(queue[0]?.id).toBe("category-900");

		const detail = await getTransaction(db, 901);

		expect(detail?.lineGuess).toBe(true);
		expect(detail?.lookupLine).toBe(SEED_LINE_GUESSES[1].line);
	});

	it("each stored text is the key's own lookup text and is not private", async () => {
		await resetDemo(db, TODAY, { categoryExample: true, storeLookups: true });

		for (const guess of SEED_LINE_GUESSES) {
			const row = await db
				.prepare(
					"SELECT lookup_text AS lookupText, private FROM merchant_lookup_texts WHERE merchant_key = ?",
				)
				.bind(guess.rawName)
				.first<{ lookupText: string; private: number }>();

			expect(row?.lookupText).toBe(lookupTextOf(guess.rawName));
			expect(row?.lookupText.length).toBeGreaterThan(0);
			expect(row?.private).toBe(0);
			expect(privateTextReason(guess.rawName)).toBeNull();
		}
	});

	it("each seeded line is one the lookup would keep, and the long one is 80 characters", async () => {
		for (const guess of SEED_LINE_GUESSES) {
			expect(cleanLine(guess.line)).toBe(guess.line);
		}

		expect(SEED_LINE_GUESSES[1].line).toHaveLength(80);
	});

	it("holds three stored lookups, one with no guess", async () => {
		await resetDemo(db, TODAY, { categoryExample: true, storeLookups: true });

		expect(await count("merchant_lookups")).toBe(3);
		const stored = await db
			.prepare("SELECT line FROM merchant_lookups WHERE lookup_text = ?")
			.bind(lookupTextOf(seedMerchantKey(SEED_STORED_LOOKUP.rawName)))
			.first<{ line: string }>();

		expect(stored?.line).toBe(SEED_STORED_LOOKUP.line);
	});

	it("running it twice gives the same rows", async () => {
		await resetDemo(db, TODAY, { categoryExample: true, storeLookups: true });
		const first = await count("merchant_lookups");

		await resetDemo(db, TODAY, { categoryExample: true, storeLookups: true });

		expect(await count("merchant_lookups")).toBe(first);
		expect((await getTransaction(db, 900))?.lookupLine).toBe(
			SEED_LINE_GUESSES[0].line,
		);
	});

	it("without the option no lookup table has a row, and ids 900 and 901 do not exist", async () => {
		await resetDemo(db, TODAY, { categoryExample: true });

		expect(await count("merchant_lookups")).toBe(0);
		expect(await count("lookup_answers")).toBe(0);
		expect(await count("merchant_lookup_texts")).toBe(0);
		expect(await getTransaction(db, 900)).toBeNull();
		expect(await getTransaction(db, 901)).toBeNull();
	});
});

import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, expect } from "vitest";
import { cleanBankText } from "../src/clean-bank-text";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { suggestionQueue } from "../src/db/suggestions-queue";
import type { saveEdit } from "../src/db/transactions";
import { getTransaction, pendingForJev } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { lookupTextOf } from "../src/lookup/lookup-text";
import { present } from "./helpers/present";

// The shared setup of the store lookup's line clear (migration 0079, spec §7 "One answer corrects the whole store").
// A helper, not a test file. Keys and texts: K1 and K2 share one lookup text (TEXT) but clean differently, so a sibling
// is a row of another key that the same lookup text reaches. OTHER is a different store with its own text.

export const db = env.DB;
export const TODAY = "2026-11-15";
export const WHO = "person@example.com";
export const K1 = "Lupitas Taqueria";
export const K2 = "LUPITAS TAQUERIA MEMBER1234";
export const K3 = "LUPITAS TAQUERIA #4567";
export const OTHER = "Harbor Bakery";
export const TEXT = lookupTextOf(K1);
export const OTHER_TEXT = lookupTextOf(OTHER);
export const LINE = "A taqueria on Main Street";

/** The two category ids the fixture uses, read from the demo at each reset. */
export let EATING = 0;
export let GROCERIES = 0;

let plaidSeq = 0;

/** The edit panel's input, with every field saveEdit reads set to its no-change value. */
export const edit = (over: Partial<Parameters<typeof saveEdit>[2]> = {}) => ({
	categoryId: null,
	alwaysForMerchant: false,
	displayName: null,
	note: null,
	excluded: false,
	income: false,
	creditReviewed: true,
	...over,
});

/** The Set category save the select mode posts for `ids`, through the route (W1 and the tests that file rows by it). */
export async function setCategory(ids: number[], category: number) {
	const body = new URLSearchParams({
		category: String(category),
		back: "/transactions?month=all",
	});

	for (const id of ids) body.append("ids", String(id));

	const res = await exports.default.fetch("http://tally.test/transactions/select/category/save", {
		method: "POST",
		body,
		headers: {
			Origin: "http://tally.test",
			"HX-Request": "true",
		},
	});

	expect(res.status).toBe(200);
}

async function categoryId(name: string): Promise<number> {
	const row = await db
		.prepare("SELECT id FROM categories WHERE name = ?")
		.bind(name)
		.first<{ id: number }>();

	return present(row).id;
}

/**
 * Inserts one ordinary purchase (positive is money out, Plaid's sign) and returns its id. The values override the defaults.
 * Each row gets its own Plaid id, so a posted row is never confused with a sync's.
 */
export async function insertTx(values: Record<string, string | number | null>): Promise<number> {
	plaidSeq += 1;

	const row = {
		account_id: 1,
		date: TODAY,
		amount_cents: 1200,
		raw_name: K1,
		plaid_transaction_id: `line-${plaidSeq}`,
		plaid_category: "FOOD_AND_DRINK",
		...values,
	};

	const columns = Object.keys(row);

	const inserted = await db
		.prepare(
			`INSERT INTO transactions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) RETURNING id`,
		)
		.bind(...Object.values(row))
		.first<{ id: number }>();

	return present(inserted).id;
}

/** How a row's lookup answer stands: 1 when the line-backed guess was kept, "stale" for a kept answer whose copy is older, 0 when not kept. */
export type LineKind = "k1" | "stale" | "k0";

/**
 * A posted purchase under `key` that Jev sorted to Eating Out with the line (a Maybe at `confidence`), with its lookup_answers row
 * under the key's lookup text. "stale" copies Eating Out at 0.05 less than the row holds. `filed: "jev"` files it to Eating Out
 * from Jev instead (no guess left). `attempts` sets jev_attempts (5 is given up).
 */
export async function lineRow({
	key,
	confidence = 0.9,
	line = "k1",
	filed,
	attempts = 0,
}: {
	key: string;
	confidence?: number;
	line?: LineKind;
	filed?: "jev";
	attempts?: number;
}): Promise<number> {
	const eating = EATING;
	const id = await insertTx({
		raw_name: key,
		merchant_name: key,
		jev_category_id: eating,
		jev_mixed: 0.6,
		jev_also_category_id: GROCERIES,
		category_confidence: confidence,
		jev_attempts: attempts,
		...(filed === "jev"
			? { category_id: eating, category_source: "jev" }
			: {}),
	});

	const copy = line === "stale" ? Math.round((confidence - 0.05) * 100) / 100 : confidence;

	await db
		.prepare(
			"INSERT INTO lookup_answers (transaction_id, lookup_text, kept, kept_category_id, kept_confidence) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(id, lookupTextOf(key), line === "k0" ? 0 : 1, eating, copy)
		.run();

	return id;
}

/** A row a person (or a rule) filed before the line rows exist: the trigger must see it first (the order rule). */
export async function filedRow(key: string, categoryId: number, source: "user" | "merchant_rule" = "user"): Promise<number> {
	return insertTx({
		raw_name: key,
		merchant_name: key,
		category_id: categoryId,
		category_source: source,
	});
}

/** The row and its lookup answer as stored. */
export async function rowOf(id: number) {
	const tx = await db
		.prepare("SELECT * FROM transactions WHERE id = ?")
		.bind(id)
		.first<Record<string, unknown>>();

	const answer = await db
		.prepare(
			"SELECT transaction_id, lookup_text, kept, kept_category_id, kept_confidence FROM lookup_answers WHERE transaction_id = ?",
		)
		.bind(id)
		.first<{
			transaction_id: number;
			lookup_text: string;
			kept: number;
			kept_category_id: number | null;
			kept_confidence: number | null;
		}>();

	return { tx: present(tx), answer: answer ?? null };
}

/** Whether the row is asked again: pendingForJev returns it (the category branch, spec §7). */
export async function asksAgain(id: number): Promise<boolean> {
	const rows = await pendingForJev(db, 50, { ids: [id] });

	return rows.some((row) => row.id === id);
}

/** The row's Maybe reads: getTransaction's lineGuess flag, the one the edit panel reads. */
export async function lineGuessOf(id: number): Promise<boolean> {
	return present(await getTransaction(db, id)).lineGuess === true;
}

/** Whether the review queue holds this row's category card. */
export async function inQueue(id: number): Promise<boolean> {
	const queue = await suggestionQueue(db);

	return queue.some((card) => card.id === `category-${id}`);
}

/** The five columns a clear sets, read from the row, so a test can compare them with their cleared values. */
export const CLEAR_COLUMNS = [
	"category_confidence",
	"jev_category_id",
	"jev_mixed",
	"jev_also_category_id",
	"jev_none_fit",
] as const;

/** The guard that holds a sibling to the cleared state: its five columns are NULL (0 for jev_none_fit) and its answer is not kept. */
export async function expectCleared(id: number) {
	const { tx, answer } = await rowOf(id);

	for (const column of CLEAR_COLUMNS) {
		expect(tx[column] ?? null, column).toBe(column === "jev_none_fit" ? 0 : null);
	}

	expect(answer?.kept).toBe(0);
}

/**
 * The fixture every line test shares: a demo reset, every switch on, no lookup texts or answers left, then the three texts
 * (K1, K2 and OTHER) and found lines for TEXT and OTHER_TEXT. K3 has no text row, for test 7. Call once at the top of a test file.
 */
export function useLineFixture() {
	beforeAll(() => {
		expect(lookupTextOf(K2)).toBe(TEXT);
		expect(cleanBankText(K2)).not.toBe(cleanBankText(K1));
		expect(lookupTextOf(K3)).toBe(TEXT);
		expect(OTHER_TEXT).not.toBe(TEXT);
	});

	beforeEach(async () => {
		plaidSeq = 0;

		await resetDemo(db, TODAY);
		await db.batch([
			db.prepare("DELETE FROM lookup_answers"),
			db.prepare("DELETE FROM merchant_lookup_texts"),
			db.prepare("DELETE FROM merchant_lookups"),
		]);
		await saveAiSwitches(db, AI_SWITCHES_ALL_ON);

		EATING = await categoryId("Eating Out");
		GROCERIES = await categoryId("Groceries");

		await db.batch([
			db
				.prepare(
					"INSERT INTO merchant_lookup_texts (merchant_key, lookup_text, private) VALUES (?, ?, 0), (?, ?, 0), (?, ?, 0)",
				)
				.bind(K1, TEXT, K2, TEXT, OTHER, OTHER_TEXT),
			db
				.prepare(
					"INSERT INTO merchant_lookups (lookup_text, status, line, attempts) VALUES (?, 'found', ?, 0), (?, 'found', ?, 0)",
				)
				.bind(TEXT, LINE, OTHER_TEXT, LINE),
		]);
	});
}

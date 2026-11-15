import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { merchantKeySql } from "../src/db/merchant-key";
import { maybeFacts, moneyMaybeStatements } from "../src/db/suggestion-saves";
import { askedSql } from "../src/db/suggestions-queue";
import { saveEdit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { lookupTextOf } from "../src/lookup/lookup-text";
import { fillLookupTexts, readLookupTexts } from "../src/lookup/texts";
import { type SortEnv, sortGroups } from "../src/sort-groups";
import { fakeSteps } from "./fake-sort-steps";

// The private mark kept by the writes (migration 0077): two triggers on transactions set a key's private mark to 1 in the
// same statement that puts a row in one of the fill's private states. The fill (fillLookupTexts) is the only writer of a 0.
// Every expected mark here is the fill's own decision (readLookupTexts), never a value written in the test.

const db = env.DB;
const TODAY = "2026-09-22";
const WHO = "person@example.com";
const ENV: SortEnv = { DB: db, JEV_API_KEY: "test-key" };

let food = 0;
let runCount = 0;

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await db.prepare("DELETE FROM merchant_lookup_texts").run();
	await saveAiSwitches(db, AI_SWITCHES_ALL_ON);

	const categories = await db
		.prepare("SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1")
		.all<{ id: number }>();

	food = Number(categories.results[0]?.id);
});

/** Inserts one ordinary purchase (positive is money out, Plaid's sign) and returns its id. Values override the defaults. */
async function addRow(values: Record<string, string | number | null> = {}) {
	const row = {
		account_id: 1,
		date: TODAY,
		amount_cents: 1200,
		raw_name: "PRIVATE MARK STORE",
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

	return Number(inserted?.id);
}

/** Sets a key's row as the fill would have left it at `mark`, with the key's own lookup text. */
async function setKey(key: string, mark: 0 | 1) {
	await db
		.prepare(
			"INSERT OR REPLACE INTO merchant_lookup_texts (merchant_key, lookup_text, private) VALUES (?, ?, ?)",
		)
		.bind(key, lookupTextOf(key), mark)
		.run();
}

/** The stored private mark of a key, or undefined when the key has no row. */
async function markOf(key: string): Promise<number | undefined> {
	const row = await db
		.prepare("SELECT private FROM merchant_lookup_texts WHERE merchant_key = ?")
		.bind(key)
		.first<{ private: number }>();

	return row?.private;
}

/** The fill's decision for a key, read over every row (never a value written in a test). */
async function fillMark(key: string): Promise<number | undefined> {
	const read = await readLookupTexts(db);

	return read.keys.find(({ row }) => row.merchantKey === key)?.row.private;
}

/**
 * A Jev reply: Eating Out, the transfer guess the case gives, and every details answer the app asks for with its switches on
 * (kind, person, note). Without the details answers the ask fails validation (askJev) and the row is never written.
 */
function jevReply(transfer: number) {
	return new Response(
		JSON.stringify({
			answers: {
				category: { type: "choice", choice: "Eating Out", confidence: 0.9 },
				transfer: { type: "noul", noul: transfer },
				reimbursement: { type: "noul", noul: 0.01 },
				income: { type: "noul", noul: 0.01 },
				kind: { type: "choice", choice: "one_off", confidence: 0.9 },
				for_person: { type: "choice", choice: "none", confidence: 0.9 },
				note_worth_writing: { type: "noul", noul: 0.01 },
			},
		}),
		{ status: 200 },
	);
}

/** One row change the trigger must agree with the fill about: a column and the value it takes. */
type Change = [label: string, column: string, value: number | string];

const CONFIDENCES = [
	0.1999, 0.2, 0.2001, 0.3999, 0.4, 0.4001, 0.7999, 0.8, 0.95,
] as const;

/** Every fact the fill's row test reads, one at a time, each from an ordinary row. */
const CHANGES: Change[] = [
	["flag_transfer", "flag_transfer", 1],
	["flag_income", "flag_income", 1],
	["flag_reimbursement", "flag_reimbursement", 1],
	["kind transfer", "kind", "transfer"],
	["kind subscription", "kind", "subscription"],
	["kind one_off", "kind", "one_off"],
	["kind bill", "kind", "bill"],
	["excluded", "excluded", 1],
	...CONFIDENCES.flatMap((confidence): Change[] => [
		[`transfer_confidence ${confidence}`, "transfer_confidence", confidence],
		[`income_confidence ${confidence}`, "income_confidence", confidence],
	]),
];

/** The trigger's SQL as SQLite stores it. */
async function triggerSql(name: string): Promise<string> {
	const row = await db
		.prepare(
			"SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
		)
		.bind(name)
		.first<{ sql: string }>();

	return row?.sql ?? "";
}

describe("the update trigger agrees with the fill", () => {
	// 1. D1 counts the trigger's write in meta.changes (every transactions-write reader compares it with 0; audited 2026-11-15).
	it("1. D1 counts the trigger's write in meta.changes: the flip 0 to 1 reports 2, and the mark is 1", async () => {
		const key = "COUNT STORE";
		const id = await addRow({ raw_name: key });
		await setKey(key, 0);

		const flip = await db
			.prepare("UPDATE transactions SET flag_transfer = 1 WHERE id = ?")
			.bind(id)
			.run();

		expect(flip.meta.changes).toBe(2);
		expect(await markOf(key)).toBe(1);
	});

	it("1. D1 counts the trigger's write in meta.changes: the same UPDATE on a key already at 1 reports 1", async () => {
		const key = "COUNT STORE ALREADY";
		const id = await addRow({ raw_name: key });
		await setKey(key, 1);

		const again = await db
			.prepare("UPDATE transactions SET flag_transfer = 1 WHERE id = ?")
			.bind(id)
			.run();

		expect(again.meta.changes).toBe(1);
		expect(await markOf(key)).toBe(1);
	});

	// 2. The update trigger, as a full table: each one fact changed on an ordinary row.
	it.each(CHANGES)(
		"2. %s: the update trigger's mark is the fill's",
		async (_label, column, value) => {
			const key = `UPDATE STORE ${column} ${value}`;
			const id = await addRow({ raw_name: key });
			await setKey(key, 0);

			await db
				.prepare(`UPDATE transactions SET ${column} = ? WHERE id = ?`)
				.bind(value, id)
				.run();

			expect(await markOf(key)).toBe(await fillMark(key));
		},
	);

	// 3. The insert trigger, as a full table: the same facts, on a second row of the key inserted with the fact.
	it.each(CHANGES)(
		"3. %s: the insert trigger's mark is the fill's",
		async (_label, column, value) => {
			const key = `INSERT STORE ${column} ${value}`;
			await addRow({ raw_name: key });
			await setKey(key, 0);

			await addRow({ raw_name: key, [column]: value });

			expect(await markOf(key)).toBe(await fillMark(key));
		},
	);

	// 4. Drift: the migration's SQL carries the TypeScript ranges and the key, so a change in one place fails here.
	it("4. each trigger's WHEN names the transfer and income ranges and the merchant key, from the TypeScript", async () => {
		const required = [
			askedSql("transfer", "NEW.transfer_confidence"),
			askedSql("income", "NEW.income_confidence"),
			merchantKeySql("NEW"),
		];

		for (const name of [
			"lookup_private_mark_insert",
			"lookup_private_mark_update",
		]) {
			const sql = await triggerSql(name);

			expect(sql).not.toBe("");

			for (const fragment of required) expect(sql).toContain(fragment);
		}
	});

	it("4. the update trigger listens to the nine columns the fill reads, and no others", async () => {
		const sql = await triggerSql("lookup_private_mark_update");

		const columns = sql
			.match(/AFTER UPDATE OF\s+([\s\S]+?)\s+ON transactions/)?.[1]
			?.split(",")
			.map((column) => column.trim())
			.sort();

		expect(columns).toEqual(
			[
				"flag_transfer",
				"flag_income",
				"flag_reimbursement",
				"kind",
				"excluded",
				"transfer_confidence",
				"income_confidence",
				"merchant_name",
				"raw_name",
			].sort(),
		);
	});

	// 5. The key: a blank merchant name is the bank text's key, as merchantKeySql gives it.
	it.each([
		["a null merchant name", null, "KEY RAW NULL"],
		["an empty merchant name", "", "KEY RAW EMPTY"],
		["a merchant name", "Harbor Bakery", "KEY RAW NAMED"],
	])(
		"5. %s: the mark lands on the key merchantKeySql gives",
		async (_label, merchantName, raw) => {
			const expected = merchantName ? merchantName : raw;

			await setKey(raw, 0);
			await setKey(expected, 0);

			const id = await addRow({
				raw_name: raw,
				merchant_name: merchantName,
				flag_transfer: 1,
			});

			expect(id).toBeGreaterThan(0);
			expect(await markOf(expected)).toBe(1);

			if (expected !== raw) expect(await markOf(raw)).toBe(0);
		},
	);

	// 6. Scope: only the row's own key, and only its key, and the transaction row is not changed.
	it("6. a key with no row gets none, and no transaction is inserted", async () => {
		const key = "NO ROW STORE";

		const before = await db
			.prepare("SELECT COUNT(*) AS n FROM transactions")
			.first<{ n: number }>();

		const id = await addRow({ raw_name: key });

		await db
			.prepare("UPDATE transactions SET flag_transfer = 1 WHERE id = ?")
			.bind(id)
			.run();

		expect(await markOf(key)).toBeUndefined();

		const after = await db
			.prepare("SELECT COUNT(*) AS n FROM transactions")
			.first<{ n: number }>();

		expect(after?.n).toBe((before?.n ?? 0) + 1);
	});

	it("6. another key's row, even one sharing the lookup text, stays 0", async () => {
		await db
			.prepare(
				"INSERT OR REPLACE INTO merchant_lookup_texts (merchant_key, lookup_text, private) VALUES (?, ?, 0), (?, ?, 0)",
			)
			.bind("SHARED TEXT ONE", "shared text", "SHARED TEXT TWO", "shared text")
			.run();
		const id = await addRow({ raw_name: "SHARED TEXT ONE" });

		await db
			.prepare("UPDATE transactions SET flag_transfer = 1 WHERE id = ?")
			.bind(id)
			.run();

		expect(await markOf("SHARED TEXT ONE")).toBe(1);
		expect(await markOf("SHARED TEXT TWO")).toBe(0);
	});

	it("6. the transaction row is otherwise unchanged, apart from the column written", async () => {
		const key = "ROW UNCHANGED STORE";
		await setKey(key, 0);
		const id = await addRow({ raw_name: key, note: "a note" });

		const rowOf = () =>
			db
				.prepare(
					"SELECT id, raw_name, amount_cents, note, merchant_name, plaid_category, flag_transfer, flag_income, excluded, kind FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first<{
					id: number;
					raw_name: string;
					amount_cents: number;
					note: string | null;
					merchant_name: string | null;
					plaid_category: string | null;
					flag_transfer: number;
					flag_income: number;
					excluded: number;
					kind: string | null;
				}>();

		const before = await rowOf();

		await db
			.prepare("UPDATE transactions SET flag_transfer = 1 WHERE id = ?")
			.bind(id)
			.run();

		expect(await rowOf()).toEqual({ ...before, flag_transfer: 1 });
	});
});

describe("the mark only rises between fills", () => {
	// 7. Only raises: a cleared flag does not clear the mark; the fill does.
	it("7. a cleared flag leaves the mark at 1, and the fill sets it back to 0", async () => {
		const key = "ONLY RAISES STORE";
		await setKey(key, 0);
		const id = await addRow({ raw_name: key });

		await db
			.prepare("UPDATE transactions SET flag_transfer = 1 WHERE id = ?")
			.bind(id)
			.run();
		await db
			.prepare("UPDATE transactions SET flag_transfer = 0 WHERE id = ?")
			.bind(id)
			.run();

		expect(await markOf(key)).toBe(1);

		await fillLookupTexts(db);

		expect(await markOf(key)).toBe(0);
	});
});

describe("BUG_STALE_PRIVATE_MARK: the real save paths, with no fill run", () => {
	it("8. a person's Yes on a Maybe transfer sets the mark", async () => {
		const key = "MAYBE YES STORE";
		const id = await addRow({ raw_name: key, transfer_confidence: 0.6 });
		await setKey(key, 0);
		const facts = await maybeFacts(db, "transfer", id);

		await db.batch(
			moneyMaybeStatements(db, {
				kind: "transfer",
				answer: "yes",
				transactionId: id,
				today: TODAY,
				who: WHO,
				confidence: facts.confidence ?? 0,
				expectedVersion: facts.version,
			}),
		);

		expect(await markOf(key)).toBe(1);
	});

	it("8. saveEdit with the row excluded sets the mark", async () => {
		const key = "EDIT EXCLUDE STORE";
		const id = await addRow({ raw_name: key });
		await setKey(key, 0);

		await saveEdit(
			db,
			id,
			{
				categoryId: food,
				alwaysForMerchant: false,
				displayName: null,
				note: null,
				excluded: true,
				income: false,
				creditReviewed: false,
			},
			WHO,
		);

		expect(await markOf(key)).toBe(1);
	});

	it("8. saveEdit with the income box set sets the mark", async () => {
		const key = "EDIT INCOME STORE";
		const id = await addRow({ raw_name: key, amount_cents: -1200 });
		await setKey(key, 0);

		await saveEdit(
			db,
			id,
			{
				categoryId: food,
				alwaysForMerchant: false,
				displayName: null,
				note: null,
				excluded: false,
				income: true,
				creditReviewed: false,
			},
			WHO,
		);

		expect(await markOf(key)).toBe(1);
	});

	it("8. saveEdit with kind transfer sets the mark", async () => {
		const key = "EDIT KIND STORE";
		const id = await addRow({ raw_name: key });
		await setKey(key, 0);

		await saveEdit(
			db,
			id,
			{
				categoryId: food,
				alwaysForMerchant: false,
				displayName: null,
				note: null,
				excluded: false,
				income: false,
				creditReviewed: false,
				kind: "transfer",
				kindWas: null,
			},
			WHO,
		);

		expect(await markOf(key)).toBe(1);
	});

	it("8. Jev's sure transfer (0.9), through sortGroups, sets the mark", async () => {
		const key = "JEV SURE STORE";
		const id = await addRow({ raw_name: key });
		await setKey(key, 0);
		runCount += 1;
		const fake = fakeSteps();

		await sortGroups(ENV, fake.runStep, async () => jevReply(0.9), {
			rulesApplied: true,
			onlyIds: [id],
			runId: `run-private-mark-${runCount}`,
		});

		expect(await markOf(key)).toBe(1);
	});

	it("8. Jev's Maybe transfer (0.5), through sortGroups, sets the mark", async () => {
		const key = "JEV MAYBE STORE";
		const id = await addRow({ raw_name: key });
		await setKey(key, 0);
		runCount += 1;
		const fake = fakeSteps();

		await sortGroups(ENV, fake.runStep, async () => jevReply(0.5), {
			rulesApplied: true,
			onlyIds: [id],
			runId: `run-private-mark-${runCount}`,
		});

		expect(await markOf(key)).toBe(1);
	});
});

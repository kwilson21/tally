// The first week's record (spec §5, §8.8, decision 114): one `household_settings` row, `first_tally`, holding JSON. It
// keeps the household day each of the five strokes was drawn, the budgets step's one-at-a-time answers (skips included),
// and the counts of the first night after stroke four. A household set up before the feature shipped has all five
// strokes drawn with no day (migration 0057), so it reads as set up.

import type { PayDeposit } from "../first-tally/pay";

/** The five strokes of the first week (P125 E): link a bank, your pay, your bills, your budgets, and the night's count. */
export const STROKES = ["bank", "pay", "bills", "budgets", "count"] as const;
export type Stroke = (typeof STROKES)[number];

/**
 * One budgets answer, kept as it was given: the suggestion accepted, another amount typed, or the category skipped
 * (no amount). Keyed by category id in the record.
 */
export type BudgetAnswer =
	| { kind: "suggested" | "another"; cents: number }
	| { kind: "skipped"; cents: null };

export type NightCounts = {
	/** Transactions the first night's sync brought in. */
	brought: number;
	/** Of the household's, how many still ask something of a person once the night's sorting has run. */
	needYou: number;
};

/** The pay step's answer for one merchant: Yes, it's the family's pay, or No, it isn't (spec §8.8). */
export type PayAnswer = "yes" | "no";

/** The deposits one answer covered, each by its transaction id (a string key, since the record is JSON). */
export type PayDeposits = Record<string, PayDeposit>;

/**
 * One merchant's pay answers as recorded: the deposits answered Yes (`yes`) and the deposits answered No (`no`), each by
 * its transaction id, and `at`, the merchant's place in the order the merchants were first answered (0 for the first; a
 * merchant answered again keeps its place). The ledger reads the Yes deposits, so a change made later elsewhere adds
 * nothing to the line, and it sorts the lines by `at`.
 */
export type PayRecord = { yes?: PayDeposits; no?: PayDeposits; at: number };

/** What one answer writes into a merchant's record: its Yes deposits, or its No deposits (the other key is left as it is). */
export type PayAnswerRecord = Pick<PayRecord, "yes"> | Pick<PayRecord, "no">;

/** What the bills step kept: how many bills, and their monthly total in cents, added to as each bill is kept. */
export type BillsKept = { kept: number; cents: number };

export type FirstTally = {
	/**
	 * A stroke is drawn when it has a key here: its household day (YYYY-MM-DD), or null when drawn with no day known
	 * (a household set up before the feature shipped). A stroke drawn once keeps its first day.
	 */
	strokes: Partial<Record<Stroke, string | null>>;
	/** The budgets step's answers so far, by category id. */
	budgets: Record<string, BudgetAnswer>;
	/** The first night after stroke four, kept once that night's sorting has all finished. */
	night?: NightCounts;
	/**
	 * The pay step's answers so far, by merchant key (the store's raw name): the deposits each merchant answered Yes or No,
	 * and its place (`at`). A merchant asked again adds its new deposits to them (payAnswerStatement).
	 */
	pay?: Record<string, PayRecord>;
	/** What the bills step kept so far, added to as each bill is kept (keptBillStatement); absent until one is. */
	bills?: BillsKept;
};

const KEY = "first_tally";

/** The record as it is stored, or null before the first week has anything written. */
export async function readFirstTally(
	db: D1Database,
): Promise<FirstTally | null> {
	const row = await db
		.prepare("SELECT value FROM household_settings WHERE key = ?")
		.bind(KEY)
		.first<{ value: string }>();
	return row ? (JSON.parse(row.value) as FirstTally) : null;
}

/**
 * The record before the first week has anything written: the shape migration 0057 and readFirstTally expect. Each setter
 * below starts from it on the first write, so the record is always the same shape.
 */
const EMPTY_RECORD = '{"strokes":{},"budgets":{}}';

/** True once all five strokes are drawn, whether or not they carry a day. */
export function isSetUp(record: FirstTally | null): boolean {
	return STROKES.every((stroke) => record?.strokes[stroke] !== undefined);
}

/** True once the three questions are answered (pay, bills and budgets drawn): only the night's count stroke is left. */
export function questionsAnswered(record: FirstTally | null): boolean {
	return (["pay", "bills", "budgets"] as const).every(
		(stroke) => record?.strokes[stroke] !== undefined,
	);
}

// Each setter is one upsert, so the json_* change is applied to what is stored when the write happens. Two writes that
// overlap then keep each other's fields, where a read-then-write of the whole record would lose one of them.

/**
 * The statement that draws a stroke on a household day (or with no day), for a batch with other writes (one transaction).
 * json_insert never overwrites, so a stroke already drawn keeps its first day. `guard` is an SQL condition checked in the
 * same statement, so a stroke is drawn only while it holds: the pay and bills strokes pass NO_PAY_LEFT_SQL, so a deposit
 * that arrived after the step's own read leaves them undrawn. It is code, never input (like EMPTY_RECORD). With no guard
 * the write is the same as before.
 */
export function strokeStatement(
	db: D1Database,
	stroke: Stroke,
	day: string | null,
	guard = "1",
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO household_settings (key, value) SELECT ?1, json_insert('${EMPTY_RECORD}', '$.strokes.' || ?2, ?3) WHERE ${guard}
			ON CONFLICT(key) DO UPDATE SET value = json_insert(value, '$.strokes.' || ?2, ?3)`,
		)
		.bind(KEY, stroke, day);
}

/** Draws a stroke on a household day (or with no day); strokeStatement has the guard. */
export async function markStroke(
	db: D1Database,
	stroke: Stroke,
	day: string | null,
	guard = "1",
): Promise<void> {
	await strokeStatement(db, stroke, day, guard).run();
}

/** The four strokes a disconnected bank takes back before setup is done: all but the night's count. */
const BANK_STROKES = STROKES.slice(0, 4);

/**
 * The statement that takes strokes one to four back when the last connected bank goes before setup is done (spec §8.8,
 * #578). `disconnectingId` is the bank being disconnected, which doesn't count as connected for this check, so the
 * statement is right whether it runs before or after that disconnect in the same batch. The budget answers stay (§5).
 */
export function takeBackBankStrokes(
	db: D1Database,
	disconnectingId: number,
): D1PreparedStatement {
	const notSetUp = STROKES.map(
		(stroke) => `json_type(value, '$.strokes.${stroke}') IS NOT NULL`,
	).join(" AND ");
	return db
		.prepare(
			`UPDATE household_settings SET value = json_remove(value, ${BANK_STROKES.map((s) => `'$.strokes.${s}'`).join(", ")})
			WHERE key = ?1 AND NOT (${notSetUp})
				AND NOT EXISTS (SELECT 1 FROM plaid_items WHERE disconnected_at IS NULL AND id != ?2)`,
		)
		.bind(KEY, disconnectingId);
}

/**
 * The statement that takes a bank's deposits out of the pay record when its history is deleted: each Yes and No deposit
 * whose transaction belongs to the bank goes, and a merchant left with neither loses its place. A merchant keeps only
 * the keys it still has deposits under, so one the bank never paid comes out as it was. It runs while the bank
 * is still connected (as takeBackBankStrokes checks), so a second submit changes nothing, and it is one UPDATE, so the
 * read and the write of the record happen in one statement.
 */
export function forgetPayDeposits(
	db: D1Database,
	itemId: number,
): D1PreparedStatement {
	const kept = (answer: "yes" | "no") =>
		`(SELECT json_group_object(d.key, json(d.value)) FROM json_each(m.value, '$.${answer}') AS d WHERE CAST(d.key AS INTEGER) NOT IN (SELECT id FROM gone))`;
	const hasKept = (answer: "yes" | "no") =>
		`EXISTS (SELECT 1 FROM json_each(m.value, '$.${answer}') AS d WHERE CAST(d.key AS INTEGER) NOT IN (SELECT id FROM gone))`;
	return db
		.prepare(
			`WITH gone AS (SELECT t.id FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.plaid_item_id = ?2)
			UPDATE household_settings SET value = json_set(value, '$.pay', json((
				SELECT json_group_object(m.key, json(json_patch(json_object('at', json_extract(m.value, '$.at')), json_patch(
					CASE WHEN ${hasKept("yes")} THEN json_object('yes', json(${kept("yes")})) ELSE '{}' END,
					CASE WHEN ${hasKept("no")} THEN json_object('no', json(${kept("no")})) ELSE '{}' END
				))))
				FROM json_each(household_settings.value, '$.pay') AS m
				WHERE ${hasKept("yes")} OR ${hasKept("no")}
			)))
			WHERE key = ?1 AND json_type(value, '$.pay') IS NOT NULL
				AND EXISTS (SELECT 1 FROM plaid_items WHERE id = ?2 AND disconnected_at IS NULL)`,
		)
		.bind(KEY, itemId);
}

/**
 * The statement that keeps the budgets step's answer for a category, for a batch with the budget it sets (keep all, a
 * Yes, another amount, a skip). The newest answer for a category replaces the one before it. One upsert: the json_set
 * changes only that category's entry in the record as it is when the write happens.
 */
export function keepBudgetStatement(
	db: D1Database,
	categoryId: number,
	answer: BudgetAnswer,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO household_settings (key, value) VALUES (?1, json_set('${EMPTY_RECORD}', '$.budgets."' || ?2 || '"', json(?3)))
			ON CONFLICT(key) DO UPDATE SET value = json_set(value, '$.budgets."' || ?2 || '"', json(?3))`,
		)
		.bind(KEY, String(categoryId), JSON.stringify(answer));
}

/** Keeps the budgets step's answer for a category; keepBudgetStatement has the write. */
export async function keepBudgetAnswer(
	db: D1Database,
	categoryId: number,
	answer: BudgetAnswer,
): Promise<void> {
	await keepBudgetStatement(db, categoryId, answer).run();
}

/** Keeps the counts of the first night, once its sorting has all finished. */
export async function keepNightCounts(
	db: D1Database,
	counts: NightCounts,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO household_settings (key, value) VALUES (?1, json_set('${EMPTY_RECORD}', '$.night', json(?2)))
			ON CONFLICT(key) DO UPDATE SET value = json_set(value, '$.night', json(?2))`,
		)
		.bind(KEY, JSON.stringify(counts))
		.run();
}

/**
 * The record's write of one pay answer. It goes in the same batch, right after the answer's own UPDATE (answerPay), and
 * lands only when that UPDATE changed rows (`WHERE changes() > 0`), so a stale answer that changes nothing leaves the
 * record as the first answer set it, and the record and the flags always agree. The answer's deposits are bound as one
 * keyed object, `{"yes": {…}}` or `{"no": {…}}`, and json_patch merges it key by key: a deposit answered before keeps its
 * entry, a new one adds to it, and a No adds to `no` without touching `yes`. The merchant's key is bound as a value and
 * merged with json_patch, not written into a JSON path, so a bank text with a quote in it is safe; json_patch also
 * creates `pay` on a record that has none yet. `at` is the merchant's place: one past the highest place on the record for a
 * merchant new to it (a bank's history can take merchants off the record, forgetPayDeposits, so a count could repeat a
 * place), and the place it already has for one answered again.
 */
export function payAnswerStatement(
	db: D1Database,
	merchant: string,
	record: PayAnswerRecord,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO household_settings (key, value) SELECT ?1, json_patch('${EMPTY_RECORD}', json_object('pay', json_object(?2, json_set(json(?3), '$.at', 0)))) WHERE changes() > 0
			ON CONFLICT(key) DO UPDATE SET value = json_patch(value, json_object('pay', json_object(?2, json_set(json(?3), '$.at', COALESCE(
				(SELECT json_extract(p.value, '$.at') FROM json_each(household_settings.value, '$.pay') AS p WHERE p.key = ?2),
				(SELECT COALESCE(MAX(json_extract(p.value, '$.at')) + 1, 0) FROM json_each(household_settings.value, '$.pay') AS p))))))`,
		)
		.bind(KEY, merchant, JSON.stringify(record));
}

/**
 * The record's write of one kept bill, for keepBills' batch right after the bill's own INSERT: it adds one to the count
 * and the bill's amount to the total, and lands only when that INSERT added the bill (`WHERE changes() > 0`), so a
 * refused name adds nothing. Each kept bill lands with its bill, so a Keep that fails part-way still counts the bills
 * it kept. The sum reads what is stored when the write happens, so two Keeps add up; a first bill on a record without
 * `bills` starts from zero (json_extract is NULL there).
 */
export function keptBillStatement(
	db: D1Database,
	cents: number,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO household_settings (key, value) SELECT ?1, json_set('${EMPTY_RECORD}', '$.bills', json_object('kept', 1, 'cents', ?2)) WHERE changes() > 0
			ON CONFLICT(key) DO UPDATE SET value = json_set(value, '$.bills', json_object('kept', COALESCE(json_extract(value, '$.bills.kept'), 0) + 1, 'cents', COALESCE(json_extract(value, '$.bills.cents'), 0) + ?2))`,
		)
		.bind(KEY, cents);
}

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

/**
 * The 09:00 run's sync, kept until the second sort's run decides the night (#586): how many transactions the sync
 * brought in, the UTC date of that run (the run's own night, not a household day), and whether every bank synced cleanly
 * (no failure, no skipped bank, no bank that needs signing in, and the household-wide step after the banks ran).
 */
export type NightSync = { brought: number; on: string; ok: boolean };

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
	/** The 09:00 run's sync, until the second sort keeps the night's counts (or the next 09:00 run replaces it). */
	nightSync?: NightSync;
	/** The first night after stroke four, kept once that night's sorting has all finished. */
	night?: NightCounts;
	/**
	 * The pay step's answers so far, by merchant key (the store's raw name): the deposits each merchant answered Yes or No,
	 * and its place (`at`). A merchant asked again adds its new deposits to them (payAnswerStatement).
	 */
	pay?: Record<string, PayRecord>;
	/** What the bills step kept so far, added to as each bill is kept (keptBillStatement); absent until one is. */
	bills?: BillsKept;
	/**
	 * The bank a setup link took the questions back for (takeBackQuestionStrokes): its institution name, which stroke one's
	 * note reads ("Wells Fargo linked: Tally asks again…"). Removed when the budgets stroke draws (the last of the three
	 * questions again) or when the last bank goes before setup is done (takeBackBankStrokes). Absent otherwise.
	 */
	reAsk?: { bank: string };
	/**
	 * The savings question's answer (decision 135, #721): the goal's cents the household kept, or "skipped" for Not now. Set
	 * once, when the question is answered or when stroke four is drawn with a goal above $0 (savingsCopyStatement); a
	 * take-back keeps it, as it keeps the budgets. Absent until then.
	 */
	savings?: number | "skipped";
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
	// The budgets stroke is drawn last of the three questions (its guard needs pay and bills, budgetsStrokeGuard), so its
	// write takes the re-ask marker away in the same statement (reAsk).
	const drawn =
		stroke === "budgets"
			? "json_remove(json_insert(value, '$.strokes.' || ?2, ?3), '$.reAsk')"
			: "json_insert(value, '$.strokes.' || ?2, ?3)";
	return db
		.prepare(
			`INSERT INTO household_settings (key, value) SELECT ?1, json_insert('${EMPTY_RECORD}', '$.strokes.' || ?2, ?3) WHERE ${guard}
			ON CONFLICT(key) DO UPDATE SET value = ${drawn}`,
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
 * The night's writes are open while the three questions are answered, the count stroke isn't drawn and no night is kept
 * yet (the guard of nightSyncStatement and keepNightStatement).
 */
const NIGHT_OPEN_SQL = `json_type(value, '$.strokes.pay') IS NOT NULL AND json_type(value, '$.strokes.bills') IS NOT NULL
	AND json_type(value, '$.strokes.budgets') IS NOT NULL AND json_type(value, '$.strokes.count') IS NULL AND json_type(value, '$.night') IS NULL`;

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
			`UPDATE household_settings SET value = json_remove(value, ${BANK_STROKES.map((s) => `'$.strokes.${s}'`).join(", ")}, '$.night', '$.nightSync', '$.reAsk')
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
 * changes only that category's entry in the record as it is when the write happens. `guard` is an SQL condition checked
 * in the same statement, as strokeStatement's is: a Yes, another amount or keep all records only when its budget landed
 * (`changes() > 0`), and a skip checks that its category is still asked. It is code, never input. A guard may name the
 * category as `?2`, which is bound as text (String(categoryId)): SQLite's numeric affinity compares it with the integer
 * id. With no guard the write is the same as before.
 */
export function keepBudgetStatement(
	db: D1Database,
	categoryId: number,
	answer: BudgetAnswer,
	guard = "1",
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO household_settings (key, value) SELECT ?1, json_set('${EMPTY_RECORD}', '$.budgets."' || ?2 || '"', json(?3)) WHERE ${guard}
			ON CONFLICT(key) DO UPDATE SET value = json_set(value, '$.budgets."' || ?2 || '"', json(?3))`,
		)
		.bind(KEY, String(categoryId), JSON.stringify(answer));
}

/**
 * The statement that keeps the 09:00 run's sync result (`nightSync`, #586), after the sync. `ok` is the run's own check
 * (nothing failed or was skipped, and the household step ran); the statement adds that no connected bank needs signing in
 * (a bank that needs it is never synced, so the run can't see it), in the same statement. It is an UPDATE: the guard needs
 * the three questions drawn, so the record exists. It writes only while the night is open (NIGHT_OPEN_SQL), so the count
 * stroke or a kept night is never overwritten; a run that didn't finish leaves its sync to the next 09:00 run, which
 * replaces it.
 */
export function nightSyncStatement(
	db: D1Database,
	sync: { brought: number; on: string; ok: boolean },
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE household_settings SET value = json_set(value, '$.nightSync', json_object('brought', ?2, 'on', ?3,
				'ok', json(CASE WHEN ?4 = 1 AND NOT EXISTS (SELECT 1 FROM plaid_items WHERE disconnected_at IS NULL AND status <> 'ok') THEN 'true' ELSE 'false' END)))
			WHERE key = ?1 AND ${NIGHT_OPEN_SQL}`,
		)
		.bind(KEY, sync.brought, sync.on, sync.ok ? 1 : 0);
}

/**
 * The statement that keeps the first night's counts at the end of the second sort (#586), once its sorting and names
 * have all finished (the caller checks those): it keeps `brought` from the 09:00 sync and `needYou`, then removes
 * `nightSync`. It writes only when that sync is for `on` and was ok, and the night is open, so a night is kept once.
 */
export function keepNightStatement(
	db: D1Database,
	on: string,
	needYou: number,
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE household_settings SET value = json_set(json_remove(value, '$.nightSync'), '$.night',
				json_object('brought', json_extract(value, '$.nightSync.brought'), 'needYou', ?3))
			WHERE key = ?1 AND json_extract(value, '$.nightSync.on') = ?2 AND json_extract(value, '$.nightSync.ok') = 1
				AND ${NIGHT_OPEN_SQL}`,
		)
		.bind(KEY, on, needYou);
}

/**
 * The statement that takes the questions back when a second bank is linked during setup (#578): pay, bills and budgets
 * lose their strokes, and the night with them, so the questions are asked again once the new bank's history is in. The
 * answers stay (only the strokes go), and so does stroke one. It also sets `reAsk` to the new bank's name (`bankName`,
 * bound as a value, never built into a path), which stroke one's note reads. It is checked in the same batch as the new
 * bank's INSERT, so no bank read is needed. It writes only while the count stroke isn't drawn and a question is drawn or a
 * re-ask is still open (so the newest bank names itself), so a link that takes nothing back sets no marker.
 */
export function takeBackQuestionStrokes(
	db: D1Database,
	bankName: string,
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE household_settings SET value = json_set(json_remove(value, '$.strokes.pay', '$.strokes.bills', '$.strokes.budgets', '$.night', '$.nightSync'),
				'$.reAsk', json_object('bank', ?2))
			WHERE key = ?1 AND json_type(value, '$.strokes.count') IS NULL
				AND (json_type(value, '$.strokes.pay') IS NOT NULL OR json_type(value, '$.strokes.bills') IS NOT NULL
					OR json_type(value, '$.strokes.budgets') IS NOT NULL OR json_type(value, '$.reAsk') IS NOT NULL)`,
		)
		.bind(KEY, bankName);
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

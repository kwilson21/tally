// The first week's record (spec §5, §8.8, decisions 114 and 148): one `household_settings` row, `first_tally`, holding JSON. It
// keeps the household day each of the four strokes was drawn, the budgets step's one-at-a-time answers (skips included),
// and the pay, bills and savings answers. Setup is done at the budgets stroke. A household set up before the feature
// shipped has its strokes drawn with no day (migration 0057, and 0061 takes the count stroke out), so it reads as set up.

import type { PayDeposit } from "../first-tally/pay";

/**
 * The four strokes of the first week (P125 E, decision 148): link a bank, your pay, your bills, and your budgets (the
 * savings question is part of that last step). Setup is done once all four are drawn.
 */
export const STROKES = ["bank", "pay", "bills", "budgets"] as const;
export type Stroke = (typeof STROKES)[number];

/**
 * One budgets answer, kept as it was given: the suggestion accepted, another amount typed, or the category skipped
 * (no amount). Keyed by category id in the record.
 */
export type BudgetAnswer =
	| { kind: "suggested" | "another"; cents: number }
	| { kind: "skipped"; cents: null };

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
	/**
	 * The pay step's answers so far, by merchant key (the store's raw name): the deposits each merchant answered Yes or No,
	 * and its place (`at`). A merchant asked again adds its new deposits to them (payAnswerStatement).
	 */
	pay?: Record<string, PayRecord>;
	/** What the bills step kept so far, added to as each bill is kept (keptBillStatement); absent until one is. */
	bills?: BillsKept;
	/**
	 * The bank a setup link took the questions back for (takeBackQuestionStrokes): its institution name ("Wells Fargo linked:
	 * Tally asks again…" was its note on the step list, which decision 148 took out; nothing draws it now). Removed when the
	 * budgets stroke draws (the last of the three questions again) or when the last bank goes before setup is done
	 * (takeBackBankStrokes). Absent otherwise.
	 */
	reAsk?: { bank: string };
	/**
	 * Set when Sort right away is turned back on while setup isn't done and an import still waits for Jev (decision 150): the
	 * rows a sync left with the switch off wait for the daily run, so setup's reading screen keeps saying so. Removed by the
	 * daily run once nothing waits, and when the questions or the bank are taken back. Absent otherwise.
	 */
	waitsForRun?: true;
	/**
	 * The addresses the ready email (decision 134) has reached or is sending to. An address is added before its email goes
	 * and taken off again if neither provider delivers, so each person gets it once (src/first-tally/ready-email.tsx).
	 * Absent until one is added.
	 */
	readyEmailedTo?: string[];
	/**
	 * The addresses sent the ready push (decision 149): each address gets one push on each device it turned notifications on for,
	 * claimed before its pushes go and taken off again only when no device answered and some answer was transient, so a retry
	 * is a new minute's try. Absent until one is claimed. The push stops for an address once it is in readyEmailedTo, or once
	 * its kept email try is in heldReadyEmail (the email may already have reached it).
	 */
	readyPushedTo?: string[];
	/**
	 * readyPushedAt is written when the push claims the person (holding the email while the push is in flight), moved to the
	 * delivery's time when a device takes it, and removed when none does; if that removal fails, it keeps the claim's time and the
	 * email waits 8 minutes from the claim. Keyed by the address's hash as heldReadyEmail is (`YYYY-MM-DDTHH:MM:SSZ`), and the ready
	 * email waits EMAIL_AFTER_PUSH_MS from it (ready-email.tsx). Absent until a claim writes one (decision 149).
	 */
	readyPushedAt?: Record<string, string>;
	/**
	 * The kept tries of the ready email (decisions 146 and 147), keyed by the SHA-256 in hex of the lower-cased address: the whole
	 * email (subject, HTML and text) a try Resend may hold sent, and the UTC time of that first try (`YYYY-MM-DDTHH:MM:SSZ`). The
	 * next try sends that same email under the same key, through Resend only, until Resend answers or the entry is 23 hours old.
	 * An entry kept as only its read line (before the whole email was kept) is turned into that email by the next minute run
	 * (ready-email.tsx). Absent until one is kept.
	 */
	heldReadyEmail?: Record<
		string,
		{ mail: { subject: string; html: string; text: string }; at: string }
	>;
	/**
	 * The savings question's answer (decision 135, #721): the goal's cents the household kept, or "skipped" for Not now. Set
	 * once, when the question is answered or when the budgets stroke is drawn with a goal above $0 (savingsCopyStatement); a
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

/**
 * True once all four strokes are drawn, whether or not they carry a day: setup is done at the budgets stroke (decision
 * 148), and the budgets stroke can only be drawn once the other three are.
 */
export function isSetUp(record: FirstTally | null): boolean {
	return STROKES.every((stroke) => record?.strokes[stroke] !== undefined);
}

/** True once the three questions are answered (pay, bills and budgets drawn). */
export function questionsAnswered(record: FirstTally | null): boolean {
	return (["pay", "bills", "budgets"] as const).every(
		(stroke) => record?.strokes[stroke] !== undefined,
	);
}

/** The three questions' strokes, in the order the first page asks them. */
export const QUESTION_STROKES = ["pay", "bills", "budgets"] as const;

/** True once any of the three questions is drawn (a migrated record's null counts). The first page's check-in stops then. */
export function anyQuestionAnswered(record: FirstTally | null): boolean {
	return QUESTION_STROKES.some(
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

/**
 * The statement that marks the import as waiting for the daily run (decision 150), written with Sort right away's turn-on
 * (saveAiSwitches' `alongside`). It is an UPDATE, so the record must exist (stroke one is drawn before any sync's import can
 * be waiting), it writes nothing once setup is done (the budgets stroke is drawn), and it writes only while a row still waits
 * for Jev: `waitingSql` is waitingForJevSql's FROM and WHERE for the switches as they are once saved.
 */
export function waitsForRunStatement(
	db: D1Database,
	waitingSql: string,
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE household_settings SET value = json_set(value, '$.waitsForRun', json('true')) WHERE key = ?1 AND json_type(value, '$.strokes.budgets') IS NULL AND EXISTS (SELECT 1 ${waitingSql})`,
		)
		.bind(KEY);
}

/**
 * The statement that removes the daily run's wait mark once nothing waits for Jev (decision 150). `waitingSql` is
 * waitingForJevSql's for the switches, so the mark stays while a row still waits; null (both switches off, so nothing can
 * wait) always removes it.
 */
export function clearWaitsForRunStatement(
	db: D1Database,
	waitingSql: string | null,
): D1PreparedStatement {
	const nothingWaiting =
		waitingSql === null ? "" : ` AND NOT EXISTS (SELECT 1 ${waitingSql})`;
	return db
		.prepare(
			`UPDATE household_settings SET value = json_remove(value, '$.waitsForRun') WHERE key = ?1${nothingWaiting}`,
		)
		.bind(KEY);
}

/**
 * The statement that takes the strokes back when the last connected bank goes before setup is done (spec §8.8, #578): all
 * four, so the household is asked about its bank afresh. It writes only while setup isn't done (not all four drawn), so a
 * finished setup stays when its bank goes. `disconnectingId` is the bank being disconnected, which doesn't count as
 * connected for this check, so the statement is right whether it runs before or after that disconnect in the same batch.
 * The budget answers stay (§5).
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
			`UPDATE household_settings SET value = json_remove(value, ${STROKES.map((s) => `'$.strokes.${s}'`).join(", ")}, '$.reAsk', '$.waitsForRun')
			WHERE key = ?1 AND NOT (${notSetUp})
				AND NOT EXISTS (SELECT 1 FROM plaid_items WHERE disconnected_at IS NULL AND id != ?2)`,
		)
		.bind(KEY, disconnectingId);
}

/**
 * The Apple Card is kept while it is on: its rows are only removed (Remove Apple Card, spec §8.10) while this holds, so a
 * second submit, or a card that was removed in another tab, changes nothing.
 */
export const APPLE_CARD_KEPT =
	"EXISTS (SELECT 1 FROM accounts WHERE subtype = 'apple_card' AND removed_at IS NULL)";

/**
 * The shared body of the pay cleanups: the pay record's Yes and No copies of the deposits whose transactions `gone`
 * selects are taken out, while `guard` holds. A merchant left with neither answer loses its place, and one with
 * deposits left keeps only those, so a merchant the bank never paid comes out as it was. One UPDATE, so the read and the
 * write of the record happen in one statement. `binds` are the values of ?2 in `gone` and `guard`, when they take one.
 */
function forgetDepositsWhere(
	db: D1Database,
	gone: string,
	guard: string,
	binds: number[],
): D1PreparedStatement {
	const kept = (answer: "yes" | "no") =>
		`(SELECT json_group_object(d.key, json(d.value)) FROM json_each(m.value, '$.${answer}') AS d WHERE CAST(d.key AS INTEGER) NOT IN (SELECT id FROM gone))`;
	const hasKept = (answer: "yes" | "no") =>
		`EXISTS (SELECT 1 FROM json_each(m.value, '$.${answer}') AS d WHERE CAST(d.key AS INTEGER) NOT IN (SELECT id FROM gone))`;
	return db
		.prepare(
			`WITH gone AS (${gone})
			UPDATE household_settings SET value = json_set(value, '$.pay', json((
				SELECT json_group_object(m.key, json(json_patch(json_object('at', json_extract(m.value, '$.at')), json_patch(
					CASE WHEN ${hasKept("yes")} THEN json_object('yes', json(${kept("yes")})) ELSE '{}' END,
					CASE WHEN ${hasKept("no")} THEN json_object('no', json(${kept("no")})) ELSE '{}' END
				))))
				FROM json_each(household_settings.value, '$.pay') AS m
				WHERE ${hasKept("yes")} OR ${hasKept("no")}
			)))
			WHERE key = ?1 AND json_type(value, '$.pay') IS NOT NULL AND ${guard}`,
		)
		.bind(KEY, ...binds);
}

/**
 * The statement that takes a bank's deposits out of the pay record when its history is deleted: each Yes and No deposit
 * whose transaction belongs to the bank goes, and a merchant left with neither loses its place. It runs while the bank
 * is still connected (as takeBackBankStrokes checks), so a second submit changes nothing.
 */
export function forgetPayDeposits(
	db: D1Database,
	itemId: number,
): D1PreparedStatement {
	return forgetDepositsWhere(
		db,
		"SELECT t.id FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.plaid_item_id = ?2",
		"EXISTS (SELECT 1 FROM plaid_items WHERE id = ?2 AND disconnected_at IS NULL)",
		[itemId],
	);
}

/**
 * The same cleanup for Apple Card's rows, which Remove Apple Card deletes with its account (spec §8.10): it runs first in
 * that batch, while the card is still kept (APPLE_CARD_KEPT), so the deposits are found through the card's rows.
 */
export function forgetCardPayDeposits(db: D1Database): D1PreparedStatement {
	return forgetDepositsWhere(
		db,
		"SELECT t.id FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.subtype = 'apple_card'",
		APPLE_CARD_KEPT,
		[],
	);
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
 * The statement that takes the questions back when a second bank is linked during setup (#578): pay and bills lose their
 * strokes, so the questions are asked again once the new bank's history is in. The answers stay (only the strokes go), and
 * so does stroke one. It also sets `reAsk` to the new bank's name (`bankName`, bound as a value, never built into a path).
 * It is checked in the same batch as the new bank's INSERT, so no bank read is needed. It writes only while setup isn't
 * done (the budgets stroke isn't drawn) and a question is drawn or a re-ask is still open (so the newest bank names
 * itself), so a link that takes nothing back sets no marker, and a link after setup asks nothing again.
 */
export function takeBackQuestionStrokes(
	db: D1Database,
	bankName: string,
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE household_settings SET value = json_set(json_remove(value, '$.strokes.pay', '$.strokes.bills', '$.waitsForRun'),
				'$.reAsk', json_object('bank', ?2))
			WHERE key = ?1 AND json_type(value, '$.strokes.budgets') IS NULL
				AND (json_type(value, '$.strokes.pay') IS NOT NULL OR json_type(value, '$.strokes.bills') IS NOT NULL
					OR json_type(value, '$.reAsk') IS NOT NULL)`,
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

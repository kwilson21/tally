// The first week's record (spec §5, §8.8, decision 114): one `household_settings` row, `first_tally`, holding JSON. It
// keeps the household day each of the five strokes was drawn, the budgets step's one-at-a-time answers (skips included),
// and the counts of the first night after stroke four. A household set up before the feature shipped has all five
// strokes drawn with no day (migration 0057), so it reads as set up.

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

// Each setter is one upsert, so the json_* change is applied to what is stored when the write happens. Two writes that
// overlap then keep each other's fields, where a read-then-write of the whole record would lose one of them.

/**
 * The statement that draws a stroke on a household day (or with no day), for a batch with other writes (one transaction).
 * json_insert never overwrites, so a stroke already drawn keeps its first day.
 */
export function strokeStatement(
	db: D1Database,
	stroke: Stroke,
	day: string | null,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO household_settings (key, value) VALUES (?1, json_insert('${EMPTY_RECORD}', '$.strokes.' || ?2, ?3))
			ON CONFLICT(key) DO UPDATE SET value = json_insert(value, '$.strokes.' || ?2, ?3)`,
		)
		.bind(KEY, stroke, day);
}

/** Draws a stroke on a household day (or with no day). */
export async function markStroke(
	db: D1Database,
	stroke: Stroke,
	day: string | null,
): Promise<void> {
	await strokeStatement(db, stroke, day).run();
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

/** Keeps the budgets step's answer for a category. The newest answer for a category replaces the one before it. */
export async function keepBudgetAnswer(
	db: D1Database,
	categoryId: number,
	answer: BudgetAnswer,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO household_settings (key, value) VALUES (?1, json_set('${EMPTY_RECORD}', '$.budgets."' || ?2 || '"', json(?3)))
			ON CONFLICT(key) DO UPDATE SET value = json_set(value, '$.budgets."' || ?2 || '"', json(?3))`,
		)
		.bind(KEY, String(categoryId), JSON.stringify(answer))
		.run();
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

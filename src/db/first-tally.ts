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

/** The pay step's answer for one merchant: Yes, it's the family's pay, or No, it isn't (spec §8.8). */
export type PayAnswer = "yes" | "no";

/** What the bills step kept: how many bills, and their monthly total in cents, summed over each Keep. */
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
	/** The pay step's answers so far, by merchant key (the store's raw name); a merchant answered again keeps the newest. */
	pay?: Record<string, PayAnswer>;
	/** What the bills step kept so far, absent until a Keep kept a bill. */
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

// Each setter is one upsert, so the json_* change is applied to what is stored when the write happens. Two writes that
// overlap then keep each other's fields, where a read-then-write of the whole record would lose one of them.

/** Draws a stroke on a household day (or with no day). json_insert never overwrites, so a stroke already drawn keeps its first day. */
export async function markStroke(
	db: D1Database,
	stroke: Stroke,
	day: string | null,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO household_settings (key, value) VALUES (?1, json_insert('${EMPTY_RECORD}', '$.strokes.' || ?2, ?3))
			ON CONFLICT(key) DO UPDATE SET value = json_insert(value, '$.strokes.' || ?2, ?3)`,
		)
		.bind(KEY, stroke, day)
		.run();
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

/**
 * The write of one pay answer, for a batch with the answer's own change (answerPay), so the two land together. The
 * merchant's key is bound as a value and merged with json_patch, not written into a JSON path, so a bank text with a
 * quote in it is safe; json_patch also creates `pay` on a record that has none yet.
 */
export function payAnswerStatement(
	db: D1Database,
	merchant: string,
	answer: PayAnswer,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO household_settings (key, value) VALUES (?1, json_patch('${EMPTY_RECORD}', json_object('pay', json_object(?2, ?3))))
			ON CONFLICT(key) DO UPDATE SET value = json_patch(value, json_object('pay', json_object(?2, ?3)))`,
		)
		.bind(KEY, merchant, answer);
}

/**
 * Records what the bills step kept, summed over each Keep, so a second Keep adds to the first. With `day`, the bills
 * stroke is drawn in the same write (its first day kept, as markStroke does). Without it, only the count and total change.
 */
export async function keepBillsStep(
	db: D1Database,
	kept: BillsKept,
	day?: string,
): Promise<void> {
	// The sum reads what is stored when the write happens, so two Keeps add up; a first Keep on a record without `bills`
	// starts from zero (json_extract is NULL there).
	const sum = `json_set(value, '$.bills', json_object('kept', COALESCE(json_extract(value, '$.bills.kept'), 0) + ?2, 'cents', COALESCE(json_extract(value, '$.bills.cents'), 0) + ?3))`;
	const fresh = `json_set('${EMPTY_RECORD}', '$.bills', json_object('kept', ?2, 'cents', ?3))`;
	if (day === undefined) {
		await db
			.prepare(
				`INSERT INTO household_settings (key, value) VALUES (?1, ${fresh})
				ON CONFLICT(key) DO UPDATE SET value = ${sum}`,
			)
			.bind(KEY, kept.kept, kept.cents)
			.run();
		return;
	}
	await db
		.prepare(
			`INSERT INTO household_settings (key, value) VALUES (?1, json_insert(${fresh}, '$.strokes.bills', ?4))
			ON CONFLICT(key) DO UPDATE SET value = json_insert(${sum}, '$.strokes.bills', ?4)`,
		)
		.bind(KEY, kept.kept, kept.cents, day)
		.run();
}

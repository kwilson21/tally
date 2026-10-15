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

/** The record to change: what is stored, or an empty one before the first week has anything written. */
const readOrEmpty = async (db: D1Database): Promise<FirstTally> =>
	(await readFirstTally(db)) ?? { strokes: {}, budgets: {} };

/** Saves the whole record. The callers read, change one part, and write back. */
export async function writeFirstTally(
	db: D1Database,
	record: FirstTally,
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO household_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
		.bind(KEY, JSON.stringify(record))
		.run();
}

/** True once all five strokes are drawn, whether or not they carry a day. */
export function isSetUp(record: FirstTally | null): boolean {
	return STROKES.every((stroke) => record?.strokes[stroke] !== undefined);
}

/** Draws a stroke on a household day (or with no day). A stroke already drawn keeps its first day. */
export async function markStroke(
	db: D1Database,
	stroke: Stroke,
	day: string | null,
): Promise<void> {
	const record = await readOrEmpty(db);
	if (record.strokes[stroke] !== undefined) return;
	await writeFirstTally(db, {
		...record,
		strokes: { ...record.strokes, [stroke]: day },
	});
}

/** Keeps the budgets step's answer for a category. The newest answer for a category replaces the one before it. */
export async function keepBudgetAnswer(
	db: D1Database,
	categoryId: number,
	answer: BudgetAnswer,
): Promise<void> {
	const record = await readOrEmpty(db);
	await writeFirstTally(db, {
		...record,
		budgets: { ...record.budgets, [String(categoryId)]: answer },
	});
}

/** Keeps the counts of the first night, once its sorting has all finished. */
export async function keepNightCounts(
	db: D1Database,
	counts: NightCounts,
): Promise<void> {
	const record = await readOrEmpty(db);
	await writeFirstTally(db, { ...record, night: counts });
}

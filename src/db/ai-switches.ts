// The household's AI suggestions switches (spec §8.6, decision 73): one `household_settings` row each,
// "on" or "off". A switch with no row is on, so a fresh database and the demo's reset start all on.

/** One flag per AI feature; off means Tally works from rules and people's choices alone. */
export type AiSwitches = {
	/** Workers AI suggests merchant names. */
	names: boolean;
	/** Jev fills empty transaction details; Workers AI writes the note. */
	details: boolean;
	/** Jev's category answer, and its transfer and reimbursement flags that exclude. */
	categories: boolean;
	/** Jev's income answer. */
	income: boolean;
	/** Jev sorts a sync's new transactions right after it, not only overnight. */
	sortOnArrival: boolean;
};

export const AI_SWITCHES_ALL_ON: AiSwitches = {
	names: true,
	details: true,
	categories: true,
	income: true,
	sortOnArrival: true,
};

const KEYS: Record<keyof AiSwitches, string> = {
	names: "ai_names",
	details: "ai_details",
	categories: "ai_categories",
	income: "ai_income",
	sortOnArrival: "ai_sort_on_arrival",
};

/**
 * Jev answers category, flags and income together, so it's asked only while one of the two switches
 * that use its answer is on; with both off it isn't asked at all (spec §8.6).
 */
export const asksJev = (s: AiSwitches): boolean =>
	s.categories || s.income || s.details;

/**
 * Reads the switches. Only a stored "off" turns one off. A database error is thrown, never guessed
 * around, so a run can't call an AI the household turned off.
 */
export async function readAiSwitches(db: D1Database): Promise<AiSwitches> {
	const { results } = await db
		.prepare(
			"SELECT key, value FROM household_settings WHERE key IN (?, ?, ?, ?, ?)",
		)
		.bind(
			KEYS.names,
			KEYS.details,
			KEYS.categories,
			KEYS.income,
			KEYS.sortOnArrival,
		)
		.all<{ key: string; value: string }>();
	const off = new Set(
		results.filter((row) => row.value === "off").map((row) => row.key),
	);
	return {
		names: !off.has(KEYS.names),
		details: !off.has(KEYS.details),
		categories: !off.has(KEYS.categories),
		income: !off.has(KEYS.income),
		sortOnArrival: !off.has(KEYS.sortOnArrival),
	};
}

/**
 * Saves the switches it's given, together, and leaves the rest as they were: Settings shows only the
 * switches whose feature exists, and saving those must never change the others.
 */
export async function saveAiSwitches(
	db: D1Database,
	switches: Partial<AiSwitches>,
): Promise<void> {
	const given = (Object.keys(KEYS) as (keyof AiSwitches)[]).filter(
		(name) => switches[name] !== undefined,
	);
	if (given.length === 0) return;
	await db.batch(
		given.map((name) =>
			db
				.prepare(
					"INSERT INTO household_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				)
				.bind(KEYS[name], switches[name] ? "on" : "off"),
		),
	);
}

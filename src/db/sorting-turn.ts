// The sorting turn (decision 136): one `household_settings` row, `sorting_turn`, that names the sorting group
// holding the household's turn and when the turn ends. One group sorts at a time, so two runs never ask Jev
// about the same transaction. A group takes the turn when it reads, every statement of its save checks it, and
// the save gives it back. The turn's until is 15 minutes after it was taken, so a save with its retries
// finishes inside the turn, and a turn with no until can't block forever.

export const SORTING_TURN_MS = 15 * 60_000;

/** True while the turn is held by the id bound to `param`; a save's statements append it to their WHERE clause. */
export const turnHeldSql = (param = "?") =>
	`EXISTS (SELECT 1 FROM household_settings WHERE key = 'sorting_turn' AND json_extract(value, '$.id') = ${param})`;

/**
 * Appends the turn guard to a statement's WHERE clause and binds the turn id last, when a turn is given. With
 * no turn (a save made outside sorting, as the tests do) the statement is returned as it is.
 */
export function withTurnGuard(
	sql: string,
	turnId: string | undefined,
): { sql: string; binds: string[] } {
	return turnId === undefined
		? { sql, binds: [] }
		: { sql: `${sql} AND ${turnHeldSql()}`, binds: [turnId] };
}

/**
 * Takes the turn for `turnId` when it is free, expired, has no until, or is already this group's (a retried read
 * takes its own back). False when another group holds it. One statement, so it is atomic.
 */
export async function takeSortingTurn(
	db: D1Database,
	turnId: string,
): Promise<boolean> {
	const now = Date.now();
	const { meta } = await db
		.prepare(
			`INSERT INTO household_settings (key, value) VALUES ('sorting_turn', ?1)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value
			 WHERE COALESCE(json_extract(household_settings.value, '$.until'), 0) < ?2
				OR json_extract(household_settings.value, '$.id') = ?3`,
		)
		.bind(
			JSON.stringify({ id: turnId, until: now + SORTING_TURN_MS }),
			now,
			turnId,
		)
		.run();
	return meta.changes > 0;
}

/** The statement that gives the turn back, when it is still `turnId`'s. */
export const releaseSortingTurnStatement = (db: D1Database, turnId: string) =>
	db
		.prepare(
			"DELETE FROM household_settings WHERE key = 'sorting_turn' AND json_extract(value, '$.id') = ?",
		)
		.bind(turnId);

/** Gives the turn back, when it is still `turnId`'s. */
export async function releaseSortingTurn(
	db: D1Database,
	turnId: string,
): Promise<void> {
	await releaseSortingTurnStatement(db, turnId).run();
}

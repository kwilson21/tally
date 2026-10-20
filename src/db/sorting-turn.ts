// The sorting turn (decision 139): one `household_settings` row, `sorting_turn`, that names the sorting group
// holding the household's turn and when the turn ends. One group sorts at a time, so two runs never ask Jev
// about the same transaction. A group takes the turn when it reads, every statement of its save checks it, and
// the save gives it back. The turn's until is 15 minutes after it was taken, and a turn with no until can't block
// forever. A save that failed and is tried again takes the turn back in its own batch, but only while its group's
// reservation record exists (decision 142), so a save that already went through takes nothing.

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
 * Takes the turn when it is free, expired, has no until, or is already the one bound to `?3` (a retried read takes its
 * own back), and gives it `until` 15 minutes on. Shared by the read's take and the save's (below).
 */
const TAKE_ON_CONFLICT = `ON CONFLICT(key) DO UPDATE SET value = excluded.value
	WHERE COALESCE(json_extract(household_settings.value, '$.until'), 0) < ?2
		OR json_extract(household_settings.value, '$.id') = ?3`;

const turnValue = (turnId: string, now: number) =>
	JSON.stringify({ id: turnId, until: now + SORTING_TURN_MS });

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
			`INSERT INTO household_settings (key, value) VALUES ('sorting_turn', ?1) ${TAKE_ON_CONFLICT}`,
		)
		.bind(turnValue(turnId, now), now, turnId)
		.run();
	return meta.changes > 0;
}

/**
 * The statement a save puts first in its batch: it takes the turn back as `takeSortingTurn` does, but only while the
 * group's reservation record (`reservedKey`) exists. Without the record the save has already gone through (or never
 * reserved anything), so it takes nothing, and the turn is left to whoever holds it (decision 142).
 */
export const takeSortingTurnStatement = (
	db: D1Database,
	turnId: string,
	reservedKey: string,
) => {
	const now = Date.now();
	return db
		.prepare(
			`INSERT INTO household_settings (key, value) SELECT 'sorting_turn', ?1
			 WHERE EXISTS (SELECT 1 FROM household_settings WHERE key = ?4) ${TAKE_ON_CONFLICT}`,
		)
		.bind(turnValue(turnId, now), now, turnId, reservedKey);
};

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

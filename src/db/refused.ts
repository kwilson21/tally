// What the database said when it stopped a statement, as a named kind with its parts. D1 passes SQLite's message on as
// text ("D1_ERROR: <message>: SQLITE_..."), and this is the one place that reads that text: the code that reacts to a
// refusal asks which kind it is. test/database-refusal.test.ts reads each kind off the real database, so a message SQLite
// or a migration rewords fails there.

import * as Data from "effect/Data";

/** A trigger stopped the write with its own words: `RAISE(ABORT, '...')` in a migration. */
export class TriggerRaised extends Data.TaggedError("TriggerRaised")<{
	words: string;
}> {}

/** A write tried to leave empty a column that must hold a value. The guards of a save use this on purpose (decision 190). */
export class NotNullFailed extends Data.TaggedError("NotNullFailed")<{
	table: string;
	column: string;
}> {}

/** The table isn't there: a database that has not been migrated yet. */
export class TableMissing extends Data.TaggedError("TableMissing")<{
	table: string;
}> {}

export type DatabaseRefusal = TriggerRaised | NotNullFailed | TableMissing;

const NOT_NULL = /NOT NULL constraint failed: (\w+)\.(\w+)/;
const NO_TABLE = /no such table: (\w+)/i;

const RAISED =
	/^D1_ERROR: (.+): SQLITE_CONSTRAINT \(extended: SQLITE_CONSTRAINT_TRIGGER\)$/;

/** The kind of refusal an error from the database is, or null when it is some other failure (a lost connection, say). */
export function databaseRefusal(error: Error): DatabaseRefusal | null {
	const notNull = NOT_NULL.exec(error.message);

	if (notNull?.[1] && notNull[2])
		return new NotNullFailed({ table: notNull[1], column: notNull[2] });

	const noTable = NO_TABLE.exec(error.message);

	if (noTable?.[1]) return new TableMissing({ table: noTable[1] });

	const raised = RAISED.exec(error.message);

	if (raised?.[1]) return new TriggerRaised({ words: raised[1] });

	return null;
}

/** Whether a refusal is a trigger's (TriggerRaised). */
export const isTriggerRaised = (
	refusal: DatabaseRefusal | null,
): refusal is TriggerRaised => refusal instanceof TriggerRaised;

/** Whether a refusal is an empty value in a column that must hold one (NotNullFailed). */
export const isNotNullFailed = (
	refusal: DatabaseRefusal | null,
): refusal is NotNullFailed => refusal instanceof NotNullFailed;

/** Whether a refusal is a table that isn't there (TableMissing). */
export const isTableMissing = (
	refusal: DatabaseRefusal | null,
): refusal is TableMissing => refusal instanceof TableMissing;

/**
 * Whether an error is the database refusing to leave this one column empty. A save's guard leaves a column empty on
 * purpose when what its rule read has changed (decision 190), so this is how a save tells its guard from any other failure.
 */
export const leftEmpty =
	(table: string, column: string) =>
	(error: Error): boolean => {
		const refusal = databaseRefusal(error);

		return (
			isNotNullFailed(refusal) &&
			refusal.table === table &&
			refusal.column === column
		);
	};

/**
 * True when a database error is a UNIQUE violation. Drizzle wraps every driver error as "Failed query: …" and puts the
 * SQLite message in `cause`, so the message is searched down the cause chain, five levels at most (a cycle cannot
 * loop forever). Non-Error values are never a violation.
 */
const UNIQUE = /UNIQUE/;
const MAX_CAUSE_DEPTH = 5;

export function isUniqueViolation(error: unknown): boolean {
	let current: unknown = error;

	for (
		let depth = 0;
		depth <= MAX_CAUSE_DEPTH && current instanceof Error;
		depth++
	) {
		if (UNIQUE.test(current.message)) return true;
		current = current.cause;
	}

	return false;
}

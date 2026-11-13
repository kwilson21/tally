import { setup } from "xstate";

// The GitHub filing of one feedback row (issue #863, first half). A row is filed as one issue in the private feedback
// repo; the row's four columns (github_issue_number, filing_at, attempts, last_status) say where it is, and this
// machine says what may happen next. A row gets FILING_ATTEMPT_CAP tries in all. A try claims the row for
// FILING_LEASE_MINUTES; a claim older than that belongs to a run that was cut off, so the row is ready again.
// The SQL writers in src/routes/feedback.tsx keep the columns in step with the moves below, and
// test/feedback-filing-machine.test.ts walks every writer from every state against the machine.
//
// What a move means for a row, one plain sentence each:
//   CLAIM          a run starts filing the row: the try is counted.
//   FILED          GitHub created the issue and its number is stored: the row is filed for good.
//   REJECTED       GitHub answered 422, which it never accepts: the row gives up at once.
//   TOKEN_REFUSED  GitHub answered 401 or 403, so the token is wrong, not the row: the try is given back.
//   FAILED         any other failed try (a non-2xx answer, a timeout, an unreadable body, a 2xx with no issue number):
//                  the claim is released, and the try stays counted.
//   LEASE_EXPIRED  a claim has run out with no answer: the same as a failed try.
//
// Not a move: a row that GitHub filed, but whose number could not be stored (the final UPDATE failed), is filed again by
// the next try, so GitHub gets a duplicate issue. No machine can close that gap, since the number is never written.

/** How many tries a row gets in all before it gives up (decision 218). */
export const FILING_ATTEMPT_CAP = 5;

/** How long a claim holds, in minutes: a run that has not answered by then was cut off. */
export const FILING_LEASE_MINUTES = 10;

const FILING_LEASE_MS = FILING_LEASE_MINUTES * 60_000;

export type FilingState = "unfiled" | "claimed" | "filed" | "gave_up";

/** Why a row gave up. Derived from the stored status, never stored as a column of its own. */
export type GiveUpReason = "rejected" | "exhausted";

/** The row's own count, which the guards and transitions read. */
export type FilingContext = { attempts: number };

export const feedbackFiling = setup({}).createMachine({
	id: "feedbackFiling",
	initial: "unfiled",
	context: { attempts: 0 },
	states: {
		// Ready to claim. A row at the cap never gets here: it is given up (see filingStateOf).
		unfiled: {
			on: {
				CLAIM: {
					target: "claimed",
					context: ({ context }) => ({ attempts: context.attempts + 1 }),
				},
			},
		},
		claimed: {
			on: {
				FILED: { target: "filed" },
				REJECTED: {
					target: "gave_up",
					context: { attempts: FILING_ATTEMPT_CAP },
				},
				// The token is wrong, not the row: the try goes back, and the row is ready again. The run that hit this
				// stops (see retryFeedback), and the next run tries again with the same count.
				TOKEN_REFUSED: {
					target: "unfiled",
					context: ({ context }) => ({ attempts: context.attempts - 1 }),
				},
				// A failed try and a cut-off try count the same: below the cap the row is ready again, at the cap it gives up.
				// These two are functions, not objects, because the target depends on the count. This xstate refuses a
				// guard inside a transition object (error E4), so graph drawing (#865) cannot draw these two edges.
				FAILED: ({ context }) =>
					context.attempts >= FILING_ATTEMPT_CAP
						? { target: "gave_up" }
						: { target: "unfiled" },
				LEASE_EXPIRED: ({ context }) =>
					context.attempts >= FILING_ATTEMPT_CAP
						? { target: "gave_up" }
						: { target: "unfiled" },
			},
		},
		// Filed is final: the issue exists.
		filed: {},
		// Given up is final here: nothing in the app gives a row another try, so the machine has no way out either.
		gave_up: {},
	},
});

/** A row's four columns, as the state helper reads them. `filingAt` is SQLite's UTC "YYYY-MM-DD HH:MM:SS" or null. */
export type StoredFiling = {
	attempts: number;
	githubIssueNumber: number | null;
	filingAt: string | null;
	lastStatus: number | null;
};

function claimIsLive(filingAt: string | null, now: number): boolean {
	if (filingAt === null) return false;

	// SQLite writes CURRENT_TIMESTAMP as UTC; the clock is an input, so the machine itself reads none.
	return now - Date.parse(`${filingAt.replace(" ", "T")}Z`) < FILING_LEASE_MS;
}

/**
 * The state a stored row is in, from its columns, with `now` (epoch milliseconds) passed in. Filed is any row with an
 * issue number. A live claim (no number, filed within the lease) is claimed, whatever its count. Otherwise a row at
 * the cap gives up as exhausted: its last try was cut off, or failed, so the count is used up, and nothing reads
 * filing_at except readySql, which skips it because the count is at the cap. Every other row is unfiled.
 */
export function filingStateOf(row: StoredFiling, now: number): FilingState {
	if (row.githubIssueNumber !== null) return "filed";

	if (claimIsLive(row.filingAt, now)) return "claimed";

	return row.attempts >= FILING_ATTEMPT_CAP ? "gave_up" : "unfiled";
}

/** Why a row gave up: a 422 is rejected, and anything else (the tries are used up) is exhausted. */
export function giveUpReason(lastStatus: number | null): GiveUpReason {
	return lastStatus === 422 ? "rejected" : "exhausted";
}

// The SQL forms of the same rules.

/**
 * True for an unfiled row: no issue number, fewer tries than the cap, and no live claim. retryFeedback adds its own
 * wait after a row is created; that wait is not part of this rule.
 */
export function readySql(): string {
	return `github_issue_number IS NULL AND attempts < ${FILING_ATTEMPT_CAP} AND (filing_at IS NULL OR filing_at <= datetime('now', '-${FILING_LEASE_MINUTES} minutes'))`;
}

/**
 * The statement that gives a claim back after a failed try, for the move the machine makes. It clears the claim, moves
 * the count as the move does (a rejection sets it to the cap, a refusal gives the try back, a failure keeps it), and
 * writes last_status only when GitHub answered. Parameters: the status, when one came back, then the row's id.
 */
export function releaseSql(
	move: "REJECTED" | "TOKEN_REFUSED" | "FAILED",
	statusReceived: boolean,
): string {
	const count = {
		REJECTED: `, attempts = ${FILING_ATTEMPT_CAP}`,
		TOKEN_REFUSED: ", attempts = attempts - 1",
		FAILED: "",
	}[move];
	const status = statusReceived ? ", last_status = ?1" : "";
	const id = statusReceived ? "?2" : "?1";

	return `UPDATE feedback SET filing_at = NULL${status}${count} WHERE id = ${id}`;
}

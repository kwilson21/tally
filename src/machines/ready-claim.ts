import { setup } from "xstate";

// The ready email's claim for one address (issue #863, second half; decision 223). An address is in one of four states,
// read from the stored record by readyStateOf below. The claim writes the email it will send, its kept try, and a stamp
// (readyClaimedAt) in one statement, so a run cut off after the claim leaves the email behind for the next run to send.
// This machine says what may happen next; the SQL writers in src/first-tally/ready-email.tsx keep the record in step with
// it (the SQL forms are the same rules), and test/ready-claim-machine.test.ts and test/ready-email.test.ts check both.
//
// What a move means for an address, one plain sentence each:
//   CLAIM      a run claims the address and writes its email, its kept try and the stamp, in one statement.
//   DELIVERED  Resend or Cloudflare's email took the email: the address is reached, and its kept try and stamp are removed.
//   HELD       Resend may hold the send: the address is waiting again, and its kept try stays (today's behaviour).
//   FAILED     a definite failure: the address is waiting again, and nothing is kept.
//   RECOVER    a run finds a claim older than the lease with a kept try: it re-stamps the claim and sends the stored email
//              again, through Resend only. Of several runs at once, only the one that changes the stamp sends.
//   DROP_OLD   a kept try is over 23 hours old, or its time cannot be read: nothing more is sent, and the address is reached.
//
// The machine has no context: every move is a fixed target, so each transition is an object with a string target.

/** How long a claim holds, in minutes: a run that has not finished by then was cut off (the same lease as the feedback and the push). */
export const READY_LEASE_MINUTES = 10;

export const readyClaimMachine = setup({}).createMachine({
	id: "readyClaim",
	initial: "waiting",
	states: {
		// Not in readyEmailedTo. A kept try may be stored, from an earlier try Resend may hold; the next claim sends it.
		waiting: {
			on: {
				CLAIM: { target: "sending" },
			},
		},
		// In readyEmailedTo with a fresh stamp: a run is sending (or was, and has not yet been cut off).
		sending: {
			on: {
				DELIVERED: { target: "reached" },
				HELD: { target: "waiting" },
				FAILED: { target: "waiting" },
				DROP_OLD: { target: "reached" },
			},
		},
		// In readyEmailedTo, the stamp is at least the lease old, and a kept try is stored: a run was cut off, or its release
		// failed. The stored email is the one to send, again.
		in_doubt: {
			on: {
				RECOVER: { target: "sending" },
				DROP_OLD: { target: "reached" },
			},
		},
		// Final: in readyEmailedTo with nothing to send again. Nothing moves it.
		reached: {},
	},
});

/** An address as the record stores it: whether it is listed, its stamp (null when there is none), and whether a kept try is stored. */
export type ReadyEntry = {
	emailed: boolean;
	claimedAt: string | null;
	kept: boolean;
};

export type ReadyState = "waiting" | "sending" | "in_doubt" | "reached";

/**
 * The state an address is in, from its stored entry, with `now` (epoch milliseconds) passed in, so the machine itself reads no
 * clock. A stamp is SQLite's UTC `YYYY-MM-DDTHH:MM:SSZ`, read as it is. An unreadable stamp is read as sending, so nothing is
 * sent on a time that cannot be read (the kept try's own time is checked by its own rule, DROP_OLD).
 */
export function readyStateOf(entry: ReadyEntry, now: number): ReadyState {
	if (!entry.emailed) return "waiting";

	// Listed with no stamp: finished, or claimed before the stamp existed. Nothing here can be sent again.
	if (entry.claimedAt === null) return "reached";

	const since = Date.parse(entry.claimedAt);

	if (!Number.isFinite(since)) return "sending";

	if (now - since < READY_LEASE_MINUTES * 60_000) return "sending";

	return entry.kept ? "in_doubt" : "reached";
}

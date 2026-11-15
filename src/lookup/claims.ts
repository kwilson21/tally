// The store lookup's decisions, pure (spec §7, "Store lookup"): which store a run claims, whether a search still qualifies
// when it is saved, what a save writes, and when a run stops. Each moves only as the machine allows (store-lookup.ts,
// asked through next()). Nothing here reads or writes the database, asks the network or logs.

import type { MERCHANT_LOOKUP_STATUS_VALUES } from "../db/schema";
import type { StoredLookup } from "../db/store-lookups";
import { next } from "../machines/next";
import {
	STORE_LOOKUP_ROWS,
	type StoreLookupState,
	storeLookupMachine,
	storeLookupState,
} from "../machines/store-lookup";
import type { Eligibility } from "./eligibility";
import { lookupAsks } from "./gate";

/** How many failed searches in a row stop a run (the run's three, not the row's LOOKUP_ATTEMPT_CAP). */
export const LOOKUP_FAILURES_IN_A_ROW = 3;

/** What one step of a run did with a store's search. */
export type SearchOutcome =
	| { kind: "found"; line: string }
	| { kind: "nothing_found" }
	| {
			kind: "failed";
			failure:
				| "rate_limited"
				| "refused"
				| "unreachable"
				| "unreadable"
				| "line";
	  }
	| { kind: "check-refused" }
	| { kind: "claim-lost" }
	| { kind: "date-changed" }
	| { kind: "lost" };

/** A stored status, as the lookup table keeps it (the CHECK on merchant_lookups.status). */
type LookupStatus = (typeof MERCHANT_LOOKUP_STATUS_VALUES)[number];

/** The gate's env and switches, as lookupAsks reads them. */
type GateEnv = Parameters<typeof lookupAsks>[0];

type GateSwitches = Parameters<typeof lookupAsks>[1];

/** The store a run claims, or the stores it skips as private. `mine` is a claim this token already holds. */
export type ClaimPick = {
	skip: string[];
	pick: { text: string; attempts: number; mine: boolean } | null;
};

/**
 * Which store a run claims next. A store this token already claims wins. Otherwise the candidate whose first (smallest)
 * transaction id is smallest wins: the store Tally saw first. A store is skipped when it is private, and a text with no
 * rows is never considered. Asks the machine for each move, so a state it refuses is never picked.
 */
export function claimPick({
	rows,
	decided,
	lookups,
	token,
	now,
}: {
	rows: readonly { id: number; lookupText: string }[];
	decided: ReadonlyMap<string, Eligibility>;
	lookups: ReadonlyMap<string, StoredLookup>;
	token: string;
	now: Date;
}): ClaimPick {
	const firstId = new Map<string, number>();

	for (const row of rows) {
		const known = firstId.get(row.lookupText);

		if (known === undefined || row.id < known) {
			firstId.set(row.lookupText, row.id);
		}
	}

	const skip: string[] = [];
	const mine: Candidate[] = [];
	const candidates: Candidate[] = [];

	for (const [text, id] of firstId) {
		const row = lookups.get(text) ?? null;
		const state = storeLookupState(row, now);
		const attempts = row?.attempts ?? 0;

		if (state === "claimed" && row?.claimedBy === token) {
			mine.push({ text, id, attempts, mine: true });
			continue;
		}

		const verdict = decided.get(text)?.kind;

		if (verdict === "private" && next(storeLookupMachine, state, "PRIVATE")) {
			skip.push(text);
		} else if (
			verdict === "may_search" &&
			next(storeLookupMachine, state, "CLAIM")
		) {
			candidates.push({ text, id, attempts, mine: false });
		}
	}

	const winner = [...mine].sort(byId)[0] ?? [...candidates].sort(byId)[0];

	return {
		skip,
		pick: winner
			? { text: winner.text, attempts: winner.attempts, mine: winner.mine }
			: null,
	};
}

type Candidate = { text: string; id: number; attempts: number; mine: boolean };

const byId = (a: Candidate, b: Candidate) => a.id - b.id;

/** True when a search still qualifies: the gate is open, every switch is on, and the store may still be searched. */
export function qualifies(
	env: GateEnv,
	switches: GateSwitches,
	verdict: Eligibility | undefined,
): boolean {
	return lookupAsks(env, switches) && verdict?.kind === "may_search";
}

/** What a save writes: a result for a search that qualifies, or a counted failure; null means "let go only". */
export type SaveMove =
	| { kind: "result"; status: LookupStatus; line: string | null }
	| { kind: "failure"; status: LookupStatus; attemptsBefore: number };

/**
 * The write for one search's outcome. A line or "nothing found" is kept only if the search still qualifies at the save.
 * A failure is counted whatever the switches say, and gives up at the third in a row (the machine's SEARCH_FAILED). Every
 * other outcome writes nothing: the claim is let go.
 */
export function saveMove(
	outcome: SearchOutcome,
	qualifiesNow: boolean,
	attempts: number,
): SaveMove | null {
	switch (outcome.kind) {
		case "found":
			return qualifiesNow
				? {
						kind: "result",
						status: statusAfter("SAVE_FOUND", attempts),
						line: outcome.line,
					}
				: null;
		case "nothing_found":
			return qualifiesNow
				? {
						kind: "result",
						status: statusAfter("SAVE_NOTHING", attempts),
						line: null,
					}
				: null;
		case "failed":
			return {
				kind: "failure",
				status: statusAfter("SEARCH_FAILED", attempts),
				attemptsBefore: attempts,
			};
		default:
			return null;
	}
}

/** The stored status the machine moves a claimed row to on `event`; a refused move is a bug, so it throws. */
function statusAfter(event: string, attempts: number): LookupStatus {
	const state = next(storeLookupMachine, "claimed", event, { attempts });

	if (state === null) throw new Error("store lookup: refused move");

	// SAFETY: next() returns only a state of storeLookupMachine, and every such state is a key of STORE_LOOKUP_ROWS.
	const status = STORE_LOOKUP_ROWS[state as StoreLookupState]?.status ?? null;

	if (status === null) throw new Error("store lookup: refused move");

	return status;
}

/**
 * True when a run stops: its last outcome lost the claim, the day moved on, or a search was rate limited; or it has
 * LOOKUP_FAILURES_IN_A_ROW failed searches in a row. check-refused made no search, so it is skipped in that count, and
 * only a found or a nothing_found resets it.
 */
export function runStops(outcomes: readonly SearchOutcome[]): boolean {
	const last = outcomes.at(-1);

	if (last !== undefined) {
		if (
			last.kind === "lost" ||
			last.kind === "date-changed" ||
			last.kind === "claim-lost"
		) {
			return true;
		}

		if (last.kind === "failed" && last.failure === "rate_limited") return true;
	}

	let trailing = 0;

	for (let i = outcomes.length - 1; i >= 0; i--) {
		const kind = outcomes[i]?.kind;

		if (kind === "check-refused") continue;

		if (kind !== "failed") break;

		trailing += 1;
	}

	return trailing >= LOOKUP_FAILURES_IN_A_ROW;
}

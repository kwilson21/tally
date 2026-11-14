import { setup } from "xstate";
// Type-only: erased at build time, so this machine never pulls in the Drizzle runtime.
import type { MERCHANT_LOOKUP_STATUS_VALUES } from "../db/schema";

/**
 * The web lookup of a store, in plain words (spec §7, "Store lookup"):
 *
 *   none      --CLAIM-->        claimed     a run takes the store's search
 *   none      --PRIVATE-->      skipped     the store's text is private, so it is never searched
 *   claimed   --SAVE_FOUND-->   found       the search gave a line
 *   claimed   --SAVE_NOTHING--> nothing_found  the search gave no plain answer
 *   claimed   --SEARCH_FAILED-> to_retry    a failed search, the first or second in a row
 *   claimed   --SEARCH_FAILED-> gave_up     the third failed search in a row
 *   claimed   --LEASE_EXPIRED-> to_retry    a crashed run's lease ran out; no failure is counted
 *   claimed   --LET_GO-->       to_retry    a run gave the store back; no failure is counted
 *   to_retry  --CLAIM-->        claimed     a later run takes it again
 *   to_retry  --PRIVATE-->      skipped
 *   found     --DONT_USE-->     skipped     a person does not want this line
 *   found     --PRIVATE-->      skipped     a later row with the same text is private
 *
 * nothing_found, gave_up and skipped are final: nothing leaves them. Only a failed search counts toward giving up;
 * a lease that ran out or a run that let go keeps the attempts it had. STORE_LOOKUP_ROWS says how each state is
 * stored. The real writes are SQL (a later PR); this machine is the one place the rule is stated,
 * and test/store-lookup-machine.test.ts walks every state with every event.
 */

/** How many failed searches in a row give a store up (a third failure gives up). */
export const LOOKUP_ATTEMPT_CAP = 3;

/** How long a run holds a search before another run may take it: 15 minutes, from the claim's time. */
export const LOOKUP_LEASE_MS = 15 * 60 * 1000;

/** The row's own context: how many searches have failed in a row. */
export type StoreLookupContext = { attempts: number };

export const storeLookupMachine = setup({}).createMachine({
	id: "storeLookup",
	initial: "none",
	context: { attempts: 0 },
	states: {
		none: {
			description: "No lookup yet",
			on: {
				CLAIM: { target: "claimed", description: "A run takes the search" },
				PRIVATE: {
					target: "skipped",
					description: "The store's text is private, so it is never searched",
				},
			},
		},
		claimed: {
			description: "A run holds the search",
			on: {
				SAVE_FOUND: { target: "found", description: "The search gave a line" },
				SAVE_NOTHING: {
					target: "nothing_found",
					description: "The search gave no plain answer",
				},
				SEARCH_FAILED: ({ context }) =>
					context.attempts + 1 >= LOOKUP_ATTEMPT_CAP
						? {
								target: "gave_up",
								context: { attempts: context.attempts + 1 },
							}
						: {
								target: "to_retry",
								context: { attempts: context.attempts + 1 },
							},
				LEASE_EXPIRED: {
					target: "to_retry",
					description: "The lease ran out; no failure is counted",
				},
				LET_GO: {
					target: "to_retry",
					description: "The run gave the store back; no failure is counted",
				},
			},
		},
		to_retry: {
			description: "Waiting for a run to take the search again",
			on: {
				CLAIM: { target: "claimed", description: "A later run takes it" },
				PRIVATE: { target: "skipped", description: "The text is private" },
			},
		},
		found: {
			description: "A line is kept",
			on: {
				DONT_USE: {
					target: "skipped",
					description: "A person does not want this line",
				},
				PRIVATE: {
					target: "skipped",
					description: "A later row with the same text is private",
				},
			},
		},
		nothing_found: {
			type: "final",
			description: "The search gave no plain answer",
		},
		gave_up: {
			type: "final",
			description: "Three searches in a row failed",
		},
		skipped: {
			type: "final",
			description: "Never searched, or its line was turned off",
		},
	},
});

/** The state a stored lookup is in. `none` is no row at all. */
export type StoreLookupState = keyof typeof storeLookupMachine.states;

/**
 * How each state is stored in `merchant_lookups`: its `status`. Two states share `pending`: a claimed row and a
 * to_retry row, which storeLookupState tells apart by the lease. `none` is no row (status null). Typed by state.
 */
export const STORE_LOOKUP_ROWS: Record<
	StoreLookupState,
	{ status: (typeof MERCHANT_LOOKUP_STATUS_VALUES)[number] | null }
> = {
	none: { status: null },
	claimed: { status: "pending" },
	to_retry: { status: "pending" },
	found: { status: "found" },
	nothing_found: { status: "nothing_found" },
	skipped: { status: "skipped" },
	gave_up: { status: "gave_up" },
};

/** The statuses a stored lookup may have, from the rows above (the CHECK on merchant_lookups.status). */
export const STORE_LOOKUP_STATUS_VALUES = [
	...new Set(
		Object.values(STORE_LOOKUP_ROWS).flatMap((row) =>
			row.status === null ? [] : [row.status],
		),
	),
];

/** The fields of a stored lookup that say which state a pending row is in. */
export type StoreLookupRow = {
	status: string;
	claimedBy: string | null;
	claimedAt: string | null;
};

/**
 * The state a stored lookup is in, the reverse of STORE_LOOKUP_ROWS. A pending row is claimed while a run holds it
 * (claimed_by set, and its lease from claimed_at not yet over at `now`), and to_retry otherwise.
 */
export function storeLookupState(
	row: StoreLookupRow | null,
	now: Date,
): StoreLookupState {
	if (row === null) return "none";

	switch (row.status) {
		case "found":
		case "nothing_found":
		case "skipped":
		case "gave_up":
			return row.status;
		case "pending": {
			const held =
				row.claimedBy !== null &&
				row.claimedAt !== null &&
				Date.parse(row.claimedAt) + LOOKUP_LEASE_MS > now.getTime();

			return held ? "claimed" : "to_retry";
		}

		default:
			throw new Error(`Unknown lookup status "${row.status}"`);
	}
}

import { setup } from "xstate";
// Type-only: erased at build time, so this machine never pulls in the Drizzle runtime.
import type { MERCHANT_STATUS_VALUES } from "../db/schema";

/**
 * The name Tally suggests for a bank's text ("AMZN Mktp US*2K4" becomes "Amazon"), in plain words:
 *
 *   none     --bank name-> waiting   the bank (Plaid) sent a name of its own
 *   none     --names-->    waiting   Workers AI offered names
 *   none     --no names-> asked      Workers AI answered with no usable name, so the text is not asked again
 *   asked    --bank name-> waiting   the bank sent a name after all
 *   waiting  --bank name-> waiting   a newer bank name replaces the one waiting
 *   waiting  --accept-->  accepted   a person picks one of the suggested names
 *   waiting  --reject-->  rejected   a person types their own, or keeps the bank's text
 *   waiting  --withdraw-> none       the suggestion went stale (a newer Plaid name, or Plaid now names it)
 *
 * Accepted and rejected are final: a decided suggestion is never touched again. Every move also needs the merchant
 * to have no name a person chose (`display_name IS NULL`); that is a column, not a state, so the SQL checks it and
 * this machine does not repeat it.
 *
 * `none` and `asked` are one stored status, `none`: an asked text is kept as `names_asked = 1` with no name rows,
 * which is what stops Workers AI asking about it again, while a bank name can still replace it. MERCHANT_SUGGESTION_ROWS
 * says how each state is stored. The real writes are SQL (src/db/merchant-names.ts, src/db/transactions.ts,
 * src/plaid/sync.ts); this machine is the one place the rule is stated, and test/suggestion-machines.test.ts runs
 * the store functions against it.
 */
export const merchantSuggestionMachine = setup({}).createMachine({
	id: "merchant-suggestion",
	initial: "none",
	states: {
		none: {
			description: "No suggestion yet, and Tally has not guessed",
			on: {
				BANK_NAME: {
					target: "pending",
					description: "The bank sends a name of its own",
				},
				NAMES: {
					target: "pending",
					description: "Tally guesses some names",
				},
				NO_NAMES: {
					target: "asked",
					description: "Tally has no usable guess, so it does not guess again",
				},
			},
		},
		asked: {
			description: "Tally guessed and had no usable name",
			on: {
				BANK_NAME: {
					target: "pending",
					description: "The bank sends a name of its own",
				},
			},
		},
		pending: {
			description: "Waiting for a person to decide",
			on: {
				BANK_NAME: {
					target: "pending",
					description: "A newer bank name replaces this one",
				},
				ACCEPT: {
					target: "accepted",
					description: "A person picks a suggested name",
				},
				REJECT: {
					target: "rejected",
					description: "A person types their own name, or keeps the bank's",
				},
				WITHDRAW: {
					target: "none",
					description: "The suggestion went stale",
				},
			},
		},
		accepted: {
			type: "final",
			description: "A suggested name was accepted",
		},
		rejected: {
			type: "final",
			description: "The suggestion was turned down",
		},
	},
});

/** The short word each state wears in a diagram box. Typed by state, so a new state fails to compile until it has one. */
export const MERCHANT_SUGGESTION_LABELS: Record<
	keyof typeof merchantSuggestionMachine.states,
	string
> = {
	none: "None",
	asked: "Asked",
	pending: "Waiting",
	accepted: "Accepted",
	rejected: "Declined",
};

/**
 * How each state is stored in `merchants` and `merchant_suggested_names`: its `suggestion_status`, whether `names_asked`
 * is set, and its names (the rows, in position order). Two states share the status `none`; only `names_asked` tells
 * them apart. Typed by state.
 */
export const MERCHANT_SUGGESTION_ROWS: Record<
	keyof typeof merchantSuggestionMachine.states,
	{
		status: (typeof MERCHANT_STATUS_VALUES)[number];
		namesAsked: boolean;
		names: string[];
	}
> = {
	none: { status: "none", namesAsked: false, names: [] },
	asked: { status: "none", namesAsked: true, names: [] },
	pending: { status: "pending", namesAsked: false, names: ["Zed Cafe"] },
	accepted: { status: "accepted", namesAsked: false, names: ["Zed Cafe"] },
	rejected: { status: "rejected", namesAsked: false, names: ["Zed Cafe"] },
};

/** The values the database's CHECK on `merchants.suggestion_status` allows, from the rows above. */
export const MERCHANT_SUGGESTION_STATUSES = [
	...new Set(Object.values(MERCHANT_SUGGESTION_ROWS).map((r) => r.status)),
];

/** The state a stored row is in, the reverse of MERCHANT_SUGGESTION_ROWS. */
export function merchantSuggestionState(row: {
	status: string;
	namesAsked: boolean;
	names: string[];
}): keyof typeof MERCHANT_SUGGESTION_ROWS {
	if (row.status === "none") return row.namesAsked ? "asked" : "none";
	if (
		row.status === "pending" ||
		row.status === "accepted" ||
		row.status === "rejected"
	)
		return row.status;
	throw new Error(`Unknown suggestion status "${row.status}"`);
}

/** The state a suggestion is shown from: offered, and not yet decided. test/suggestion-machines.test.ts checks it is a state of the machine. */
export const MERCHANT_SUGGESTION_WAITING = "pending";

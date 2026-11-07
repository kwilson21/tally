import { setup } from "xstate";

/**
 * The name Tally suggests for a bank's text ("AMZN Mktp US*2K4" becomes "Amazon"), in plain words:
 *
 *   nothing  --suggest--> waiting   Workers AI or Plaid offers a name
 *   waiting  --suggest--> waiting   a newer name replaces the one waiting
 *   waiting  --accept-->  accepted  a person picks one of the suggested names
 *   waiting  --reject-->  rejected  a person types their own, or keeps the bank's text
 *   waiting  --withdraw-> nothing   the suggestion went stale (a newer Plaid name, or Plaid now names it)
 *
 * Accepted and rejected are final: a decided suggestion is never touched again. Every move also needs the merchant
 * to have no name a person chose (`display_name IS NULL`); that is a column, not a state, so the SQL checks it and
 * this machine does not repeat it.
 *
 * The real writes are SQL (src/db/merchant-names.ts, src/db/transactions.ts, src/plaid/sync.ts); this machine is
 * the one place the rule is stated, and test/suggestion-machines.test.ts runs the store functions against it.
 */
export const merchantSuggestionMachine = setup({}).createMachine({
	id: "merchant-suggestion",
	initial: "none",
	states: {
		none: {
			description: "No suggestion yet",
			on: {
				SUGGEST: { target: "pending", description: "A name is offered" },
			},
		},
		pending: {
			description: "Waiting for a person to decide",
			on: {
				SUGGEST: {
					target: "pending",
					description: "A newer name replaces this one",
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

/** The values the database's CHECK on `merchants.suggestion_status` allows, from the machine itself. */
export const MERCHANT_SUGGESTION_STATUSES = Object.keys(
	merchantSuggestionMachine.config.states ?? {},
);

/** The short word each state wears in a diagram box. Typed by state, so a new state fails to compile until it has one. */
export const MERCHANT_SUGGESTION_LABELS: Record<string, string> = {
	none: "None",
	pending: "Waiting",
	accepted: "Accepted",
	rejected: "Declined",
};

/** The state a suggestion is shown from: offered, and not yet decided. test/suggestion-machines.test.ts checks it is a state of the machine. */
export const MERCHANT_SUGGESTION_WAITING = "pending";

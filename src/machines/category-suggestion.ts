import { setup } from "xstate";

/**
 * A suggested new category ("Pet Care", from three purchases Jev found no category for), in plain words:
 *
 *   waiting  --accept-->  made       a person created the category, or added the purchases to one
 *   waiting  --dismiss--> dismissed  a person said no; the name is never suggested again
 *   waiting  --empty-->   nothing    no purchase backs it any more, so it quietly goes away
 *
 * Made, dismissed and nothing are final. A suggestion is born `pending` when Jev gave a name and at least three
 * purchases share it, and `none` when the group has no usable name (it only holds those purchases together).
 *
 * The real writes are the compare-and-set statements in src/db/category-suggestions.ts (`WHERE status = 'pending'`);
 * this machine is the one place the rule is stated, and test/suggestion-machines.test.ts runs every store function
 * against it. The claim stamp (`decided_at`) that keeps two people from deciding at once is not a state: it is a
 * guard inside the accept write, drawn here only as a note.
 */
export const categorySuggestionMachine = setup({}).createMachine({
	id: "category-suggestion",
	initial: "pending",
	states: {
		pending: {
			description: "Waiting for a person to decide",
			on: {
				ACCEPT: {
					target: "created",
					description:
						"A person creates the category, or adds the ticked purchases to it",
				},
				DISMISS: {
					target: "dismissed",
					description: "A person says no",
				},
				EMPTY: {
					target: "none",
					description: "No purchase is suggested for it any more",
				},
			},
		},
		created: {
			type: "final",
			description: "The category was made",
		},
		dismissed: {
			type: "final",
			description: "Dismissed, and never suggested again",
		},
		none: {
			type: "final",
			description: "Gone, or never had a name",
		},
	},
});

/** The values the database's CHECK on `category_suggestions.status` allows, from the machine itself. */
export const CATEGORY_SUGGESTION_STATUSES = Object.keys(
	categorySuggestionMachine.config.states ?? {},
);

/** The short word each state wears in a diagram box. Typed by state, so a new state fails to compile until it has one. */
export const CATEGORY_SUGGESTION_LABELS: Record<string, string> = {
	pending: "Waiting",
	created: "Made",
	dismissed: "Dismissed",
	none: "Gone",
};

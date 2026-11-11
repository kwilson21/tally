import { setup } from "xstate";

/**
 * A suggested new category ("Pet Care", from three purchases Jev found no category for), in plain words:
 *
 *   waiting  --accept-->  made       a person created the category, or added the purchases to one
 *   waiting  --dismiss--> dismissed  a person said no; the name is never suggested again
 *   waiting  --empty-->   nothing    no purchase backs it any more, so it quietly goes away
 *
 * Made, dismissed and nothing are final. A group of purchases Jev found no category for starts as `born`, which is
 * never stored: three or more purchases and a usable name make a `pending` row, and three or more with no usable
 * name make a `none` row that only holds the group together, so it is not asked about again.
 *
 *   born     --name-->    waiting   a usable name came back
 *   born     --nameless-> nothing   no usable name came back
 *
 * The real writes are the compare-and-set statements in src/db/category-suggestions.ts (`WHERE status = 'pending'`);
 * this machine is the one place the rule is stated, and test/suggestion-machines.test.ts runs every store function
 * against it. The claim stamp (`decided_at`) that keeps two people from deciding at once is not a state: it is a
 * guard inside the accept write, drawn here only as a note.
 */
/** Every state of the machine, once. The machine's `states` and the diagram labels below must both match it, or the build fails. */
export const CATEGORY_SUGGESTION_STATES = [
	"born",
	"pending",
	"created",
	"dismissed",
	"none",
] as const;

export type CategorySuggestionState =
	(typeof CATEGORY_SUGGESTION_STATES)[number];

export const categorySuggestionMachine = setup({}).createMachine({
	id: "category-suggestion",
	initial: "born",
	states: {
		born: {
			description: "A group of purchases Jev found no category for",
			on: {
				NAME: {
					target: "pending",
					description: "A usable name came back for the group",
				},
				NAMELESS: {
					target: "none",
					description:
						"No usable name came back, so the group is kept only so it is not asked about again",
				},
			},
		},
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

/** The state a suggestion has before any row exists. It is never stored, so the database's CHECK does not list it. */
export const CATEGORY_SUGGESTION_UNSAVED = "born";

/** The values the database's CHECK on `category_suggestions.status` allows: every state but the unsaved one. */
export const CATEGORY_SUGGESTION_STATUSES = Object.keys(
	categorySuggestionMachine.config.states ?? {},
).filter((state) => state !== CATEGORY_SUGGESTION_UNSAVED);

/** The short word each state wears in a diagram box. Typed by state, so a new state fails to compile until it has one. */
export const CATEGORY_SUGGESTION_LABELS: Record<
	CategorySuggestionState,
	string
> = {
	born: "Found",
	pending: "Waiting",
	created: "Made",
	dismissed: "Dismissed",
	none: "Gone",
};

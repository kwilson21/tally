import { setup } from "xstate";

/**
 * The sorting turn (decision 139): one sorting group at a time may ask Jev about the household's transactions, so two
 * runs never ask about the same one. It is a lease, and in plain words:
 *
 *   state \ event   take          retake        release       holds         expire
 *   free            held          held          -             -             -
 *   held            -             held          free          held          ran out
 *   ran out         held          held          free          ran out       -
 *
 *   take     a group that is not the holder asks: it gets the turn when it is free or has run out, never a live one
 *   retake   the holder asks again (a retried read takes its own turn back), with a fresh 15 minutes
 *   release  the holder gives the turn back, live or run out
 *   holds    a save's statement checks the turn is still the holder's before it writes; it passes even after the turn
 *            ran out, as long as nobody took it since
 *   expire   the clock passes the turn's `until`: another group may now take it
 *
 * A turn with no `until` counts as ran out, so it can never block forever. "-" means the event is refused and nothing
 * changes. Whether the asker is the holder is the id the statement binds, so the event says it ("take" is another
 * group's, "retake", "release" and "holds" are the holder's); no state stores it.
 *
 * The real writes are the single compare-and-set statements in src/db/sorting-turn.ts; this machine is the one place
 * the rule is stated, and test/sorting-turn-machine.test.ts runs every state against every event through them.
 */
export const sortingTurnMachine = setup({}).createMachine({
	id: "sorting-turn",
	initial: "free",
	states: {
		free: {
			description: "Nobody has the turn",
			on: {
				TAKE: {
					target: "held",
					description: "A group takes the free turn",
				},
				RETAKE: {
					target: "held",
					description: "A group takes the turn it had given back or lost",
				},
			},
		},
		held: {
			description: "A group has the turn, and its time has not run out",
			on: {
				RETAKE: {
					target: "held",
					description:
						"The holder takes its own turn back, with a fresh 15 minutes",
				},
				RELEASE: {
					target: "free",
					description: "The holder gives the turn back",
				},
				HOLDS: {
					target: "held",
					description: "A save checks the turn is still the holder's",
				},
				EXPIRE: {
					target: "expired",
					description: "The turn's time is up",
				},
			},
		},
		expired: {
			description: "The turn's time ran out and nobody has taken it since",
			on: {
				TAKE: {
					target: "held",
					description: "Another group takes the turn that ran out",
				},
				RETAKE: {
					target: "held",
					description:
						"The holder takes its own turn back, with a fresh 15 minutes",
				},
				RELEASE: {
					target: "free",
					description: "The holder gives the turn back",
				},
				HOLDS: {
					target: "expired",
					description: "A save still finds the turn is the holder's",
				},
			},
		},
	},
});

/** The short word each state wears in a diagram box. Typed by state, so a new state fails to compile until it has one. */
export const SORTING_TURN_LABELS: Record<
	keyof typeof sortingTurnMachine.states,
	string
> = {
	free: "Free",
	held: "Held",
	expired: "Ran out",
};

import { setup } from "xstate";

/**
 * The state of a transaction's "what it was" note (decision 172), as an XState v6 machine. Its states are the
 * values of `transactions.note_state`, and each `on` map lists only the moves that are legal. An event a state does
 * not list is refused: `next()` (src/machines/next.ts) returns null for it, and the writer leaves the note as it is.
 * The SQL writers enforce the same moves with compare-and-set guards; the test walks every state and event.
 *
 * In plain words:
 * - unasked: Jev has not been asked the note question yet. Jev's answer decides the next state.
 * - unanswered: Jev was asked, but the note question has no answer (rows from before migration 0042).
 * - no_call: Jev said a note would not say more than the store's name, so Workers AI is not asked.
 * - queued: Jev said a note is worth writing, and Workers AI has not answered yet.
 * - failed: Workers AI failed to answer. It stays queued, after the notes that never failed, and never expires.
 * - tried_empty: Workers AI answered with no note.
 * - emptied_by_person: a person emptied the note, so it is never asked for again.
 * - guessed: Workers AI wrote a note, shown dashed until a person keeps it or empties it.
 * - written: a person's note, or a guess a person kept.
 * - dismissed: a person emptied a guess.
 *
 * The grid (state by event; a dash is refused):
 *
 *                     jev    jev    jev     ai      ai     ai      person  person   person
 *   state             worth  no     no ans  guess   empty  fails   wrote   emptied  kept
 *   unasked           queued no_call unans  -       -      -       written emptied  -
 *   unanswered        -      -      -       -       -      -       written emptied  -
 *   no_call           -      -      -       -       -      -       written emptied  -
 *   queued            -      -      -       guessed tried  failed  written emptied  -
 *   failed            -      -      -       guessed tried  failed  written emptied  -
 *   tried_empty       -      -      -       -       -      -       written emptied  -
 *   emptied_by_person -      -      -       -       -      -       written -        -
 *   guessed           -      -      -       -       -      -       written dismissed written
 *   written           -      -      -       -       -      -       -       emptied  -
 *   dismissed         -      -      -       -       -      -       written -        -
 */
export const noteStateMachine = setup({}).createMachine({
	id: "note_state",
	initial: "unasked",
	states: {
		unasked: {
			on: {
				jev_worth: { target: "queued" },
				jev_not_worth: { target: "no_call" },
				jev_no_answer: { target: "unanswered" },
				person_wrote: { target: "written" },
				person_emptied: { target: "emptied_by_person" },
			},
		},
		unanswered: {
			on: {
				person_wrote: { target: "written" },
				person_emptied: { target: "emptied_by_person" },
			},
		},
		no_call: {
			on: {
				person_wrote: { target: "written" },
				person_emptied: { target: "emptied_by_person" },
			},
		},
		queued: {
			on: {
				ai_guessed: { target: "guessed" },
				ai_empty: { target: "tried_empty" },
				ai_failed: { target: "failed" },
				person_wrote: { target: "written" },
				person_emptied: { target: "emptied_by_person" },
			},
		},
		failed: {
			on: {
				ai_guessed: { target: "guessed" },
				ai_empty: { target: "tried_empty" },
				ai_failed: { target: "failed" },
				person_wrote: { target: "written" },
				person_emptied: { target: "emptied_by_person" },
			},
		},
		tried_empty: {
			on: {
				person_wrote: { target: "written" },
				person_emptied: { target: "emptied_by_person" },
			},
		},
		emptied_by_person: {
			on: {
				person_wrote: { target: "written" },
			},
		},
		guessed: {
			on: {
				person_wrote: { target: "written" },
				person_emptied: { target: "dismissed" },
				person_kept: { target: "written" },
			},
		},
		written: {
			on: {
				person_emptied: { target: "emptied_by_person" },
			},
		},
		dismissed: {
			on: {
				person_wrote: { target: "written" },
			},
		},
	},
});

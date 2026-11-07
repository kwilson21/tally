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

/** The ten states, as a type. The machine's own keys are the runtime list, and a test checks the two agree. */
export type NoteState =
	| "unasked"
	| "unanswered"
	| "no_call"
	| "queued"
	| "failed"
	| "tried_empty"
	| "emptied_by_person"
	| "guessed"
	| "written"
	| "dismissed";

/** The states, in the machine's order. */
export const NOTE_STATES = Object.keys(
	noteStateMachine.config.states ?? {},
) as NoteState[];

/**
 * How far along a note is, for the pending-to-posted merge (decision 172): the later state wins, and a tie keeps the
 * posted row's state. In plain words:
 * - unasked (0): nothing has been asked yet, so any answer beats it.
 * - unanswered (1): Jev was asked the detail question but gave no answer to the note question; a Jev answer beats it.
 * - no_call (2) and queued (2): Jev's answer. They tie, so the posted row's own answer stays: the merge moves a note
 *   only when the pending one is strictly later.
 * - failed (3): Workers AI failed; a later try beats it.
 * - tried_empty (4): Workers AI answered with no note; a guess beats it.
 * - guessed (5): Workers AI wrote a note. It is a machine's act, so a person's act beats it.
 * - emptied_by_person (6) and dismissed (6): a person emptied the note, or emptied a guess. A person's act beats any
 *   machine's act, and a guess copied onto a dismissed row never wins.
 * - written (7): a person's own note, or a guess a person kept. It is the newest and most personal act, so it wins.
 */
export const NOTE_RANK: Record<NoteState, number> = {
	unasked: 0,
	unanswered: 1,
	no_call: 2,
	queued: 2,
	failed: 3,
	tried_empty: 4,
	guessed: 5,
	emptied_by_person: 6,
	dismissed: 6,
	written: 7,
};

/** The later of two states. On a tie the first one (the posted row's) is kept. */
export function laterNoteState(a: NoteState, b: NoteState): NoteState {
	return NOTE_RANK[b] > NOTE_RANK[a] ? b : a;
}

/** The rank of a note state, as an SQL CASE over the expression (a column or a bound value). Built from NOTE_RANK. */
export function noteRankSql(expression: string): string {
	const whens = NOTE_STATES.map(
		(state) => `WHEN '${state}' THEN ${NOTE_RANK[state]}`,
	).join(" ");
	return `(CASE ${expression} ${whens} END)`;
}

/** SQL: 1 when the pending note is strictly later than the posted one, else 0 (the merge keeps the posted row on a tie). */
export function pendingNoteWinsSql(pending: string, posted: string): string {
	return `${noteRankSql(pending)} > ${noteRankSql(posted)}`;
}

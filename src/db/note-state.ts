/**
 * The state of a transaction's "what it was" note (decision 172). The states, their moves and their ranks live in the
 * XState v6 machine (src/machines/note-state.ts). The real writes are SQL compare-and-set guards in the writers
 * (transactions.ts, pending-merge.ts), and the tests walk every state and event against the machine.
 *
 * Here: the event names, the queue check, and the SQL helpers the writers share.
 */
import { next } from "../machines/next";
import {
	NOTE_STATES,
	type NoteState,
	noteStateMachine,
} from "../machines/note-state";

export { NOTE_STATES, type NoteState } from "../machines/note-state";

/** What happens to a note: Jev's answer, Workers AI's answer, or a person's edit of the note. */
export const NOTE_EVENTS = [
	"jev_worth",
	"jev_not_worth",
	"jev_no_answer",
	"ai_guessed",
	"ai_empty",
	"ai_failed",
	"person_wrote",
	"person_emptied",
	"person_kept",
] as const;

export type NoteEvent = (typeof NOTE_EVENTS)[number];

/**
 * The state the note moves to on this event, or null when the machine refuses the event from this state. A writer
 * that gets null leaves the note as it is.
 */
export function nextNoteState(
	state: NoteState,
	event: NoteEvent,
): NoteState | null {
	const after = next(noteStateMachine, state, event);

	if (after === null) return null;

	// SAFETY: next() returns a top-level state of noteStateMachine, and every such state is a NoteState (NOTE_STATES lists them).
	return after as NoteState;
}

/** The state after an event, where a refused event keeps the state. For the writers that always store a state. */
export function afterNoteEvent(state: NoteState, event: NoteEvent): NoteState {
	return nextNoteState(state, event) ?? state;
}

export function assertNever(value: never): never {
	throw new Error(`Unexpected value: ${String(value)}`);
}

/** Whether Workers AI is asked for this note: a queued note, or a failed one that is asked again after the rest. */
export function isQueuedNote(state: NoteState): boolean {
	switch (state) {
		case "queued":
		case "failed":
			return true;
		case "unasked":
		case "unanswered":
		case "no_call":
		case "tried_empty":
		case "emptied_by_person":
		case "guessed":
		case "written":
		case "dismissed":
			return false;
		default:
			return assertNever(state);
	}
}

/** The SQL list of states, for `note_state IN (...)`. */
export function noteStateList(states: readonly NoteState[]): string {
	return states.map((state) => `'${state}'`).join(", ");
}

export const QUEUED_NOTE_SQL = noteStateList(NOTE_STATES.filter(isQueuedNote));

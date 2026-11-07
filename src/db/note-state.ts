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
	return next(noteStateMachine, state, event) as NoteState | null;
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

/**
 * The state a row with no guess and no person's note has, from its flags, for the states the pipeline moves through.
 * The merge uses it after it has merged the flags, so a state never disagrees with the Jev answer beside it.
 */
export function pipelineNoteStateSql(table: string): string {
	const t = table;
	return `CASE
		WHEN ${t}.note_dismissed = 1 THEN 'dismissed'
		WHEN ${t}.note_tried_at IS NOT NULL AND NOT (${t}.details_asked = 1 AND ${t}.note_worth_writing IS 1) THEN 'emptied_by_person'
		WHEN ${t}.note_tried_at IS NOT NULL THEN 'tried_empty'
		WHEN ${t}.details_asked = 0 THEN 'unasked'
		WHEN ${t}.note_worth_writing = 0 THEN 'no_call'
		WHEN ${t}.note_worth_writing IS NULL THEN 'unanswered'
		WHEN ${t}.note_failed_at IS NOT NULL THEN 'failed'
		ELSE 'queued' END`;
}

export const QUEUED_NOTE_SQL = noteStateList(NOTE_STATES.filter(isQueuedNote));
export const PIPELINE_NOTE_SQL = noteStateList([
	"unasked",
	"unanswered",
	"no_call",
	"queued",
	"failed",
	"tried_empty",
]);

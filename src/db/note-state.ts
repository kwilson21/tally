/**
 * The state of a transaction's "what it was" note (decision 172). The moves between states are an XState v6 machine
 * (src/machines/note-state.ts), asked through `next()`. The real writes are SQL compare-and-set guards in the writers
 * (transactions.ts, pending-merge.ts), and the tests walk every state and event against the machine.
 *
 * Plain words for each state are on the machine. Here, the list of states and events, the queue check, and the SQL
 * helpers the writers share.
 */
import { next } from "../machines/next";
import { noteStateMachine } from "../machines/note-state";

/** The states, in the machine's order. The migration's CHECK lists the same ten. */
export const NOTE_STATES = Object.keys(
	noteStateMachine.config.states ?? {},
) as NoteState[];

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

/** The later of two states, for the merge. A person's act is later than a machine's, and a later Jev answer than none. */
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

/** The SQL list of states, for `note_state IN (...)`. */
export function noteStateList(states: readonly NoteState[]): string {
	return states.map((state) => `'${state}'`).join(", ");
}

/** The rank of a note state column, for comparing two rows in SQL. */
export function noteRankSql(column: string): string {
	const whens = NOTE_STATES.map(
		(state) => `WHEN '${state}' THEN ${NOTE_RANK[state]}`,
	).join(" ");
	return `(CASE ${column} ${whens} END)`;
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

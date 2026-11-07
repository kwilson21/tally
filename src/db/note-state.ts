/**
 * The one state of a transaction's "what it was" note. It replaces reading note_guessed, note_tried_at,
 * note_failed_at, note_dismissed and note_worth_writing together to decide what the note is and whether Workers
 * AI is asked for it. Every writer sets it in the same statement as the note. The old columns are still written,
 * but nothing decides from them.
 *
 * In plain words:
 * - unasked: Jev has not been asked the note question yet.
 * - unanswered: Jev was asked, but the note question was never answered (rows from before migration 0042).
 * - no_call: Jev said a note would not say more than the store's name, so Workers AI is not asked.
 * - queued: Jev said a note is worth writing, and Workers AI has not been asked yet.
 * - failed: Workers AI failed to answer. It stays queued, after the notes that never failed.
 * - tried_empty: Workers AI answered with no note.
 * - emptied_by_person: a person emptied the note, so it is never asked for again.
 * - guessed: Workers AI wrote a note, shown dashed until a person keeps it or empties it.
 * - written: a person's note, or a guess a person kept.
 * - dismissed: a person emptied a guess.
 */
export const NOTE_STATES = [
	"unasked",
	"unanswered",
	"no_call",
	"queued",
	"failed",
	"tried_empty",
	"emptied_by_person",
	"guessed",
	"written",
	"dismissed",
] as const;

export type NoteState = (typeof NOTE_STATES)[number];

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
 * The transition grid: the state the note moves to, for each state (a row) and event (a column). `null` means the event
 * leaves the state as it is. Jev's answers only apply to a note nobody has asked about yet, and a person's words always
 * win over a machine's, except that a person's empty note is never filled in again.
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
const GRID: Record<NoteState, Record<NoteEvent, NoteState | null>> = {
	unasked: {
		jev_worth: "queued",
		jev_not_worth: "no_call",
		jev_no_answer: "unanswered",
		ai_guessed: null,
		ai_empty: null,
		ai_failed: null,
		person_wrote: "written",
		person_emptied: "emptied_by_person",
		person_kept: null,
	},
	unanswered: {
		jev_worth: null,
		jev_not_worth: null,
		jev_no_answer: null,
		ai_guessed: null,
		ai_empty: null,
		ai_failed: null,
		person_wrote: "written",
		person_emptied: "emptied_by_person",
		person_kept: null,
	},
	no_call: {
		jev_worth: null,
		jev_not_worth: null,
		jev_no_answer: null,
		ai_guessed: null,
		ai_empty: null,
		ai_failed: null,
		person_wrote: "written",
		person_emptied: "emptied_by_person",
		person_kept: null,
	},
	queued: {
		jev_worth: null,
		jev_not_worth: null,
		jev_no_answer: null,
		ai_guessed: "guessed",
		ai_empty: "tried_empty",
		ai_failed: "failed",
		person_wrote: "written",
		person_emptied: "emptied_by_person",
		person_kept: null,
	},
	failed: {
		jev_worth: null,
		jev_not_worth: null,
		jev_no_answer: null,
		ai_guessed: "guessed",
		ai_empty: "tried_empty",
		ai_failed: null,
		person_wrote: "written",
		person_emptied: "emptied_by_person",
		person_kept: null,
	},
	tried_empty: {
		jev_worth: null,
		jev_not_worth: null,
		jev_no_answer: null,
		ai_guessed: null,
		ai_empty: null,
		ai_failed: null,
		person_wrote: "written",
		person_emptied: "emptied_by_person",
		person_kept: null,
	},
	emptied_by_person: {
		jev_worth: null,
		jev_not_worth: null,
		jev_no_answer: null,
		ai_guessed: null,
		ai_empty: null,
		ai_failed: null,
		person_wrote: "written",
		person_emptied: null,
		person_kept: null,
	},
	guessed: {
		jev_worth: null,
		jev_not_worth: null,
		jev_no_answer: null,
		ai_guessed: null,
		ai_empty: null,
		ai_failed: null,
		person_wrote: "written",
		person_emptied: "dismissed",
		person_kept: "written",
	},
	written: {
		jev_worth: null,
		jev_not_worth: null,
		jev_no_answer: null,
		ai_guessed: null,
		ai_empty: null,
		ai_failed: null,
		person_wrote: null,
		person_emptied: "emptied_by_person",
		person_kept: null,
	},
	dismissed: {
		jev_worth: null,
		jev_not_worth: null,
		jev_no_answer: null,
		ai_guessed: null,
		ai_empty: null,
		ai_failed: null,
		person_wrote: "written",
		person_emptied: null,
		person_kept: null,
	},
};

/** The state after an event. An event the grid leaves out, for this state, keeps the state. */
export function nextNoteState(state: NoteState, event: NoteEvent): NoteState {
	return GRID[state][event] ?? state;
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

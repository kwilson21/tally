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
 * posted row's state. In plain words, why each state ranks where it does:
 * - unasked (0): nothing has been asked yet, so any answer beats it.
 * - unanswered (1): Jev was asked the detail question but gave no answer to the note question, so a Jev answer beats it.
 * - queued (2), failed (3), tried_empty (4): an attempt is in progress or unresolved on the older row. A posted row's Jev
 *   answer is newer than the pending row's attempt, so none of these beats a posted no_call.
 * - no_call (5): Jev said no. It is a settled answer, so it outranks every unresolved attempt above.
 * - guessed (6): Workers AI wrote a note, which is a note in the row. It outranks a Jev no, since a note is more than a
 *   verdict.
 * - emptied_by_person (7) and dismissed (7): a person emptied the note, or emptied a guess. A person's act beats any
 *   machine's act, and a guess copied onto a dismissed row never wins.
 * - written (8): a person's own note, or a guess a person kept. It is the newest and most personal act, so it wins.
 */
export const NOTE_RANK: Record<NoteState, number> = {
	unasked: 0,
	unanswered: 1,
	queued: 2,
	failed: 3,
	tried_empty: 4,
	no_call: 5,
	guessed: 6,
	emptied_by_person: 7,
	dismissed: 7,
	written: 8,
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

/** The values the two rows of a merge hold for the flags a state does not decide. */
export type FlagsHeld = {
	detailsAsked: number;
	worth: number | null;
	tried: string | null;
	failed: string | null;
};

/**
 * The compatibility flags each state implies (decision 172). The flags are not read for any decision any more; they are
 * written so an older reader sees the same story as the state. A number or null is what the state implies. "set" means
 * the state implies a stamp, and "keep" means the state does not decide the flag, so the row keeps what it holds:
 * - details_asked: "keep" is the larger of the two rows' answers (a question asked is never un-asked by a merge).
 * - note_worth_writing: "keep" is the posted row's Jev answer, or the pending row's when the posted row has none.
 * - note_tried_at and note_failed_at: "keep" and "set" are the posted row's stamp, or the pending row's when it has none.
 */
type FlagRule = {
	details: 0 | 1 | "keep";
	worth: 0 | 1 | null | "keep";
	tried: "set" | null | "keep";
	failed: "set" | null | "keep";
	dismissed: 0 | 1;
	guessed: 0 | 1;
};

export const FLAG_RULES: Record<NoteState, FlagRule> = {
	// Nothing has been asked: no question, no answer, no try and no failure.
	unasked: {
		details: 0,
		worth: null,
		tried: null,
		failed: null,
		dismissed: 0,
		guessed: 0,
	},
	// Jev was asked the detail question and has no answer about a note.
	unanswered: {
		details: 1,
		worth: null,
		tried: null,
		failed: null,
		dismissed: 0,
		guessed: 0,
	},
	// Jev said no: no note is ever asked for.
	no_call: {
		details: 1,
		worth: 0,
		tried: null,
		failed: null,
		dismissed: 0,
		guessed: 0,
	},
	// Jev said yes, and no call has been made.
	queued: {
		details: 1,
		worth: 1,
		tried: null,
		failed: null,
		dismissed: 0,
		guessed: 0,
	},
	// The call failed: the failure is stamped and the try is not.
	failed: {
		details: 1,
		worth: 1,
		tried: null,
		failed: "set",
		dismissed: 0,
		guessed: 0,
	},
	// Workers AI answered empty. A failure stamp from before it stays.
	tried_empty: {
		details: 1,
		worth: 1,
		tried: "set",
		failed: "keep",
		dismissed: 0,
		guessed: 0,
	},
	// A person emptied the note. The question and answer are whatever the rows already held.
	emptied_by_person: {
		details: "keep",
		worth: "keep",
		tried: "set",
		failed: "keep",
		dismissed: 0,
		guessed: 0,
	},
	// Workers AI wrote a note.
	guessed: {
		details: 1,
		worth: 1,
		tried: "set",
		failed: "keep",
		dismissed: 0,
		guessed: 1,
	},
	// A person's note, or a kept guess. The question and answer are whatever the rows already held.
	written: {
		details: "keep",
		worth: "keep",
		tried: "keep",
		failed: "keep",
		dismissed: 0,
		guessed: 0,
	},
	// A person emptied a guess.
	dismissed: {
		details: 1,
		worth: 1,
		tried: "set",
		failed: "keep",
		dismissed: 1,
		guessed: 0,
	},
};

/** The stamp a "set" flag gets when neither row holds one. A merge always has one, since the winning state implies it. */
const STAMP_FALLBACK = "1970-01-01 00:00:00";

/**
 * The flags a state implies, given what the rows hold for the flags it does not decide (`held`). The merge writes the
 * same rule as SQL (mergedFlagsSql).
 */
export function flagsFor(state: NoteState, held: FlagsHeld) {
	const rule = FLAG_RULES[state];

	return {
		detailsAsked: rule.details === "keep" ? held.detailsAsked : rule.details,
		worth: rule.worth === "keep" ? held.worth : rule.worth,
		tried:
			rule.tried === "keep" || rule.tried === "set"
				? (held.tried ?? (rule.tried === "set" ? STAMP_FALLBACK : null))
				: null,
		failed:
			rule.failed === "keep" || rule.failed === "set"
				? (held.failed ?? (rule.failed === "set" ? STAMP_FALLBACK : null))
				: null,
		dismissed: rule.dismissed,
		guessed: rule.guessed,
	};
}

/** One flag as SQL: a CASE over the picked state, each branch the state's rule (a "keep" or "set" is `keep`). */
function flagCaseSql(
	picked: string,
	value: (rule: FlagRule) => string | number | null,
	keep: string,
): string {
	const whens = NOTE_STATES.map((state) => {
		const rule = value(FLAG_RULES[state]);

		const branch =
			rule === "keep" || rule === "set"
				? keep
				: rule === null
					? "NULL"
					: String(rule);

		return `WHEN '${state}' THEN ${branch}`;
	}).join(" ");

	return `(CASE ${picked} ${whens} END)`;
}

/**
 * The SQL for each compatibility flag of a merged row, written from the picked state's rule. `keep` says what a "keep"
 * or "set" flag takes from the two rows. The merge uses this, so the SQL and flagsFor read the same table.
 */
export function mergedFlagsSql(
	picked: string,
	keep: { details: string; worth: string; tried: string; failed: string },
) {
	return {
		details: flagCaseSql(picked, (rule) => rule.details, keep.details),
		worth: flagCaseSql(picked, (rule) => rule.worth, keep.worth),
		tried: flagCaseSql(picked, (rule) => rule.tried, keep.tried),
		failed: flagCaseSql(picked, (rule) => rule.failed, keep.failed),
		dismissed: flagCaseSql(picked, (rule) => rule.dismissed, ""),
		guessed: flagCaseSql(picked, (rule) => rule.guessed, ""),
	};
}

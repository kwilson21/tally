import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	afterNoteEvent,
	NOTE_EVENTS,
	NOTE_STATES,
	type NoteEvent,
	type NoteState,
} from "../src/db/note-state";
import {
	saveEdit,
	saveJevDetailsStatement,
	saveNoteAttempts,
} from "../src/db/transactions";
import { next } from "../src/machines/next";
import { noteStateMachine } from "../src/machines/note-state";

const db = env.DB;
const ACCOUNT = 9990;
const FIRST = 10100;

/** The legal moves, written out: every other state and event pair is refused. */
const LEGAL: Record<NoteState, Partial<Record<NoteEvent, NoteState>>> = {
	unasked: {
		jev_worth: "queued",
		jev_not_worth: "no_call",
		jev_no_answer: "unanswered",
		person_wrote: "written",
		person_emptied: "emptied_by_person",
	},
	unanswered: { person_wrote: "written", person_emptied: "emptied_by_person" },
	no_call: { person_wrote: "written", person_emptied: "emptied_by_person" },
	queued: {
		ai_guessed: "guessed",
		ai_empty: "tried_empty",
		ai_failed: "failed",
		person_wrote: "written",
		person_emptied: "emptied_by_person",
	},
	failed: {
		ai_guessed: "guessed",
		ai_empty: "tried_empty",
		ai_failed: "failed",
		person_wrote: "written",
		person_emptied: "emptied_by_person",
	},
	tried_empty: { person_wrote: "written", person_emptied: "emptied_by_person" },
	emptied_by_person: { person_wrote: "written" },
	guessed: {
		person_wrote: "written",
		person_emptied: "dismissed",
		person_kept: "written",
	},
	written: { person_emptied: "emptied_by_person" },
	dismissed: { person_wrote: "written" },
};

describe("the note state machine", () => {
	it("has exactly the ten note_state values as its states", () => {
		expect([...NOTE_STATES].sort()).toEqual(Object.keys(LEGAL).sort());
		expect(Object.keys(noteStateMachine.config.states ?? {}).sort()).toEqual(
			Object.keys(LEGAL).sort(),
		);
	});

	it("names only the nine events of the grid, in each state's map", () => {
		for (const [state, moves] of Object.entries(
			noteStateMachine.config.states ?? {},
		)) {
			const events = Object.keys(moves.on ?? {});
			for (const event of events) {
				expect(NOTE_EVENTS as readonly string[], `${state} ${event}`).toContain(
					event,
				);
			}
		}
	});

	it("walks every state and event: legal moves go to their target, every other pair is refused", () => {
		for (const state of NOTE_STATES) {
			for (const event of NOTE_EVENTS) {
				expect(next(noteStateMachine, state, event), `${state} ${event}`).toBe(
					LEGAL[state][event] ?? null,
				);
			}
		}
	});
});

// The writers' SQL is run from every state, and each stored state must be the machine's answer: the legal target,
// or the state unchanged when the machine refuses the event.
type Walk = { id: number; state: NoteState; event: NoteEvent };
const WALK: Walk[] = [];
let index = 0;
for (const state of NOTE_STATES)
	for (const event of [
		"jev_worth",
		"jev_not_worth",
		"jev_no_answer",
		"ai_guessed",
		"ai_empty",
		"ai_failed",
		"person_wrote",
		"person_emptied",
		"person_kept",
	] as NoteEvent[]) {
		WALK.push({ id: FIRST + index, state, event });
		index += 1;
	}
const LAST = FIRST + index;

async function clean() {
	await db.batch([
		db.prepare(
			`DELETE FROM transactions WHERE id BETWEEN ${FIRST} AND ${LAST}`,
		),
		db.prepare(`DELETE FROM accounts WHERE id = ${ACCOUNT}`),
	]);
}

async function insert(
	id: number,
	state: NoteState,
	note: string | null,
	// By default an unasked row has not been asked (0) and every other row has been (1).
	detailsAsked: number = state === "unasked" ? 0 : 1,
) {
	await db
		.prepare(
			`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, note, details_asked,
				note_worth_writing, note_state, updated_by)
			 VALUES (?, ?, '2026-10-01', 1299, 'CORNER STORE', ?, ?, ?, ?, 'user')`,
		)
		.bind(id, ACCOUNT, note, detailsAsked, detailsAsked === 0 ? null : 1, state)
		.run();
}

async function stored(id: number) {
	return (
		await db
			.prepare("SELECT note_state AS state FROM transactions WHERE id = ?")
			.bind(id)
			.first<{ state: NoteState }>()
	)?.state;
}

function expectMachine(
	id: number,
	{ state, event }: Walk,
	got: NoteState | undefined,
) {
	const expected = afterNoteEvent(state, event);
	expect(got, `${state} ${event}`).toBe(expected);
	// The stored state is a legal target from the state, or the state itself when refused.
	expect(expected, `${state} ${event} (row ${id})`).toBe(
		LEGAL[state][event] ?? state,
	);
}

const edit = (over: Record<string, unknown>) =>
	({
		categoryId: null,
		alwaysForMerchant: false,
		displayName: null,
		note: null,
		excluded: false,
		income: false,
		creditReviewed: true,
		...over,
	}) as Parameters<typeof saveEdit>[2];

describe("every writer, from every state, stores what the machine says", () => {
	beforeAll(async () => {
		await clean();
		await db
			.prepare(
				"INSERT INTO accounts (id, name, type, balance_cents) VALUES (?, 'Test', 'depository', 0)",
			)
			.bind(ACCOUNT)
			.run();
	});
	afterAll(clean);

	it("Jev's answer (the detail writer)", async () => {
		for (const walk of WALK.filter((w) => w.event.startsWith("jev_"))) {
			// Every state, unasked or not, with details_asked 0: the writer's guard lets only the unasked ones through.
			await insert(walk.id, walk.state, null, 0);
			const worth =
				walk.event === "jev_worth"
					? 1
					: walk.event === "jev_not_worth"
						? 0
						: null;
			const statement = saveJevDetailsStatement(db, [
				{ id: walk.id, kind: null, forPersonId: null, noteWorthWriting: worth },
			]);
			await statement?.run();
			expectMachine(walk.id, walk, await stored(walk.id));
		}
	});

	it("Workers AI's answer (saveNoteAttempts)", async () => {
		for (const walk of WALK.filter((w) => w.event.startsWith("ai_"))) {
			await insert(walk.id, walk.state, null);
			if (walk.event === "ai_guessed")
				await saveNoteAttempts(
					db,
					[walk.id],
					[{ id: walk.id, note: "Guess" }],
					[],
				);
			else if (walk.event === "ai_empty")
				await saveNoteAttempts(db, [walk.id], [], []);
			else await saveNoteAttempts(db, [], [], [walk.id]);
			expectMachine(walk.id, walk, await stored(walk.id));
		}
	});

	it("a person's edit of the note (saveEdit)", async () => {
		for (const walk of WALK.filter((w) => w.event.startsWith("person_"))) {
			await insert(walk.id, walk.state, "Typed");
			const over =
				walk.event === "person_wrote"
					? { note: "Other" }
					: walk.event === "person_emptied"
						? { note: null }
						: { note: "Typed", keepDetails: true };
			await saveEdit(db, walk.id, edit(over), "user@example.com");
			expectMachine(walk.id, walk, await stored(walk.id));
		}
	});
});

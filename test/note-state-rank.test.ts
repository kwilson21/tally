import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	laterNoteState,
	NOTE_RANK,
	type NoteState,
	noteRankSql,
	noteStateMachine,
	pendingNoteWinsSql,
} from "../src/machines/note-state";

const STATES = Object.keys(noteStateMachine.config.states ?? {}) as NoteState[];

describe("the rank of each note state", () => {
	it("gives every state of the machine exactly one rank, and no other", () => {
		expect(Object.keys(NOTE_RANK).sort()).toEqual([...STATES].sort());
		for (const state of STATES) {
			expect(Number.isInteger(NOTE_RANK[state]), state).toBe(true);
		}
	});

	it("the SQL rank agrees with the rank in code for every state", async () => {
		for (const state of STATES) {
			const row = await env.DB.prepare(
				`SELECT ${noteRankSql(`'${state}'`)} AS rank`,
			).first<{
				rank: number;
			}>();
			expect(row?.rank, state).toBe(NOTE_RANK[state]);
		}
	});
});

describe("laterNoteState", () => {
	const pairs = STATES.flatMap((a) => STATES.map((b) => [a, b] as const));

	it("picks the state with the higher rank, whichever order it is asked in", () => {
		for (const [a, b] of pairs) {
			if (NOTE_RANK[a] === NOTE_RANK[b]) continue;
			expect(laterNoteState(a, b), `${a} ${b}`).toBe(laterNoteState(b, a));
			const higher = NOTE_RANK[a] > NOTE_RANK[b] ? a : b;
			expect(laterNoteState(a, b), `${a} ${b}`).toBe(higher);
		}
	});

	it("keeps the first (the posted row's) state when the two tie, as the merge always has", () => {
		for (const [a, b] of pairs) {
			if (NOTE_RANK[a] !== NOTE_RANK[b]) continue;
			expect(laterNoteState(a, b), `${a} ${b}`).toBe(a);
		}
	});

	it("a guess never beats a dismissal, in either order", () => {
		expect(laterNoteState("guessed", "dismissed")).toBe("dismissed");
		expect(laterNoteState("dismissed", "guessed")).toBe("dismissed");
	});

	// Decision 172: a person's act beats a machine's, and a later Jev answer beats none.
	const MUST_HOLD: [NoteState, NoteState, NoteState][] = [
		["guessed", "written", "written"], // a person's note beats a guess
		["dismissed", "guessed", "dismissed"], // a guess never lands on a dismissed row
		["guessed", "dismissed", "dismissed"],
		["unasked", "queued", "queued"], // a later Jev answer beats none
		["unasked", "no_call", "no_call"],
		["unanswered", "queued", "queued"],
		["queued", "failed", "failed"], // a failed call is later than the queued note
		["failed", "tried_empty", "tried_empty"], // an empty answer is later than a failed call
		["tried_empty", "guessed", "guessed"], // a guess is later than an empty answer
		["queued", "emptied_by_person", "emptied_by_person"], // a person's emptying beats a queue
		["guessed", "emptied_by_person", "emptied_by_person"],
		["emptied_by_person", "written", "written"],
		// A posted Jev no is newer than an unresolved attempt on the pending row, so it survives all three.
		["no_call", "queued", "no_call"],
		["no_call", "failed", "no_call"],
		["no_call", "tried_empty", "no_call"],
		["no_call", "guessed", "guessed"], // a note in the row outranks a Jev no
	];
	for (const [a, b, expected] of MUST_HOLD) {
		it(`${a} with ${b} is ${expected}`, () => {
			expect(laterNoteState(a, b)).toBe(expected);
			expect(laterNoteState(b, a)).toBe(expected);
		});
	}
});

describe("pendingNoteWinsSql", () => {
	it("is true exactly when the pending state is later than the posted one", async () => {
		for (const pending of STATES) {
			for (const posted of STATES) {
				const row = await env.DB.prepare(
					`SELECT ${pendingNoteWinsSql("?", "?")} AS wins`,
				)
					.bind(pending, posted)
					.first<{ wins: number }>();
				const expected = NOTE_RANK[pending] > NOTE_RANK[posted] ? 1 : 0;
				expect(row?.wins, `${pending} over ${posted}`).toBe(expected);
			}
		}
	});
});

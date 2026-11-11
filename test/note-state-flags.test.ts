import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type FlagsHeld,
	flagsFor,
	NOTE_STATES,
	type NoteState,
} from "../src/machines/note-state";

const db = env.DB;
const ACCOUNT = 9995;
const FIRST = 10300;
const STAMP = "2026-10-01 09:25:00";

// The migration's backfill (migration 0068), which is the one reading of the flags the database has. The flags a state
// implies must read back through it as that same state. The migration is frozen, so it is used as written.
const migration = env.TEST_MIGRATIONS.find((item) =>
	item.name.startsWith("0068_note_state"),
);

const BACKFILL = (migration?.queries ?? []).find((query) =>
	query.includes("UPDATE transactions SET note_state"),
);

/** Two ways the held values can be: Jev said yes and the question was asked, or Jev was asked and said no. */
const HELD: Record<"jevYes" | "jevNo", FlagsHeld> = {
	jevYes: { detailsAsked: 1, worth: 1, tried: STAMP, failed: null },
	jevNo: { detailsAsked: 1, worth: 0, tried: STAMP, failed: null },
};

/** The note text a state holds: a guess or a person's note has text, every other state is empty. */
const TEXT: Partial<Record<NoteState, string>> = {
	guessed: "Note",
	written: "Note",
};

const cases = (Object.keys(HELD) as (keyof typeof HELD)[]).flatMap((variant) =>
	NOTE_STATES.map((state) => ({ variant, state })),
);

const idOf = (index: number) => FIRST + index;

describe("the flags a state implies", () => {
	beforeAll(async () => {
		await db.batch([
			db.prepare(
				`DELETE FROM transactions WHERE id BETWEEN ${FIRST} AND ${FIRST + cases.length}`,
			),
			db.prepare(`DELETE FROM accounts WHERE id = ${ACCOUNT}`),
			db
				.prepare(
					"INSERT INTO accounts (id, name, type, balance_cents) VALUES (?, 'Test', 'depository', 0)",
				)
				.bind(ACCOUNT),
		]);

		for (const [index, { variant, state }] of cases.entries()) {
			const flags = flagsFor(state, HELD[variant]);
			await db
				.prepare(
					`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, note, note_guessed, note_dismissed,
						details_asked, note_worth_writing, note_tried_at, note_failed_at, note_state, updated_by)
					 VALUES (?, ?, '2026-10-01', 1299, 'CORNER STORE', ?, ?, ?, ?, ?, ?, ?, ?, 'user')`,
				)
				.bind(
					idOf(index),
					ACCOUNT,
					TEXT[state] ?? null,
					flags.guessed,
					flags.dismissed,
					flags.detailsAsked,
					flags.worth,
					flags.tried,
					flags.failed,
					state,
				)
				.run();
		}
	});
	afterAll(async () => {
		await db.batch([
			db.prepare(
				`DELETE FROM transactions WHERE id BETWEEN ${FIRST} AND ${FIRST + cases.length}`,
			),
			db.prepare(`DELETE FROM accounts WHERE id = ${ACCOUNT}`),
		]);
	});

	it("reads back through the migration's backfill as the same state, for every state and both answers", async () => {
		if (!BACKFILL) throw new Error("Migration 0068 backfill is missing");
		// The backfill reads the stored flags. A state is never changed by it, so a state that reads back differently
		// would mean its flags do not say it.
		await db.prepare(BACKFILL).run();

		for (const [index, { variant, state }] of cases.entries()) {
			const row = await db
				.prepare("SELECT note_state AS state FROM transactions WHERE id = ?")
				.bind(idOf(index))
				.first<{ state: NoteState }>();

			// Known exception (decision 172): a person's emptying after Jev said yes stamps the same flags as Workers AI's
			// empty answer, and the flags cannot tell them apart, so it reads back as tried_empty.
			const expected =
				state === "emptied_by_person" && variant === "jevYes"
					? "tried_empty"
					: state;

			expect(row?.state, `${variant} ${state}`).toBe(expected);
		}
	});
});

describe("flagsFor", () => {
	it("gives an unasked row no question, no try and no failure", () => {
		expect(flagsFor("unasked", HELD.jevYes)).toMatchObject({
			detailsAsked: 0,
			worth: null,
			tried: null,
			failed: null,
			dismissed: 0,
			guessed: 0,
		});
	});

	it("gives a dismissed row the dismissal and not the guess", () => {
		expect(flagsFor("dismissed", HELD.jevYes)).toMatchObject({
			dismissed: 1,
			guessed: 0,
		});
		expect(flagsFor("guessed", HELD.jevYes)).toMatchObject({
			dismissed: 0,
			guessed: 1,
		});
	});

	it("keeps the held Jev answer for a person's act, since the act does not decide the question", () => {
		expect(flagsFor("written", HELD.jevNo)).toMatchObject({
			detailsAsked: 1,
			worth: 0,
		});
		expect(flagsFor("emptied_by_person", HELD.jevNo)).toMatchObject({
			detailsAsked: 1,
			worth: 0,
		});
	});
});

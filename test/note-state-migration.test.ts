import { env } from "cloudflare:workers";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { NoteState } from "../src/db/note-state";

const db = env.DB;
const migration = env.TEST_MIGRATIONS.find((item) =>
	item.name.startsWith("0068_note_state"),
);
// The migration runs once at deploy. These tests replay its two data statements (the contradiction fix and the
// backfill) against seeded rows, so every real flag combination is checked the way production will backfill it.
const FIX = (migration?.queries ?? []).find((query) =>
	query.includes(
		"note_guessed = 0 WHERE note_guessed = 1 AND note_dismissed = 1",
	),
);
const BACKFILL = (migration?.queries ?? []).find((query) =>
	query.includes("UPDATE transactions SET note_state"),
);

const ACCOUNT = 9960;
const FIRST = 9961;
const STAMP = "2026-10-01 09:25:00";
const UPDATED = "2026-10-02 08:00:00";

type Case = {
	name: string;
	note: string | null;
	guessed: number;
	dismissed: number;
	detailsAsked: number;
	worth: number | null;
	tried: string | null;
	failed: string | null;
	expected: NoteState;
	/** The note after the migration, when the contradiction fix clears it. */
	expectedNote?: string | null;
};

const CASES: Case[] = [
	{
		name: "fresh row",
		note: null,
		guessed: 0,
		dismissed: 0,
		detailsAsked: 0,
		worth: null,
		tried: null,
		failed: null,
		expected: "unasked",
	},
	{
		name: "person typed a note, no AI",
		note: "Cake",
		guessed: 0,
		dismissed: 0,
		detailsAsked: 0,
		worth: null,
		tried: null,
		failed: null,
		expected: "written",
	},
	{
		name: "person emptied own note before Jev asked",
		note: null,
		guessed: 0,
		dismissed: 0,
		detailsAsked: 0,
		worth: null,
		tried: STAMP,
		failed: null,
		expected: "emptied_by_person",
	},
	{
		name: "Jev asked, note question not answered (pre-0042)",
		note: null,
		guessed: 0,
		dismissed: 0,
		detailsAsked: 1,
		worth: null,
		tried: null,
		failed: null,
		expected: "unanswered",
	},
	{
		name: "Jev said no",
		note: null,
		guessed: 0,
		dismissed: 0,
		detailsAsked: 1,
		worth: 0,
		tried: null,
		failed: null,
		expected: "no_call",
	},
	{
		name: "Jev said no, then a person emptied a note",
		note: null,
		guessed: 0,
		dismissed: 0,
		detailsAsked: 1,
		worth: 0,
		tried: STAMP,
		failed: null,
		expected: "emptied_by_person",
	},
	{
		name: "Jev said no, but a person wrote a note",
		note: "Cake",
		guessed: 0,
		dismissed: 0,
		detailsAsked: 1,
		worth: 0,
		tried: null,
		failed: null,
		expected: "written",
	},
	{
		name: "Jev yes, not tried",
		note: null,
		guessed: 0,
		dismissed: 0,
		detailsAsked: 1,
		worth: 1,
		tried: null,
		failed: null,
		expected: "queued",
	},
	{
		name: "a note of spaces only counts as empty",
		note: "   ",
		guessed: 0,
		dismissed: 0,
		detailsAsked: 1,
		worth: 1,
		tried: null,
		failed: null,
		expected: "queued",
		expectedNote: "   ",
	},
	{
		name: "Jev yes, Workers AI failed",
		note: null,
		guessed: 0,
		dismissed: 0,
		detailsAsked: 1,
		worth: 1,
		tried: null,
		failed: STAMP,
		expected: "failed",
	},
	{
		name: "Jev yes, Workers AI answered empty",
		note: null,
		guessed: 0,
		dismissed: 0,
		detailsAsked: 1,
		worth: 1,
		tried: STAMP,
		failed: null,
		expected: "tried_empty",
	},
	{
		name: "failed, then answered empty",
		note: null,
		guessed: 0,
		dismissed: 0,
		detailsAsked: 1,
		worth: 1,
		tried: STAMP,
		failed: STAMP,
		expected: "tried_empty",
	},
	{
		name: "guess waiting for a person",
		note: "Birthday cake",
		guessed: 1,
		dismissed: 0,
		detailsAsked: 1,
		worth: 1,
		tried: STAMP,
		failed: null,
		expected: "guessed",
	},
	{
		name: "guess after an earlier failure",
		note: "Birthday cake",
		guessed: 1,
		dismissed: 0,
		detailsAsked: 1,
		worth: 1,
		tried: STAMP,
		failed: STAMP,
		expected: "guessed",
	},
	{
		name: "guess kept by a person",
		note: "Birthday cake",
		guessed: 0,
		dismissed: 0,
		detailsAsked: 1,
		worth: 1,
		tried: STAMP,
		failed: null,
		expected: "written",
	},
	{
		name: "guess emptied by a person (dismissed)",
		note: null,
		guessed: 0,
		dismissed: 1,
		detailsAsked: 1,
		worth: 1,
		tried: STAMP,
		failed: null,
		expected: "dismissed",
	},
	{
		name: "dismissed, then a person typed",
		note: "Mine",
		guessed: 0,
		dismissed: 1,
		detailsAsked: 1,
		worth: 1,
		tried: STAMP,
		failed: null,
		expected: "written",
	},
	{
		name: "CONTRADICTION: guess copied onto a dismissed row",
		note: "Cake",
		guessed: 1,
		dismissed: 1,
		detailsAsked: 1,
		worth: 1,
		tried: STAMP,
		failed: null,
		expected: "dismissed",
		expectedNote: null,
	},
];

const LAST = FIRST + CASES.length - 1;

async function clean() {
	await db.batch([
		db.prepare(
			`DELETE FROM transactions WHERE id BETWEEN ${FIRST} AND ${LAST}`,
		),
		db.prepare(`DELETE FROM accounts WHERE id = ${ACCOUNT}`),
	]);
}

async function seed() {
	await db.batch([
		db
			.prepare(
				"INSERT INTO accounts (id, name, type, balance_cents) VALUES (?, 'Test checking', 'depository', 0)",
			)
			.bind(ACCOUNT),
		...CASES.map((c, index) =>
			db
				.prepare(
					`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, note, note_guessed, note_dismissed,
						details_asked, note_worth_writing, note_tried_at, note_failed_at, updated_by, updated_at)
					 VALUES (?, ?, '2026-10-01', 1299, 'CORNER STORE', ?, ?, ?, ?, ?, ?, ?, 'user', ?)`,
				)
				.bind(
					FIRST + index,
					ACCOUNT,
					c.note,
					c.guessed,
					c.dismissed,
					c.detailsAsked,
					c.worth,
					c.tried,
					c.failed,
					UPDATED,
				),
		),
	]);
}

async function stateRows() {
	const { results } = await db
		.prepare(
			`SELECT id, note, note_guessed AS guessed, note_state AS state, updated_by AS updatedBy, updated_at AS updatedAt
			 FROM transactions WHERE id BETWEEN ? AND ? ORDER BY id`,
		)
		.bind(FIRST, LAST)
		.all<{
			id: number;
			note: string | null;
			guessed: number;
			state: NoteState;
			updatedBy: string | null;
			updatedAt: string | null;
		}>();
	return results;
}

describe("migration 0068 note_state backfill", () => {
	beforeEach(async () => {
		await clean();
		await seed();
	});
	afterAll(clean);

	it("is in the migrations, with the fix and the backfill", () => {
		expect(migration).toBeDefined();
		expect(FIX).toBeDefined();
		expect(BACKFILL).toBeDefined();
	});

	it("maps every real flag combination to one state, with the owner's fixes", async () => {
		if (!FIX || !BACKFILL)
			throw new Error("Migration 0068 statements are missing");
		await db.prepare(FIX).run();
		await db.prepare(BACKFILL).run();
		const rows = await stateRows();
		expect(rows.length).toBe(CASES.length);
		CASES.forEach((c, index) => {
			const row = rows[index];
			expect(row?.state, c.name).toBe(c.expected);
			expect(row?.note, c.name).toBe(
				c.expectedNote === undefined ? c.note : c.expectedNote,
			);
		});
	});

	it("never leaves a guess and a dismissal on the same row", async () => {
		if (!FIX || !BACKFILL)
			throw new Error("Migration 0068 statements are missing");
		await db.prepare(FIX).run();
		await db.prepare(BACKFILL).run();
		const bad = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE note_guessed = 1 AND note_dismissed = 1",
			)
			.first<{ n: number }>();
		expect(bad?.n).toBe(0);
	});

	it("changes no one's record: updated_by and updated_at stay as they were", async () => {
		if (!FIX || !BACKFILL)
			throw new Error("Migration 0068 statements are missing");
		await db.prepare(FIX).run();
		await db.prepare(BACKFILL).run();
		for (const row of await stateRows()) {
			expect(row.updatedBy).toBe("user");
			expect(row.updatedAt).toBe(UPDATED);
		}
	});

	it("keeps a person's emptied note as emptied_by_person, and a note Workers AI answered empty out of the queue", async () => {
		if (!FIX || !BACKFILL)
			throw new Error("Migration 0068 statements are missing");
		await db.prepare(FIX).run();
		await db.prepare(BACKFILL).run();
		const emptied = (await stateRows()).find((row) => row.id === FIRST + 2);
		expect(emptied?.state).toBe("emptied_by_person");
		const tried = (await stateRows()).find((row) => row.id === FIRST + 10);
		expect(tried?.state).not.toBe("queued");
	});

	it("the state column rejects an unknown value and defaults to unasked", async () => {
		await expect(
			db
				.prepare(`UPDATE transactions SET note_state = 'bogus' WHERE id = ?`)
				.bind(FIRST)
				.run(),
		).rejects.toThrow();
		await db
			.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name) VALUES (?, ?, '2026-10-01', 100, 'DEFAULT')",
			)
			.bind(LAST + 1, ACCOUNT)
			.run();
		const row = await db
			.prepare("SELECT note_state AS state FROM transactions WHERE id = ?")
			.bind(LAST + 1)
			.first<{ state: string }>();
		expect(row?.state).toBe("unasked");
		await db
			.prepare("DELETE FROM transactions WHERE id = ?")
			.bind(LAST + 1)
			.run();
	});
});

import { env } from "cloudflare:workers";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { transactionsNeedingNoteGuess } from "../src/db/transactions";

const db = env.DB;
const migration = env.TEST_MIGRATIONS.find((item) =>
	item.name.startsWith("0049_note_tried_reset"),
);

// Migration 0049 clears note_tried_at on an empty, undismissed note that Jev said is worth writing (decision
// 103, #450), so Workers AI gets one more try. The migration runs once at deploy, so this replays only its
// UPDATE, the statement that touches transactions.
const RESET = (migration?.queries ?? []).find((query) =>
	query.includes("UPDATE transactions SET note_tried_at"),
);

const ACCOUNT = 9780;
const A = 9781; // empty note, not dismissed, worth writing: cleared
const B = 9782; // a note of spaces only, not dismissed, worth writing: cleared
const C = 9783; // empty note a person dismissed: stays stamped
const D = 9784; // Jev never answered whether a note is worth writing: stays stamped
const E = 9785; // Jev said no: stays stamped
const F = 9786; // a note with text: stays stamped
const IDS = [A, B, C, D, E, F];

const STAMP = "2026-10-01 09:25:00";
const UPDATED = "2026-10-02 08:00:00";

type Row = {
	id: number;
	note: string | null;
	worth: number | null;
	dismissed: number;
};

const ROWS: Row[] = [
	{ id: A, note: null, worth: 1, dismissed: 0 },
	{ id: B, note: "   ", worth: 1, dismissed: 0 },
	{ id: C, note: null, worth: 1, dismissed: 1 },
	{ id: D, note: null, worth: null, dismissed: 0 },
	{ id: E, note: null, worth: 0, dismissed: 0 },
	{ id: F, note: "Birthday cake", worth: 1, dismissed: 0 },
];

async function clean() {
	await db.batch([
		db.prepare(`DELETE FROM transactions WHERE id IN (${IDS.join(",")})`),
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
		...ROWS.map((row) =>
			db
				.prepare(
					`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, details_asked, note_worth_writing, note_dismissed, note, note_tried_at, updated_by, updated_at)
					 VALUES (?, ?, '2026-10-01', 1299, 'CORNER STORE', 1, ?, ?, ?, ?, 'user', ?)`,
				)
				.bind(
					row.id,
					ACCOUNT,
					row.worth,
					row.dismissed,
					row.note,
					STAMP,
					UPDATED,
				),
		),
	]);
}

async function stateOf(id: number) {
	return db
		.prepare(
			"SELECT note_tried_at AS triedAt, updated_by AS updatedBy, updated_at AS updatedAt FROM transactions WHERE id=?",
		)
		.bind(id)
		.first<{
			triedAt: string | null;
			updatedBy: string | null;
			updatedAt: string | null;
		}>();
}

/** The transaction ids Workers AI would be asked about now, limited to this file's rows. */
async function askedIds() {
	const rows = await transactionsNeedingNoteGuess(db, 100);
	return rows.map((row) => row.id).filter((id) => IDS.includes(id));
}

describe("migration 0049 note tries reset (decision 103, #450)", () => {
	beforeEach(async () => {
		await clean();
		await seed();
	});
	afterAll(clean);

	it("is in the migrations", () => {
		expect(migration).toBeDefined();
		expect(RESET).toBeDefined();
	});

	it("gives an empty, undismissed note that Jev said is worth writing one more try", async () => {
		if (!RESET) throw new Error("Migration 0049 reset is missing");
		await db.prepare(RESET).run();
		const row = await stateOf(A);
		expect(row?.triedAt).toBeNull();
		// The migration changes only the try: who last changed the row and when stay as they were.
		expect(row?.updatedBy).toBe("user");
		expect(row?.updatedAt).toBe(UPDATED);
		expect(await askedIds()).toContain(A);
	});

	it("clears a note of spaces only too, since the empty-note rule trims it", async () => {
		if (!RESET) throw new Error("Migration 0049 reset is missing");
		await db.prepare(RESET).run();
		expect((await stateOf(B))?.triedAt).toBeNull();
		expect(await askedIds()).toContain(B);
	});

	it("keeps the try on an empty note a person dismissed", async () => {
		if (!RESET) throw new Error("Migration 0049 reset is missing");
		await db.prepare(RESET).run();
		expect((await stateOf(C))?.triedAt).toBe(STAMP);
		expect(await askedIds()).not.toContain(C);
	});

	it("keeps the try when Jev never answered or said no, so no note is written for them", async () => {
		if (!RESET) throw new Error("Migration 0049 reset is missing");
		await db.prepare(RESET).run();
		expect((await stateOf(D))?.triedAt).toBe(STAMP);
		expect((await stateOf(E))?.triedAt).toBe(STAMP);
		expect(await askedIds()).not.toContain(D);
		expect(await askedIds()).not.toContain(E);
	});

	it("keeps the try on a note that has text", async () => {
		if (!RESET) throw new Error("Migration 0049 reset is missing");
		await db.prepare(RESET).run();
		expect((await stateOf(F))?.triedAt).toBe(STAMP);
		expect(await askedIds()).not.toContain(F);
	});
});

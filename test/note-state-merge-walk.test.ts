import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { resetDemo } from "../src/demo/reset";
import {
	flagsFor,
	laterNoteState,
	NOTE_STATES,
	type NoteState,
} from "../src/machines/note-state";
import { mergePendingIntoPosted } from "../src/plaid/pending-merge";
import { present } from "./helpers/present";

const db = env.DB;
const TODAY = "2026-10-01";
const STAMP = "2026-10-01 09:25:00";
const LOCK = "walk-lock";
let item = 0;

/** A held answer that every state can be seen with: Jev said yes, the question was asked, and the try is stamped. */
const HELD = { detailsAsked: 1, worth: 1, tried: STAMP, failed: null };

const TEXT: Partial<Record<NoteState, string>> = {
	guessed: "Note",
	written: "Note",
};

async function insertRow(plaid: string, pending: number, state: NoteState) {
	const flags = flagsFor(state, HELD);
	await db
		.prepare(
			`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, pending, updated_by,
				note, note_guessed, note_dismissed, details_asked, note_worth_writing, note_tried_at, note_failed_at, note_state)
			 VALUES ((SELECT id FROM accounts ORDER BY id LIMIT 1), ?, 1200, 'CORNER COFFEE', ?, ?, 'test', ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			TODAY,
			plaid,
			pending,
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

/** Merges one pending row into one posted row, as sync does, and returns the posted row after it. */
async function merge(key: string, pending: NoteState, posted: NoteState) {
	await insertRow(`pend-${key}`, 1, pending);
	await insertRow(`post-${key}`, 0, posted);
	await db.batch(
		mergePendingIntoPosted(db, item, LOCK, `pend-${key}`, {
			id: `post-${key}`,
			cents: 1200,
			date: TODAY,
			name: "CORNER COFFEE",
			merchantName: null,
			plaidCategory: null,
		}),
	);

	return db
		.prepare(
			`SELECT note, note_state AS state, note_guessed AS guessed, note_dismissed AS dismissed,
				details_asked AS detailsAsked, note_worth_writing AS worth, note_tried_at AS triedAt
			 FROM transactions WHERE plaid_transaction_id = ?`,
		)
		.bind(`post-${key}`)
		.first<{
			note: string | null;
			state: NoteState;
			guessed: number;
			dismissed: number;
			detailsAsked: number;
			worth: number | null;
			triedAt: string | null;
		}>();
}

describe("the merge's note state, pair by pair", () => {
	beforeAll(async () => {
		await resetDemo(db, TODAY);

		const row = await db
			.prepare("SELECT id FROM plaid_items ORDER BY id LIMIT 1")
			.first<{ id: number }>();

		item = present(row?.id);
		await db
			.prepare("UPDATE plaid_items SET sync_lock_id = ? WHERE id = ?")
			.bind(LOCK, item)
			.run();
	});

	it("the Greptile case: a pending try merged onto a posted Jev no is the later state, never emptied_by_person", async () => {
		const row = await merge("greptile", "tried_empty", "no_call");
		expect(row?.state).toBe(laterNoteState("no_call", "tried_empty"));
		// A posted Jev no is newer than the pending try, so it survives; the pending try's stamp is not copied onto it.
		expect(row?.state).toBe("no_call");
		expect(row?.triedAt).toBeNull();
	});

	for (const posted of NOTE_STATES) {
		for (const pending of NOTE_STATES) {
			it(`posted ${posted} with pending ${pending} ends in the rank-selected state`, async () => {
				const key = `${posted}-${pending}`;
				const row = await merge(key, pending, posted);
				// The rank rule picks the state (a tie keeps the posted row's). Nothing else decides it.
				expect(row?.state, key).toBe(laterNoteState(posted, pending));
				// The flags follow the picked state, so the row says the same thing whichever way it is read.
				const expected = flagsFor(laterNoteState(posted, pending), HELD);
				expect(row?.guessed, key).toBe(expected.guessed);
				expect(row?.dismissed, key).toBe(expected.dismissed);
				expect(row?.note !== null && row?.note !== "", key).toBe(
					TEXT[laterNoteState(posted, pending)] !== undefined,
				);
			});
		}
	}
});

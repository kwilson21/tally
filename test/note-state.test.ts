import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { NoteState } from "../src/db/note-state";
import {
	saveEdit,
	saveJevDetailsStatement,
	saveNoteAttempts,
	transactionsNeedingNoteGuess,
} from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { mergePendingIntoPosted } from "../src/plaid/pending-merge";

const db = env.DB;
const TODAY = "2026-10-01";
const ACCOUNT = 9970;
const FIRST = 9971;
const LAST = 10010;
const STAMP = "2026-10-01 09:25:00";

const idOf = (n: number) => FIRST + n;

async function stateOf(id: number) {
	return db
		.prepare(
			`SELECT note, note_state AS state, note_guessed AS guessed, note_dismissed AS dismissed,
				note_worth_writing AS worth, details_asked AS detailsAsked, note_tried_at AS triedAt, note_failed_at AS failedAt, kind
			 FROM transactions WHERE id = ?`,
		)
		.bind(id)
		.first<{
			note: string | null;
			state: NoteState;
			guessed: number;
			dismissed: number;
			worth: number | null;
			detailsAsked: number;
			triedAt: string | null;
			failedAt: string | null;
			kind: string | null;
		}>();
}

/** Seeds a row in a given state with the flags a real row in that state carries. */
async function seed(
	n: number,
	state: NoteState,
	over: {
		note?: string | null;
		guessed?: number;
		dismissed?: number;
		worth?: number | null;
		detailsAsked?: number;
		tried?: string | null;
		failed?: string | null;
	} = {},
) {
	await db
		.prepare(
			`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, note, note_guessed, note_dismissed,
				details_asked, note_worth_writing, note_tried_at, note_failed_at, note_state, updated_by)
			 VALUES (?, ?, ?, 1299, 'CORNER STORE', ?, ?, ?, ?, ?, ?, ?, ?, 'user')`,
		)
		.bind(
			idOf(n),
			ACCOUNT,
			TODAY,
			over.note ?? null,
			over.guessed ?? 0,
			over.dismissed ?? 0,
			over.detailsAsked ?? 1,
			over.worth === undefined ? 1 : over.worth,
			over.tried ?? null,
			over.failed ?? null,
			state,
		)
		.run();
}

async function clean() {
	await db.batch([
		db.prepare(
			`DELETE FROM transactions WHERE id BETWEEN ${FIRST} AND ${LAST}`,
		),
		db.prepare(`DELETE FROM accounts WHERE id = ${ACCOUNT}`),
	]);
}

async function queued(ids: number[]) {
	const rows = await transactionsNeedingNoteGuess(db, 100);

	return rows.map((row) => row.id).filter((id) => ids.includes(id));
}

describe("saveNoteAttempts moves a note through the pipeline", () => {
	beforeEach(async () => {
		await clean();
		await db
			.prepare(
				"INSERT INTO accounts (id, name, type, balance_cents) VALUES (?, 'Test', 'depository', 0)",
			)
			.bind(ACCOUNT)
			.run();
	});

	it("queued to guessed: the guess is stored, the note is guessed, and it leaves the queue", async () => {
		await seed(0, "queued");
		expect(await queued([idOf(0)])).toEqual([idOf(0)]);
		await saveNoteAttempts(
			db,
			[idOf(0)],
			[{ id: idOf(0), note: "Birthday cake" }],
			[],
		);
		const row = await stateOf(idOf(0));
		expect(row).toMatchObject({
			note: "Birthday cake",
			state: "guessed",
			guessed: 1,
			triedAt: expect.any(String),
		});
		expect(await queued([idOf(0)])).toEqual([]);
	});

	it("queued to failed: the call is stamped and the note stays in the queue", async () => {
		await seed(1, "queued");
		await saveNoteAttempts(db, [], [], [idOf(1)]);
		const row = await stateOf(idOf(1));
		expect(row).toMatchObject({
			note: null,
			state: "failed",
			failedAt: expect.any(String),
			triedAt: null,
		});
		expect(await queued([idOf(1)])).toEqual([idOf(1)]);
	});

	it("failed to tried_empty: a later empty answer wins, and the note is not asked again", async () => {
		await seed(2, "failed", { failed: STAMP });
		await saveNoteAttempts(db, [idOf(2)], [], []);
		expect(await stateOf(idOf(2))).toMatchObject({
			state: "tried_empty",
			note: null,
		});
		expect(await queued([idOf(2)])).toEqual([]);
	});

	it("a failed note that fails again stays failed", async () => {
		await seed(3, "queued");
		await saveNoteAttempts(db, [], [], [idOf(3)]);
		await saveNoteAttempts(db, [], [], [idOf(3)]);
		expect((await stateOf(idOf(3)))?.state).toBe("failed");
	});

	it("a failed note that later succeeds becomes guessed", async () => {
		await seed(4, "failed", { failed: STAMP });
		await saveNoteAttempts(
			db,
			[idOf(4)],
			[{ id: idOf(4), note: "Dinner" }],
			[],
		);
		expect(await stateOf(idOf(4))).toMatchObject({
			state: "guessed",
			note: "Dinner",
		});
	});

	it("never writes over a note a person already has, whatever its state", async () => {
		await seed(5, "written", { note: "Mine" });
		await saveNoteAttempts(db, [idOf(5)], [{ id: idOf(5), note: "Guess" }], []);
		expect(await stateOf(idOf(5))).toMatchObject({
			note: "Mine",
			state: "written",
			guessed: 0,
		});
	});

	it("never writes over an emptied note", async () => {
		await seed(6, "emptied_by_person", { tried: STAMP, worth: 1 });
		await saveNoteAttempts(db, [], [{ id: idOf(6), note: "Guess" }], []);
		expect(await stateOf(idOf(6))).toMatchObject({
			note: null,
			state: "emptied_by_person",
		});
	});
});

describe("saveJevDetailsStatement sets the state from Jev's answer", () => {
	beforeEach(async () => {
		await clean();
		await db
			.prepare(
				"INSERT INTO accounts (id, name, type, balance_cents) VALUES (?, 'Test', 'depository', 0)",
			)
			.bind(ACCOUNT)
			.run();
	});

	it("yes queues, no is no_call, no answer is unanswered, and a person's emptied note stays emptied", async () => {
		for (const n of [0, 1, 2, 3]) {
			// A person's emptying before Jev asked leaves the row emptied_by_person, with the try the edit records.
			await seed(n, n === 3 ? "emptied_by_person" : "unasked", {
				detailsAsked: 0,
				worth: null,
				tried: n === 3 ? STAMP : null,
				note: null,
			});
		}

		const statement = saveJevDetailsStatement(db, [
			{ id: idOf(0), kind: null, forPersonId: null, noteWorthWriting: 1 },
			{ id: idOf(1), kind: null, forPersonId: null, noteWorthWriting: 0 },
			{ id: idOf(2), kind: null, forPersonId: null, noteWorthWriting: null },
			{ id: idOf(3), kind: null, forPersonId: null, noteWorthWriting: 1 },
		]);

		if (!statement) throw new Error("no statement");
		await statement.run();
		expect((await stateOf(idOf(0)))?.state).toBe("queued");
		expect((await stateOf(idOf(1)))?.state).toBe("no_call");
		expect((await stateOf(idOf(2)))?.state).toBe("unanswered");
		expect((await stateOf(idOf(3)))?.state).toBe("emptied_by_person");
		expect(await queued([idOf(0), idOf(1), idOf(2), idOf(3)])).toEqual([
			idOf(0),
		]);
	});
});

describe("a person's edit of the note", () => {
	beforeEach(async () => {
		await clean();
		await db
			.prepare(
				"INSERT INTO accounts (id, name, type, balance_cents) VALUES (?, 'Test', 'depository', 0)",
			)
			.bind(ACCOUNT)
			.run();
	});

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

	it("emptying a guess dismisses it and clears the note", async () => {
		await seed(10, "guessed", {
			note: "Birthday cake",
			guessed: 1,
			tried: STAMP,
		});
		// The form posts an emptied note as null (edit.ts), so that is what the save sees.
		await saveEdit(db, idOf(10), edit({ note: null }), "user@example.com");
		expect(await stateOf(idOf(10))).toMatchObject({
			state: "dismissed",
			note: null,
			guessed: 0,
			dismissed: 1,
		});
	});

	it("emptying a person's own note records that the person emptied it, so it is never queued", async () => {
		await seed(11, "written", { note: "Mine", worth: 1 });
		await saveEdit(db, idOf(11), edit({ note: null }), "user@example.com");
		expect(await stateOf(idOf(11))).toMatchObject({
			state: "emptied_by_person",
			note: null,
		});
		expect(await queued([idOf(11)])).toEqual([]);
	});

	it("typing a note into a queued row writes it, and the row leaves the queue", async () => {
		await seed(12, "queued");
		await saveEdit(db, idOf(12), edit({ note: "Typed" }), "user@example.com");
		expect(await stateOf(idOf(12))).toMatchObject({
			state: "written",
			note: "Typed",
			guessed: 0,
		});
		expect(await queued([idOf(12)])).toEqual([]);
	});

	it("keeping a guess writes it as the person's", async () => {
		await seed(13, "guessed", {
			note: "Birthday cake",
			guessed: 1,
			tried: STAMP,
		});
		await saveEdit(
			db,
			idOf(13),
			edit({ note: "Birthday cake", keepDetails: true }),
			"user@example.com",
		);
		expect(await stateOf(idOf(13))).toMatchObject({
			state: "written",
			note: "Birthday cake",
			guessed: 0,
		});
	});
});

describe("the pending-to-posted merge picks the later note state", () => {
	let item = 0;
	let lock = 0;

	beforeEach(async () => {
		await resetDemo(db, TODAY);

		const row = await db
			.prepare("SELECT id FROM plaid_items ORDER BY id LIMIT 1")
			.first<{ id: number }>();

		item = row?.id as number;
		lock += 1;
		await db
			.prepare("UPDATE plaid_items SET sync_lock_id = ? WHERE id = ?")
			.bind(`lock-${lock}`, item)
			.run();
	});

	/** Inserts a pending row and its posted row, each in its own state, then runs the merge the way sync does. */
	async function merge(
		key: string,
		pending: {
			state: NoteState;
			note?: string | null;
			guessed?: number;
			dismissed?: number;
			worth?: number | null;
			detailsAsked?: number;
			tried?: string | null;
			failed?: string | null;
		},
		posted: {
			state: NoteState;
			note?: string | null;
			guessed?: number;
			dismissed?: number;
			worth?: number | null;
			detailsAsked?: number;
			tried?: string | null;
			failed?: string | null;
		},
	) {
		const insert = (plaid: string, pendingFlag: number, s: typeof pending) =>
			db
				.prepare(
					`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, pending, updated_by,
						note, note_guessed, note_dismissed, details_asked, note_worth_writing, note_tried_at, note_failed_at, note_state)
					 VALUES ((SELECT id FROM accounts ORDER BY id LIMIT 1), ?, 1200, 'CORNER COFFEE', ?, ?, 'test', ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					TODAY,
					plaid,
					pendingFlag,
					s.note ?? null,
					s.guessed ?? 0,
					s.dismissed ?? 0,
					s.detailsAsked ?? 1,
					s.worth === undefined ? 1 : s.worth,
					s.tried ?? null,
					s.failed ?? null,
					s.state,
				)
				.run();

		await insert(`pend-${key}`, 1, pending);
		await insert(`post-${key}`, 0, posted);
		await db.batch(
			mergePendingIntoPosted(db, item, `lock-${lock}`, `pend-${key}`, {
				id: `post-${key}`,
				cents: 1200,
				date: TODAY,
				name: "CORNER COFFEE",
				merchantName: null,
				plaidCategory: null,
			}),
		);

		const row = await db
			.prepare("SELECT id FROM transactions WHERE plaid_transaction_id = ?")
			.bind(`post-${key}`)
			.first<{ id: number }>();

		return stateOf(row?.id as number);
	}

	it("a person's note on the pending row beats a guess on the posted row", async () => {
		const row = await merge(
			"a",
			{ state: "written", note: "Person" },
			{ state: "guessed", note: "Machine", guessed: 1, tried: STAMP },
		);

		expect(row).toMatchObject({ state: "written", note: "Person", guessed: 0 });
	});

	it("a guess copied onto a row already dismissed stays dismissed", async () => {
		const row = await merge(
			"b",
			{ state: "guessed", note: "Cake", guessed: 1, tried: STAMP },
			{ state: "dismissed", note: null, dismissed: 1, tried: STAMP },
		);

		expect(row).toMatchObject({
			state: "dismissed",
			note: null,
			guessed: 0,
			dismissed: 1,
		});
	});

	it("a queued pending note is queued on a posted row that has no answer yet", async () => {
		const row = await merge(
			"c",
			{ state: "queued" },
			{ state: "unasked", detailsAsked: 0, worth: null },
		);

		expect(row).toMatchObject({ state: "queued", worth: 1, detailsAsked: 1 });
	});

	it("a failed pending note does not override a posted Jev no", async () => {
		const row = await merge(
			"d",
			{ state: "failed", failed: STAMP },
			{ state: "no_call", worth: 0 },
		);

		expect(row).toMatchObject({ state: "no_call", worth: 0 });
	});

	it("a posted person's note keeps its text over a pending guess", async () => {
		const row = await merge(
			"e",
			{ state: "guessed", note: "Cake", guessed: 1, tried: STAMP },
			{ state: "written", note: "Mine" },
		);

		expect(row).toMatchObject({ state: "written", note: "Mine" });
	});

	it("a person's emptying on the pending row stops the posted row's queue", async () => {
		const row = await merge(
			"f",
			{ state: "emptied_by_person", tried: STAMP },
			{ state: "queued" },
		);

		expect(row).toMatchObject({ state: "emptied_by_person", note: null });
	});
});

describe("a save that reads a note's state before it writes", () => {
	beforeEach(async () => {
		await clean();
		await db
			.prepare(
				"INSERT INTO accounts (id, name, type, balance_cents) VALUES (?, 'Test', 'depository', 0)",
			)
			.bind(ACCOUNT)
			.run();
	});

	it("does not write the old state back over a guess stored between the read and the save", async () => {
		await seed(20, "queued");

		// Workers AI stores its guess after saveEdit has read the row and before its batch runs.
		const racing = new Proxy(db, {
			get(target, property) {
				if (property === "batch")
					return async (statements: D1PreparedStatement[]) => {
						await saveNoteAttempts(
							target,
							[idOf(20)],
							[{ id: idOf(20), note: "Birthday cake" }],
							[],
						);

						return target.batch(statements);
					};

				const value = Reflect.get(target, property);

				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		// A kind-only edit: the note is not changed, so the save must not rewrite the note's state.
		await saveEdit(
			racing as unknown as D1Database,
			idOf(20),
			{
				categoryId: null,
				alwaysForMerchant: false,
				displayName: null,
				note: null,
				excluded: false,
				income: false,
				creditReviewed: true,
				kind: "one_off",
				noteProvided: false,
			} as Parameters<typeof saveEdit>[2],
			"user@example.com",
		);
		expect(await stateOf(idOf(20))).toMatchObject({
			state: "guessed",
			note: "Birthday cake",
		});
	});
	it("does not mark a note kept when another save cleared the guess between the read and the batch", async () => {
		await seed(21, "guessed", { note: "Birthday cake", guessed: 1 });

		// A second save clears the guess after "Looks right" has read it and before its batch runs.
		const racing = new Proxy(db, {
			get(target, property) {
				if (property === "batch")
					return async (statements: D1PreparedStatement[]) => {
						await target
							.prepare(
								"UPDATE transactions SET note = NULL, note_state = 'emptied_by_person', note_guessed = 0 WHERE id = ?",
							)
							.bind(idOf(21))
							.run();

						return target.batch(statements);
					};

				const value = Reflect.get(target, property);

				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		await saveEdit(
			racing as unknown as D1Database,
			idOf(21),
			{
				categoryId: null,
				alwaysForMerchant: false,
				displayName: null,
				note: "Birthday cake",
				excluded: false,
				income: false,
				creditReviewed: true,
				keepDetails: true,
			} as Parameters<typeof saveEdit>[2],
			"user@example.com",
		);
		// The empty note must not become "written", which would outrank a person's real note at the next merge.
		expect(await stateOf(idOf(21))).toMatchObject({
			state: "emptied_by_person",
			note: null,
		});
	});
});

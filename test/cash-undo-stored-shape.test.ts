import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDemo } from "../src/demo/reset";
import {
	holdCashDelete,
	restoreCashDelete,
} from "../src/transactions/cash-undo";
import { UNDO_MS } from "../src/undo";

// The cash delete hold's five stored columns are read through the Schema (decision 233). Text that is not JSON still throws
// its SyntaxError before anything is written; a column of the wrong shape restores nothing and answers null; a hold that
// has expired, or was already restored, answers as before without reading its JSON.

const db = env.DB;

async function cashAccount(): Promise<number> {
	const account = await db
		.prepare("SELECT id FROM accounts WHERE type='cash' LIMIT 1")
		.first<{ id: number }>();

	if (!account) throw new Error("cash account missing");

	return account.id;
}

/** A cash entry with the given name, inserted (not yet held). Returns its id. */
async function cashEntry(name: string): Promise<number> {
	const inserted = await db
		.prepare(
			"INSERT INTO transactions (account_id,date,amount_cents,raw_name,updated_by) VALUES (?, '2026-10-06', 1250, ?, 'test')",
		)
		.bind(await cashAccount(), name)
		.run();

	return Number(inserted.meta.last_row_id);
}

/** A cash entry held for undo. Returns its id and its token. */
async function heldCash(name: string) {
	const id = await cashEntry(name);
	const token = await holdCashDelete(db, id, name);

	if (!token) throw new Error("cash delete token missing");

	return { id, token };
}

const countNamed = async (name: string) =>
	(
		await db
			.prepare("SELECT COUNT(*) AS n FROM transactions WHERE raw_name=?")
			.bind(name)
			.first<{ n: number }>()
	)?.n ?? 0;

const markerOf = async (token: string) =>
	(
		await db
			.prepare("SELECT restore_marker FROM cash_delete_holds WHERE token=?")
			.bind(token)
			.first<{ restore_marker: string | null }>()
	)?.restore_marker ?? null;

beforeEach(async () => resetDemo(db, "2026-10-07"));

describe("the cash delete hold's stored columns", () => {
	it("restores a linked bill payment with every column it was held with", async () => {
		const bill = await db
			.prepare(
				"SELECT id FROM bills WHERE active=1 AND id NOT IN (SELECT bill_id FROM bill_payments WHERE period='2026-10' AND status='linked') LIMIT 1",
			)
			.first<{ id: number }>();

		if (!bill) throw new Error("no unpaid bill");

		const id = await cashEntry("Shape rent cash");
		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id,period,transaction_id,matched_by,status) VALUES (?, '2026-10', ?, 'user', 'linked')",
			)
			.bind(bill.id, id)
			.run();

		const token = await holdCashDelete(db, id, "Shape rent cash");
		const restored = token ? await restoreCashDelete(db, token) : null;

		expect(restored).toMatchObject({
			name: "Shape rent cash",
			alreadyRestored: false,
		});

		const restoredId = restored?.alreadyRestored === false ? restored.id : -1;

		const payment = await db
			.prepare(
				"SELECT bill_id, period, matched_by, status FROM bill_payments WHERE transaction_id=?",
			)
			.bind(restoredId)
			.first<{
				bill_id: number;
				period: string;
				matched_by: string;
				status: string;
			}>();

		expect(payment).toEqual({
			bill_id: bill.id,
			period: "2026-10",
			matched_by: "user",
			status: "linked",
		});
	});

	// The hold keeps an infinity as Infinity, and the read accepts it. The restore then binds the row with JSON.stringify,
	// which writes an infinity as null, so the column comes back NULL: as it did before this change (not changed here).
	it("accepts a REAL infinity in a stored column, so the entry comes back", async () => {
		const id = await cashEntry("Shape infinite cash");
		await db
			.prepare("UPDATE transactions SET category_confidence = 1e999 WHERE id=?")
			.bind(id)
			.run();
		const token = await holdCashDelete(db, id, "Shape infinite cash");

		expect(token).not.toBeNull();
		expect(await restoreCashDelete(db, token ?? "")).toMatchObject({
			name: "Shape infinite cash",
			alreadyRestored: false,
		});
		expect(await countNamed("Shape infinite cash")).toBe(1);
	});

	it("throws the SyntaxError for text that is not JSON, and writes nothing", async () => {
		const held = await heldCash("Shape broken cash");
		await db
			.prepare(
				"UPDATE cash_delete_holds SET payment_rows='not json' WHERE token=?",
			)
			.bind(held.token)
			.run();

		await expect(restoreCashDelete(db, held.token)).rejects.toBeInstanceOf(
			SyntaxError,
		);
		expect(await markerOf(held.token)).toBeNull();
		expect(await countNamed("Shape broken cash")).toBe(0);
	});

	it("answers null, and writes nothing, for a column of the wrong shape", async () => {
		const held = await heldCash("Shape wrong cash");
		await db
			.prepare("UPDATE cash_delete_holds SET split_rows='{}' WHERE token=?")
			.bind(held.token)
			.run();

		expect(await restoreCashDelete(db, held.token)).toBeNull();
		expect(await markerOf(held.token)).toBeNull();
		expect(await countNamed("Shape wrong cash")).toBe(0);
	});

	it("answers null, and writes nothing, for a payments or plans column that is an object", async () => {
		// Restored before the change, with that step skipped: the Schema now refuses an object where a list is read.
		for (const column of ["payment_rows", "plan_rows"]) {
			const held = await heldCash(`Shape ${column} cash`);
			await db
				.prepare(`UPDATE cash_delete_holds SET ${column}='{}' WHERE token=?`)
				.bind(held.token)
				.run();

			expect(await restoreCashDelete(db, held.token)).toBeNull();
			expect(await markerOf(held.token)).toBeNull();
			expect(await countNamed(`Shape ${column} cash`)).toBe(0);
		}
	});

	it("answers null without reading the JSON of an expired hold", async () => {
		const held = await heldCash("Shape expired cash");
		await db
			.prepare(
				"UPDATE cash_delete_holds SET created_at=?, transaction_row='not json' WHERE token=?",
			)
			.bind(Date.now() - UNDO_MS - 1000, held.token)
			.run();

		expect(await restoreCashDelete(db, held.token)).toBeNull();
		expect(await markerOf(held.token)).toBeNull();
	});

	it("answers alreadyRestored without reading the JSON of a hold already restored", async () => {
		const held = await heldCash("Shape restored cash");
		await db
			.prepare(
				"UPDATE cash_delete_holds SET restore_marker='earlier', transaction_row='not json' WHERE token=?",
			)
			.bind(held.token)
			.run();

		expect(await restoreCashDelete(db, held.token)).toEqual({
			alreadyRestored: true,
			name: "Shape restored cash",
		});
	});
});

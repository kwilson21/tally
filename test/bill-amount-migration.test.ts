import { env } from "cloudflare:workers";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const db = env.DB;
const migration = env.TEST_MIGRATIONS.find((item) =>
	item.name.startsWith("0044_bill_amount_history"),
);

// Migration 0044 gives every bill its first bill_amounts row: at the month of its earliest linked payment
// (decision 79), or this month when it has none. The file's table statement can't run again on a database
// that has it, so this replays only the backfill statement, which skips any bill that already has a row.
const BACKFILL = (migration?.queries ?? []).find((query) =>
	query.includes("INSERT INTO bill_amounts"),
);

const IDS = [9401, 9402, 9403];
// The migration's "this month": UTC less twelve hours (see the migration's comment).
const thisMonth = new Date(Date.now() - 12 * 3_600_000)
	.toISOString()
	.slice(0, 7);

async function clean() {
	await db.batch([
		db.prepare(`DELETE FROM bill_payments WHERE bill_id IN (${IDS.join(",")})`),
		db.prepare(`DELETE FROM bill_amounts WHERE bill_id IN (${IDS.join(",")})`),
		db.prepare(`DELETE FROM bills WHERE id IN (${IDS.join(",")})`),
		db.prepare("DELETE FROM transactions WHERE id IN (9401, 9402, 9403)"),
	]);
}

async function rowsOf(billId: number) {
	const { results } = await db
		.prepare(
			"SELECT effective_month AS effectiveMonth, amount_cents AS amountCents FROM bill_amounts WHERE bill_id=? ORDER BY effective_month",
		)
		.bind(billId)
		.all<{ effectiveMonth: string; amountCents: number }>();
	return results;
}

describe("migration 0044 bill amount history", () => {
	beforeEach(async () => {
		await clean();
		await db.batch([
			db.prepare(
				"INSERT OR IGNORE INTO accounts(id,name,type,balance_cents) VALUES(1,'Checking','depository',0)",
			),
		]);
	});
	afterAll(clean);

	it("is in the migrations", () => {
		expect(migration).toBeDefined();
		expect(BACKFILL).toBeDefined();
	});

	it("starts a bill with linked payments at the month of its earliest payment", async () => {
		if (!BACKFILL) throw new Error("Migration 0044 backfill is missing");
		await db.batch([
			db.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(9401,'Netflix',1549,2,'monthly','NETFLIX.COM')",
			),
			db.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9401,1,'2026-09-02',1549,'NETFLIX.COM'),(9402,1,'2026-08-02',1549,'NETFLIX.COM')",
			),
			db.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9401,'2026-09',9401,'auto','linked'),(9401,'2026-08',9402,'auto','linked')",
			),
		]);
		await db.prepare(BACKFILL).run();
		expect(await rowsOf(9401)).toEqual([
			{ effectiveMonth: "2026-08", amountCents: 1549 },
		]);
	});

	it("starts a bill with no payment at this month", async () => {
		if (!BACKFILL) throw new Error("Migration 0044 backfill is missing");
		await db
			.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(9402,'Gym',4000,9,'monthly','GYM CO')",
			)
			.run();
		await db.prepare(BACKFILL).run();
		expect(await rowsOf(9402)).toEqual([
			{ effectiveMonth: thisMonth, amountCents: 4000 },
		]);
	});

	it("takes the fallback month from twelve hours behind UTC, so it is never ahead of any zone", async () => {
		if (!BACKFILL) throw new Error("Migration 0044 backfill is missing");
		expect(BACKFILL.match(/'now'/g)).toHaveLength(1);
		expect(BACKFILL).toContain("'-12 hours'");
	});

	it("starts a bill with no payment in October at 06:00 UTC on November 1, still October in Hawaii", async () => {
		if (!BACKFILL) throw new Error("Migration 0044 backfill is missing");
		await db
			.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(9402,'Gym',4000,9,'monthly','GYM CO')",
			)
			.run();
		await db.prepare(BACKFILL.replace("'now'", "'2026-11-01 06:00:00'")).run();
		expect(await rowsOf(9402)).toEqual([
			{ effectiveMonth: "2026-10", amountCents: 4000 },
		]);
	});

	it("leaves a bill that already has a row alone", async () => {
		if (!BACKFILL) throw new Error("Migration 0044 backfill is missing");
		await db.batch([
			db.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(9403,'Phone',6000,12,'monthly','CARRIER')",
			),
			db.prepare(
				"INSERT INTO bill_amounts(bill_id,effective_month,amount_cents) VALUES(9403,'2026-01',5500)",
			),
		]);
		await db.prepare(BACKFILL).run();
		expect(await rowsOf(9403)).toEqual([
			{ effectiveMonth: "2026-01", amountCents: 5500 },
		]);
	});

	it("deletes a bill's rows with the bill", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(9401,'Cloud',900,1,'monthly','CLOUD')",
			),
			db.prepare(
				"INSERT INTO bill_amounts(bill_id,effective_month,amount_cents) VALUES(9401,'2026-02',900)",
			),
		]);
		await db.prepare("DELETE FROM bills WHERE id=9401").run();
		expect(await rowsOf(9401)).toEqual([]);
	});
});

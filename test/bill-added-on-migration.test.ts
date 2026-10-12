import { env } from "cloudflare:workers";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const db = env.DB;
const migration = env.TEST_MIGRATIONS.find((item) =>
	item.name.startsWith("0046_bill_added_on"),
);

// Migration 0046 adds bills.added_on and gives every existing bill the migration's day (decision 99, #337).
// The ALTER can't run again on a database that has the column, so this replays only the UPDATE, which
// fills the bills that have no day yet.
const BACKFILL = (migration?.queries ?? []).find((query) =>
	query.includes("UPDATE bills SET added_on"),
);

const IDS = [9711, 9712];

/** The day SQLite computes for the backfill (UTC less twelve hours, see the migration's comment). */
async function sqlDay() {
	return (
		await db
			.prepare("SELECT date('now','-12 hours') AS day")
			.first<{ day: string }>()
	)?.day;
}

async function clean() {
	await db.batch([
		db.prepare(`DELETE FROM bills WHERE id IN (${IDS.join(",")})`),
	]);
}

async function addedOn(id: number) {
	return (
		await db
			.prepare("SELECT added_on AS addedOn FROM bills WHERE id=?")
			.bind(id)
			.first<{ addedOn: string | null }>()
	)?.addedOn;
}

describe("migration 0046 bill added day", () => {
	beforeEach(clean);
	afterAll(clean);

	it("is in the migrations", () => {
		expect(migration).toBeDefined();
		expect(BACKFILL).toBeDefined();
	});

	it("gives an existing bill the migration's day, a YYYY-MM-DD date", async () => {
		if (!BACKFILL) throw new Error("Migration 0046 backfill is missing");
		await db
			.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(9711,'Water',1399,3,'monthly','WATER CO')",
			)
			.run();
		// The day is read from SQLite on either side of the backfill, so a run that crosses the day's end still passes.
		const before = await sqlDay();
		await db.prepare(BACKFILL).run();
		const after = await sqlDay();
		expect(before).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect([before, after]).toContain(await addedOn(9711));
	});

	it("leaves a bill that already has a day as it is", async () => {
		if (!BACKFILL) throw new Error("Migration 0046 backfill is missing");
		await db
			.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name,added_on) VALUES(9712,'Gym',4500,5,'monthly','GYM CO','2026-10-10')",
			)
			.run();
		await db.prepare(BACKFILL).run();
		expect(await addedOn(9712)).toBe("2026-10-10");
	});
});

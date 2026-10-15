import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

// The demo seed plans its own two; these tests plan what they need, so they start with none.
beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	await env.DB.prepare("DELETE FROM planned_expenses").run();
});

/** Three bank payments (money out) with fixed ids, so each test links its own. */
async function payments() {
	await env.DB.batch(
		[9501, 9502, 9503, 9504, 9505].map((id) =>
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT ?,id,'2026-10-03',18000,'DMV FIXTURE' FROM accounts WHERE type!='cash' LIMIT 1",
			).bind(id),
		),
	);
}

async function bill(id: number) {
	await env.DB.prepare(
		"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(?,?,18000,3,'monthly','DMV FIXTURE')",
	)
		.bind(id, `Bill ${id}`)
		.run();
}

describe("migration 0053: planned expenses and the never-both guard", () => {
	beforeEach(async () => {
		await payments();
		await bill(9601);
		await bill(9602);
	});

	it("creates planned_expenses with its columns and no category", async () => {
		const { results } = await env.DB.prepare(
			"SELECT name FROM pragma_table_info('planned_expenses')",
		).all<{ name: string }>();
		const columns = results.map((c) => c.name);
		expect(columns).toEqual([
			"id",
			"name",
			"amount_cents",
			"month",
			"transaction_id",
			"created_by",
		]);
	});

	it("links a payment that no bill links", async () => {
		await env.DB.prepare(
			"INSERT INTO planned_expenses(name,amount_cents,month,transaction_id,created_by) VALUES('Car registration',18000,'2026-10',9501,'demo')",
		).run();
		const row = await env.DB.prepare(
			"SELECT transaction_id FROM planned_expenses WHERE name='Car registration'",
		).first<{ transaction_id: number }>();
		expect(row?.transaction_id).toBe(9501);
	});

	it("a bill payment can't take a payment a plan already pays (insert)", async () => {
		await env.DB.prepare(
			"INSERT INTO planned_expenses(name,amount_cents,month,transaction_id,created_by) VALUES('Car registration',18000,'2026-10',9502,'demo')",
		).run();
		await expect(
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9601,'2026-10',9502,'user','linked')",
			).run(),
		).rejects.toThrow(/already pays a planned expense/);
	});

	it("a bill payment can't take a payment a plan already pays (update)", async () => {
		await env.DB.prepare(
			"INSERT INTO planned_expenses(name,amount_cents,month,transaction_id,created_by) VALUES('Car registration',18000,'2026-10',9504,'demo')",
		).run();
		// A dismissed row on the plan's payment is allowed; reviving it to linked is what the guard stops.
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9601,'2026-10',9504,'user','dismissed')",
		).run();
		await expect(
			env.DB.prepare(
				"UPDATE bill_payments SET status='linked' WHERE bill_id=9601",
			).run(),
		).rejects.toThrow(/already pays a planned expense/);
	});

	it("a plan can't take a payment a bill already pays (insert)", async () => {
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9601,'2026-10',9503,'user','linked')",
		).run();
		await expect(
			env.DB.prepare(
				"INSERT INTO planned_expenses(name,amount_cents,month,transaction_id,created_by) VALUES('Car registration',18000,'2026-10',9503,'demo')",
			).run(),
		).rejects.toThrow(/already pays a bill/);
	});

	it("a plan can't take a payment a bill already pays (update)", async () => {
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9601,'2026-10',9503,'user','linked')",
		).run();
		await env.DB.prepare(
			"INSERT INTO planned_expenses(name,amount_cents,month,created_by) VALUES('Car registration',18000,'2026-10','demo')",
		).run();
		await expect(
			env.DB.prepare(
				"UPDATE planned_expenses SET transaction_id=9503 WHERE name='Car registration'",
			).run(),
		).rejects.toThrow(/already pays a bill/);
	});

	it("a dismissed bill row doesn't block a plan from taking its payment", async () => {
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9602,'2026-10',9505,'user','dismissed')",
		).run();
		await env.DB.prepare(
			"INSERT INTO planned_expenses(name,amount_cents,month,transaction_id,created_by) VALUES('Car registration',18000,'2026-10',9505,'demo')",
		).run();
		const row = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM planned_expenses WHERE transaction_id=9505",
		).first<{ n: number }>();
		expect(row?.n).toBe(1);
	});

	it("one payment pays at most one plan", async () => {
		await env.DB.prepare(
			"INSERT INTO planned_expenses(name,amount_cents,month,transaction_id,created_by) VALUES('Car registration',18000,'2026-10',9501,'demo')",
		).run();
		await expect(
			env.DB.prepare(
				"INSERT INTO planned_expenses(name,amount_cents,month,transaction_id,created_by) VALUES('Lawn',9000,'2026-10',9501,'demo')",
			).run(),
		).rejects.toThrow(/UNIQUE/);
	});

	it("a dropped payment unlinks its plan, which is set aside again", async () => {
		await env.DB.prepare(
			"INSERT INTO planned_expenses(name,amount_cents,month,transaction_id,created_by) VALUES('Car registration',18000,'2026-10',9501,'demo')",
		).run();
		await env.DB.prepare("DELETE FROM transactions WHERE id=9501").run();
		const row = await env.DB.prepare(
			"SELECT transaction_id FROM planned_expenses WHERE name='Car registration'",
		).first<{ transaction_id: number | null }>();
		expect(row?.transaction_id).toBeNull();
	});
});

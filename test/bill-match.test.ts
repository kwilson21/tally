import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	assignPairs,
	matchBillPayments,
	pickBillPayment,
} from "../src/bills/match";

describe("bill payment matching", () => {
	it("enforces date and amount windows, then breaks ties by date, amount, and id", () => {
		const candidates = [
			{ id: 4, date: "2026-04-11", amountCents: 9900 },
			{ id: 3, date: "2026-04-09", amountCents: 9900 },
			{ id: 2, date: "2026-04-09", amountCents: 10000 },
			{ id: 1, date: "2026-04-16", amountCents: 10000 },
			{ id: 5, date: "2026-04-10", amountCents: 11001 },
		];
		expect(pickBillPayment(candidates, "2026-04-10", 10000)?.id).toBe(2);
	});

	it("rejects candidates outside the inclusive amount and date windows", () => {
		expect(
			pickBillPayment(
				[
					{ id: 1, date: "2026-04-10", amountCents: 11001 },
					{ id: 2, date: "2026-04-16", amountCents: 10000 },
				],
				"2026-04-10",
				10000,
			),
		).toBeUndefined();
	});

	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM bills"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare(
				"INSERT INTO accounts(id,name,type,balance_cents) VALUES(1,'Checking','depository',0)",
			),
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(1,'Rent',10000,10,'monthly','LANDLORD')",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(1,1,'2026-03-10',10000,'LANDLORD'),(2,1,'2026-04-10',10000,'LANDLORD'),(3,1,'2026-04-09',10000,'LANDLORD')",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(1,'2026-04',2,'user','dismissed')",
			),
		]);
	});

	it("fills old occurrences, respects dismissals, and is idempotent", async () => {
		expect(await matchBillPayments(env.DB, "2026-04-03")).toBe(2);
		expect(await matchBillPayments(env.DB, "2026-04-03")).toBe(0);
		const rows = await env.DB.prepare(
			"SELECT period,transaction_id FROM bill_payments WHERE status='linked' ORDER BY period",
		).all();
		expect(rows.results).toEqual([
			{ period: "2026-03", transaction_id: 1 },
			{ period: "2026-04", transaction_id: 3 },
		]);
	});

	it("skips split parents, the wrong merchant, claimed rows, and dismissals", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,excluded,is_split) VALUES(11,1,'2026-06-10',10000,'LANDLORD',0,1),(12,1,'2026-07-10',10000,'OTHER',0,0),(13,1,'2026-08-10',10000,'LANDLORD',0,0),(14,1,'2026-09-10',10000,'LANDLORD',0,0)",
			),
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(2,'Other',10000,10,'monthly','OTHER')",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(2,'2026-08',13,'user','linked'),(1,'2026-09',14,'user','dismissed')",
			),
		]);
		expect(await matchBillPayments(env.DB, "2026-09-12")).toBe(1);
		const links = await env.DB.prepare(
			"SELECT period,transaction_id FROM bill_payments WHERE bill_id=1 AND status='linked'",
		).all();
		expect(links.results).toEqual([]);
	});

	// Spec §6.1 rule 4 (decision 67): an excluded payment still pays a bill, and linking it puts it back
	// in the budget. The matcher is not a person, so it leaves no source, and nothing takes the payment out
	// again while it pays the bill (Plaid's rule and Jev both skip a linked payment).
	it("lets an excluded payment pay a bill, and puts it back in the budget", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,flag_transfer,excluded,excluded_source) VALUES(30,1,'2026-05-10',10000,'LANDLORD',1,1,'jev'),(31,1,'2026-06-10',10000,'LANDLORD',0,1,'plaid'),(32,1,'2026-07-10',10000,'LANDLORD',0,1,'user')",
			),
		]);
		expect(await matchBillPayments(env.DB, "2026-07-12")).toBe(3);
		const links = await env.DB.prepare(
			"SELECT period,transaction_id,matched_by FROM bill_payments WHERE status='linked' ORDER BY period",
		).all();
		expect(links.results).toEqual([
			{ period: "2026-05", transaction_id: 30, matched_by: "auto" },
			{ period: "2026-06", transaction_id: 31, matched_by: "auto" },
			{ period: "2026-07", transaction_id: 32, matched_by: "auto" },
		]);
		const rows = await env.DB.prepare(
			"SELECT id,excluded,excluded_source FROM transactions ORDER BY id",
		).all();
		expect(rows.results).toEqual([
			{ id: 30, excluded: 0, excluded_source: null },
			{ id: 31, excluded: 0, excluded_source: null },
			{ id: 32, excluded: 0, excluded_source: null },
		]);
	});

	it("never matches a transaction flagged as income, excluded or not, and leaves it as it was", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			// A positive amount marked income by a person or Jev, once excluded and once not, beside an
			// ordinary excluded payment that does match.
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,flag_income,income_source,excluded,excluded_source) VALUES(60,1,'2026-05-10',10000,'LANDLORD',1,'user',1,'user'),(61,1,'2026-06-10',10000,'LANDLORD',1,'jev',0,NULL),(62,1,'2026-07-10',10000,'LANDLORD',0,NULL,1,'jev')",
			),
		]);
		expect(await matchBillPayments(env.DB, "2026-07-12")).toBe(1);
		const links = await env.DB.prepare(
			"SELECT period,transaction_id FROM bill_payments WHERE status='linked'",
		).all();
		expect(links.results).toEqual([{ period: "2026-07", transaction_id: 62 }]);
		const rows = await env.DB.prepare(
			"SELECT id,excluded,excluded_source FROM transactions ORDER BY id",
		).all();
		expect(rows.results).toEqual([
			{ id: 60, excluded: 1, excluded_source: "user" },
			{ id: 61, excluded: 0, excluded_source: null },
			{ id: 62, excluded: 0, excluded_source: null },
		]);
	});

	it("leaves a payment excluded when no bill takes it", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,excluded,excluded_source) VALUES(40,1,'2026-05-10',10000,'OTHER',1,'jev'),(41,1,'2026-06-10',10000,'LANDLORD',1,'jev')",
			),
			// The person already said this one isn't June's payment.
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(1,'2026-06',41,'user','dismissed')",
			),
		]);
		expect(await matchBillPayments(env.DB, "2026-06-12")).toBe(0);
		const rows = await env.DB.prepare(
			"SELECT id,excluded,excluded_source FROM transactions ORDER BY id",
		).all();
		expect(rows.results).toEqual([
			{ id: 40, excluded: 1, excluded_source: "jev" },
			{ id: 41, excluded: 1, excluded_source: "jev" },
		]);
	});

	it("puts a whole excluded split back, as the edit panel excludes one", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,excluded,excluded_source,is_split) VALUES(50,1,'2026-05-10',15000,'LANDLORD',1,'user',1)",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,excluded,excluded_source,parent_id) VALUES(51,1,'2026-05-10',10000,'LANDLORD',1,'user',50),(52,1,'2026-05-10',5000,'ELSEWHERE',1,'user',50)",
			),
		]);
		expect(await matchBillPayments(env.DB, "2026-05-12")).toBe(1);
		const rows = await env.DB.prepare(
			"SELECT id,excluded FROM transactions ORDER BY id",
		).all();
		expect(rows.results.map((r) => r.excluded)).toEqual([0, 0, 0]);
	});

	it("skips inactive bills", async () => {
		await env.DB.prepare("UPDATE bills SET active=0 WHERE id=1").run();
		expect(await matchBillPayments(env.DB, "2026-04-03")).toBe(0);
	});

	it("matches a yearly occurrence", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("UPDATE bills SET frequency='yearly',anchor_month=3"),
		]);
		expect(await matchBillPayments(env.DB, "2026-04-03")).toBe(1);
		expect(
			await env.DB.prepare("SELECT period FROM bill_payments").first("period"),
		).toBe("2026");
	});

	it("scans the occurrence before the earliest transaction month", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("UPDATE bills SET due_day=31"),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(20,1,'2026-04-02',10000,'LANDLORD')",
			),
		]);
		expect(await matchBillPayments(env.DB, "2026-04-03")).toBe(1);
		expect(
			await env.DB.prepare("SELECT period FROM bill_payments").first("period"),
		).toBe("2026-03");
	});

	it("gives a shared payment to the closest due date, then amount, then bill id", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare(
				"UPDATE bills SET due_day=8,amount_cents=10100 WHERE id=1",
			),
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(2,'Other rent',10000,10,'monthly','LANDLORD')",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(20,1,'2026-04-10',10000,'LANDLORD')",
			),
		]);
		expect(await matchBillPayments(env.DB, "2026-04-11")).toBe(1);
		expect(
			await env.DB.prepare(
				"SELECT bill_id FROM bill_payments WHERE status='linked'",
			).first("bill_id"),
		).toBe(2);

		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("UPDATE bills SET due_day=10,amount_cents=10000"),
		]);
		expect(await matchBillPayments(env.DB, "2026-04-11")).toBe(1);
		expect(
			await env.DB.prepare(
				"SELECT bill_id FROM bill_payments WHERE status='linked'",
			).first("bill_id"),
		).toBe(1);
	});
});

describe("assignPairs", () => {
	const pair = (bill: number, candidate: number) => ({
		bill: { id: bill },
		period: "2026-10",
		candidate: { id: candidate },
	});
	it("leaves no bill unpaid when a valid payment exists for each", () => {
		// Payment 1 is closest to bill A, but bill B can only use payment 1; A can also use 2.
		const result = assignPairs([pair(1, 1), pair(2, 1), pair(1, 2)]);
		expect(result.map((p) => [p.bill.id, p.candidate.id]).sort()).toEqual([
			[1, 2],
			[2, 1],
		]);
	});
	it("keeps the closest pair when nothing else is possible, and skips reserved payments", () => {
		expect(assignPairs([pair(1, 1), pair(2, 1)]).map((p) => p.bill.id)).toEqual(
			[1],
		);
		expect(assignPairs([pair(1, 1)], new Set([1]))).toEqual([]);
	});
});

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { matchBillPayments, pickBillPayment } from "../src/bills/match";

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

	it("skips excluded rows, split parents, the wrong merchant, claimed rows, and dismissals", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,excluded,is_split) VALUES(10,1,'2026-05-10',10000,'LANDLORD',1,0),(11,1,'2026-06-10',10000,'LANDLORD',0,1),(12,1,'2026-07-10',10000,'OTHER',0,0),(13,1,'2026-08-10',10000,'LANDLORD',0,0),(14,1,'2026-09-10',10000,'LANDLORD',0,0)",
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
});

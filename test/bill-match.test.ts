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
});

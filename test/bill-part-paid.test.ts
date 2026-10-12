import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { matchBillPayments } from "../src/bills/match";
import { occurrencePaid, partPaidSentence } from "../src/bills/status";
import { billTotalsForRows } from "../src/bills/totals";
import { resetDemo } from "../src/demo/reset";
import { loadBillRows } from "../src/routes/bills";

// Partial bill payments (Phase 5, decision 101, #205): more than one payment can pay one occurrence, and an
// occurrence is Paid once its payments reach 90% of its amount. Until then it is part paid.
// A monthly bill's period is its month (YYYY-MM), whatever its due day.

const RENT = 9500;
const MONTH = "2026-10";

describe("an occurrence is Paid at 90% of its amount (decision 101)", () => {
	it("is Paid at 90% and above, and not below it, in whole cents", () => {
		expect(occurrencePaid(108000, 120000)).toBe(true); // $1,080.00 of $1,200
		expect(occurrencePaid(107999, 120000)).toBe(false); // $1,079.99 of $1,200
		expect(occurrencePaid(120000, 120000)).toBe(true);
		expect(occurrencePaid(150000, 120000)).toBe(true); // paying more is still Paid
		expect(occurrencePaid(0, 120000)).toBe(false);
	});
});

describe("Part paid reads in dollars, with cents only when an amount has them", () => {
	it("says whole dollars for whole amounts", () => {
		expect(partPaidSentence(60000, 120000)).toBe("Part paid: $600 of $1,200");
	});
	it("says cents for amounts that have them", () => {
		expect(partPaidSentence(775, 1549)).toBe("Part paid: $7.75 of $15.49");
	});
	it("decides cents for each amount on its own", () => {
		expect(partPaidSentence(700, 1549)).toBe("Part paid: $7 of $15.49");
	});
});

describe("partial payments on one rent bill", () => {
	beforeEach(async () => {
		await resetDemo(env.DB, "2026-10-05");
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM bills WHERE id != ?").bind(RENT),
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(?,'Rent',120000,1,'monthly','HARBOR PROPERTY MGMT')",
			).bind(RENT),
		]);
	});

	const addPayment = (id: number, date: string, cents: number) =>
		env.DB.prepare(
			"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT ?,id,?,?,'HARBOR PROPERTY MGMT' FROM accounts WHERE type!='cash' LIMIT 1",
		)
			.bind(id, date, cents)
			.run();
	const link = (transaction: number, period = MONTH) =>
		env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,?,'user','linked')",
		)
			.bind(RENT, period, transaction)
			.run();
	const rentRow = async (today: string) =>
		(await loadBillRows(env.DB, today)).rows.find((row) => row.id === RENT);

	it("one occurrence can hold two linked payments, but one transaction still pays one bill", async () => {
		await addPayment(9601, "2026-10-01", 70000);
		await addPayment(9602, "2026-10-03", 50000);
		await link(9601);
		await link(9602);
		await expect(link(9601)).rejects.toThrow();
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM bill_payments WHERE bill_id=? AND period=? AND status='linked'",
			)
				.bind(RENT, MONTH)
				.first("n"),
		).toBe(2);
	});

	it("$700 and $500 on a $1,200 bill make the month Paid", async () => {
		await addPayment(9601, "2026-10-01", 70000);
		await addPayment(9602, "2026-10-03", 50000);
		await link(9601);
		await link(9602);
		expect(await rentRow("2026-10-20")).toMatchObject({
			status: "paid",
			paidCents: 120000,
		});
	});

	it("$600 of $1,200 is part paid, and Safe to spend sets aside the $600 left", async () => {
		await addPayment(9601, "2026-10-01", 60000);
		await link(9601);
		const row = await rentRow("2026-10-02");
		expect(row).toMatchObject({ paidCents: 60000, status: "overdue" });
		const totals = billTotalsForRows(MONTH, [row as NonNullable<typeof row>]);
		expect(totals.soonCents).toBe(60000);
		expect(totals.soonCount).toBe(1);
		expect(totals.stillToPayCents).toBe(60000);
	});

	it("a $1,200 rent due in 3 days with $600 paid is Due in the next 7 days, then Overdue after its date", async () => {
		await env.DB.prepare("UPDATE bills SET due_day=8 WHERE id=?")
			.bind(RENT)
			.run();
		await addPayment(9601, "2026-10-04", 60000);
		await link(9601);
		expect(await rentRow("2026-10-05")).toMatchObject({
			status: "due",
			dueDate: "2026-10-08",
			paidCents: 60000,
		});
		expect(await rentRow("2026-10-09")).toMatchObject({
			status: "overdue",
			dueDate: "2026-10-08",
			paidCents: 60000,
		});
	});
});

describe("the matcher adds nothing to an occurrence that already has a payment", () => {
	beforeEach(async () => {
		await resetDemo(env.DB, "2026-10-05");
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM bills WHERE id != ?").bind(RENT),
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(?,'Rent',120000,1,'monthly','HARBOR PROPERTY MGMT')",
			).bind(RENT),
		]);
	});

	it("skips an occurrence with a part payment, and running it again changes nothing", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 9611,id,'2026-10-01',60000,'HARBOR PROPERTY MGMT' FROM accounts WHERE type!='cash' LIMIT 1",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 9612,id,'2026-10-02',120000,'HARBOR PROPERTY MGMT' FROM accounts WHERE type!='cash' LIMIT 1",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,9611,'user','linked')",
			).bind(RENT, MONTH),
		]);
		expect(await matchBillPayments(env.DB, "2026-10-05")).toBe(0);
		expect(await matchBillPayments(env.DB, "2026-10-05")).toBe(0);
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM bill_payments WHERE bill_id=? AND status='linked'",
			)
				.bind(RENT)
				.first("n"),
		).toBe(1);
	});
});

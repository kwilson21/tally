import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBillRows } from "../src/bills/rows";
import { billTotalsForRows } from "../src/bills/totals";
import { resetDemo } from "../src/demo/reset";

// Decision 123 (#631): Safe to spend sets aside only this month's bills that are due or overdue and not paid. A bill
// due in the next month is not set aside until its month, though it still shows as due soon on Bills and on Home.
// Read through Bills' rows, as Home reads them: the shown occurrence moves on to the next one a week before it is due.

const RENT = 9510;
const DAYCARE = 9511;
const MONTH = "2026-10";

describe("Safe to spend sets aside this month's bills only (decision 123, #631)", () => {
	beforeEach(async () => {
		await resetDemo(env.DB, "2026-10-05");
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM bills"),
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(?,'Rent',120000,1,'monthly','HARBOR PROPERTY MGMT')",
			).bind(RENT),
		]);
	});
	afterEach(() => vi.useRealTimers());

	const addPayment = (id: number, date: string, cents: number) =>
		env.DB.prepare(
			"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT ?,id,?,?,'HARBOR PROPERTY MGMT' FROM accounts WHERE type!='cash' LIMIT 1",
		)
			.bind(id, date, cents)
			.run();
	const link = (bill: number, transaction: number, period: string) =>
		env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,?,'user','linked')",
		)
			.bind(bill, period, transaction)
			.run();
	const rowOn = async (today: string, id: number) =>
		(await loadBillRows(env.DB, today)).rows.find((row) => row.id === id);

	it("keeps October's unpaid part of the rent set aside on the 24th, 25th and 31st, while November's rent is due soon", async () => {
		await addPayment(9801, "2026-10-01", 60000);
		await link(RENT, 9801, MONTH);
		for (const today of ["2026-10-24", "2026-10-25", "2026-10-31"]) {
			const row = await rowOn(today, RENT);
			expect(row).toBeDefined();
			const totals = billTotalsForRows(MONTH, [row as NonNullable<typeof row>]);
			expect(totals.setAsideCents).toBe(60000);
			expect(totals.soonCount).toBe(1);
		}
		// The 25th is the handoff day: November's rent is the shown occurrence, and October's is no longer shown.
		const onThe25th = await rowOn("2026-10-25", RENT);
		expect(onThe25th?.dueDate).toBe("2026-11-01");
		expect(onThe25th?.totalOccurrences).toContainEqual({
			dueDate: "2026-10-01",
			status: "overdue",
			amountCents: 120000,
			paidCents: 60000,
		});
		// November's rent is not set aside in October, though Bills counts it as due soon (soonCents, as today).
		const totals = billTotalsForRows(MONTH, [
			onThe25th as NonNullable<typeof onThe25th>,
		]);
		expect(totals.soonCents).toBe(120000);
	});

	it("does not set aside November's rent in October, and sets it aside on its own month's first day", async () => {
		await addPayment(9801, "2026-10-01", 60000);
		await link(RENT, 9801, MONTH);
		const onThe31st = await rowOn("2026-10-31", RENT);
		expect(
			billTotalsForRows(MONTH, [onThe31st as NonNullable<typeof onThe31st>])
				.setAsideCents,
		).toBe(60000);
		// On the 1st of November, October's rent is no longer set aside, and November's own rent is.
		const onNovemberFirst = await rowOn("2026-11-01", RENT);
		expect(onNovemberFirst?.dueDate).toBe("2026-11-01");
		expect(
			billTotalsForRows("2026-11", [
				onNovemberFirst as NonNullable<typeof onNovemberFirst>,
			]).setAsideCents,
		).toBe(120000);
	});

	it("does not set aside a weekly bill's Friday in the next month", async () => {
		await env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(?,'Daycare',24000,5,'weekly','LITTLE SPROUTS')",
		)
			.bind(DAYCARE)
			.run();
		// October's five Fridays (the 2nd to the 30th) are unpaid, so all five are set aside. November's 6th is due
		// within the week, but it is in November: it counts as due soon, and is not set aside.
		const row = await rowOn("2026-10-31", DAYCARE);
		expect(row?.nextOccurrence?.dueDate).toBe("2026-11-06");
		const totals = billTotalsForRows(MONTH, [row as NonNullable<typeof row>]);
		expect(totals.setAsideCents).toBe(5 * 24000);
		expect(totals.soonCents - totals.setAsideCents).toBe(24000);
		expect(totals.soonCount).toBe(1);
	});

	it("still lists November's rent under Bills due soon on Home on the 31st", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
		await addPayment(9801, "2026-10-01", 60000);
		await link(RENT, 9801, MONTH);
		const res = await exports.default.fetch("http://tally.test/");
		const html = await res.text();
		expect(html).toContain("Bills due soon");
		expect(html).toContain("Rent");
	});
});

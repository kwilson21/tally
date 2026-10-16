import { env, exports } from "cloudflare:workers";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { matchBillPayments } from "../src/bills/match";
import { billOccurrence } from "../src/bills/status";
import { billTotalsForRows } from "../src/bills/totals";
import { loadBillRows } from "../src/routes/bills";
import { billStatusLine } from "../src/views/bill-row";

// Decision 99 (#337): an occurrence due before the day its bill was added is already handled. It is not
// overdue, not set aside and not still to pay, and the bill shows its next occurrence. A payment that
// links that earlier occurrence still shows it as Paid, and the matcher still links it.

const db = env.DB;
const IDS = [9701, 9702, 9703, 9704, 9705, 9706, 9707, 9708, 9710];

async function clean() {
	await db.batch([
		db.prepare(`DELETE FROM bill_payments WHERE bill_id IN (${IDS.join(",")})`),
		db.prepare(`DELETE FROM bill_amounts WHERE bill_id IN (${IDS.join(",")})`),
		db.prepare(`DELETE FROM bills WHERE id IN (${IDS.join(",")})`),
		db.prepare("DELETE FROM transactions WHERE id IN (9701, 9702, 9703)"),
	]);
}

describe("a due date before the day the bill was added (decision 99, #337)", () => {
	const yearly = { frequency: "yearly", dueDay: 3, anchorMonth: 3 } as const;

	it("shows the next occurrence as upcoming, with no overdue occurrence", () => {
		expect(
			billOccurrence({ ...yearly, addedOn: "2026-10-10" }, "2026-10-10", false),
		).toEqual({ dueDate: "2027-03-03", period: "2027", status: "upcoming" });
	});

	it("is overdue after its due date when it was added before that date and is unpaid", () => {
		const bill = { ...yearly, addedOn: "2026-02-28" };
		expect(billOccurrence(bill, "2026-03-02", false)).toEqual({
			dueDate: "2026-03-03",
			period: "2026",
			status: "due",
		});
		expect(billOccurrence(bill, "2026-03-04", false)).toEqual({
			dueDate: "2026-03-03",
			period: "2026",
			status: "overdue",
		});
	});

	it("still shows a matching earlier payment as paid", () => {
		expect(
			billOccurrence(
				{ ...yearly, addedOn: "2026-03-20" },
				"2026-03-20",
				new Set(["2026"]),
			),
		).toEqual({ dueDate: "2026-03-03", period: "2026", status: "paid" });
	});

	it("hands a monthly bill added after its due day straight to next month", () => {
		expect(
			billOccurrence(
				{ frequency: "monthly", dueDay: 5, addedOn: "2026-10-10" },
				"2026-10-12",
				false,
			),
		).toEqual({ dueDate: "2026-11-05", period: "2026-11", status: "upcoming" });
	});

	it("keeps a due date on the day the bill was added under decision 62", () => {
		expect(
			billOccurrence(
				{ frequency: "monthly", dueDay: 10, addedOn: "2026-10-10" },
				"2026-10-10",
				false,
			),
		).toEqual({ dueDate: "2026-10-10", period: "2026-10", status: "due" });
	});

	it("skips a weekly occurrence before the day the bill was added", () => {
		expect(
			billOccurrence(
				{ frequency: "weekly", dueDay: 5, addedOn: "2026-10-10" },
				"2026-10-10",
				false,
			),
		).toEqual({ dueDate: "2026-10-16", period: "2026-10-16", status: "due" });
	});

	it("judges every occurrence as before when no day was added", () => {
		expect(billOccurrence(yearly, "2026-10-10", false)).toEqual({
			dueDate: "2026-03-03",
			period: "2026",
			status: "overdue",
		});
	});
});

describe("the bills page and Home see the same handled occurrences", () => {
	beforeEach(async () => {
		await clean();
		await db.batch([
			db.prepare(
				"INSERT OR IGNORE INTO accounts(id,name,type,balance_cents) VALUES(1,'Checking','depository',0)",
			),
		]);
	});
	afterAll(clean);

	it("shows an October-added yearly bill as upcoming in March and sets nothing aside", async () => {
		await db
			.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,anchor_month,merchant_raw_name,added_on) VALUES(9701,'Car insurance',120000,3,'yearly',3,'INSURER','2026-10-10')",
			)
			.run();
		const { rows } = await loadBillRows(db, "2026-10-10");
		const row = rows.find((bill) => bill.id === 9701);
		expect(row).toMatchObject({
			dueDate: "2027-03-03",
			status: "upcoming",
		});
		expect(row && billStatusLine(row, "2026-10-10")).toBe("Due Mar 3, 2027");
		const totals = billTotalsForRows("2026-10", rows);
		expect(totals.soonCount).toBe(0);
		expect(totals.soonCents).toBe(0);
		expect(totals.stillToPayCents).toBe(0);
	});

	it("turns a February-added yearly bill overdue after its March due date when unpaid", async () => {
		await db
			.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,anchor_month,merchant_raw_name,added_on) VALUES(9702,'Car insurance',120000,3,'yearly',3,'INSURER','2026-02-28')",
			)
			.run();
		const { rows } = await loadBillRows(db, "2026-03-04");
		const row = rows.find((bill) => bill.id === 9702);
		expect(row).toMatchObject({
			dueDate: "2026-03-03",
			status: "overdue",
		});
		expect(billTotalsForRows("2026-03", rows).soonCents).toBe(120000);
	});

	it("leaves a monthly bill added after its due day out of the month's still-to-pay", async () => {
		await db
			.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name,added_on) VALUES(9703,'Gym',4500,5,'monthly','GYM CO','2026-10-10')",
			)
			.run();
		const { rows } = await loadBillRows(db, "2026-10-12");
		const row = rows.find((bill) => bill.id === 9703);
		expect(row).toMatchObject({ dueDate: "2026-11-05", status: "upcoming" });
		expect(billTotalsForRows("2026-10", rows).stillToPayCents).toBe(0);
	});

	it("still shows a payment that matches the handled occurrence as paid", async () => {
		await db
			.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,anchor_month,merchant_raw_name,added_on) VALUES(9704,'Car insurance',120000,3,'yearly',3,'INSURER','2026-03-05')",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9702,1,'2026-03-03',120000,'INSURER')",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9704,'2026',9702,'auto','linked')",
			)
			.run();
		const { rows } = await loadBillRows(db, "2026-03-06");
		expect(rows.find((bill) => bill.id === 9704)).toMatchObject({
			dueDate: "2026-03-03",
			status: "paid",
		});
	});

	it("links a matching payment to the handled occurrence from before the day it was added", async () => {
		await db
			.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,anchor_month,merchant_raw_name,added_on) VALUES(9701,'Car insurance',120000,3,'yearly',3,'INSURER','2026-10-10')",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9701,1,'2026-03-03',120000,'INSURER')",
			)
			.run();
		await matchBillPayments(db, "2026-10-10");
		const link = await db
			.prepare(
				"SELECT period FROM bill_payments WHERE bill_id=9701 AND status='linked'",
			)
			.first<{ period: string }>();
		expect(link?.period).toBe("2026");
	});
});

describe("the bill's own page leaves out a due date before the day the bill was added (decision 99, #337)", () => {
	beforeEach(async () => {
		await clean();
		await db.batch([
			db.prepare(
				"INSERT OR IGNORE INTO accounts(id,name,type,balance_cents) VALUES(1,'Checking','depository',0)",
			),
		]);
		vi.useFakeTimers({ toFake: ["Date"] });
	});
	afterEach(() => vi.useRealTimers());
	afterAll(clean);

	/** The Payments row whose label reads `${label} · ${amount}`, or "" when the page lists none. */
	// A month's row names the month in its own span, and its status and amount follow it in muted words (#604).
	const paymentRow = (html: string, label: string) =>
		(
			html
				.split("<li")
				.find(
					(item) =>
						item.includes(`>${label}<`) || item.includes(`>${label} · `),
				) ?? ""
		).split("</li>")[0] ?? "";

	/** The bill's page as the household sees it at `now` (an ISO instant). */
	async function billPageAt(id: number, now: string) {
		vi.setSystemTime(new Date(now));
		return (
			await exports.default.fetch(`http://tally.test/bills/${id}`)
		).text();
	}

	it("lists no Overdue or Not paid Friday from before a weekly bill was added, and its next Friday as due", async () => {
		await db
			.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name,added_on) VALUES(9705,'Friday bill',24000,5,'weekly','FRIDAY BILL','2026-10-12')",
			)
			.run();
		// Monday, October 12, 2026: the Fridays of October 9 and 2 come before the day the bill was added.
		const html = await billPageAt(9705, "2026-10-12T16:00:00Z");
		expect(paymentRow(html, "Fri, Oct 9")).toBe("");
		expect(paymentRow(html, "Fri, Oct 2")).toBe("");
		expect(html).not.toContain("Overdue");
		expect(html).not.toContain("Not paid");
		expect(paymentRow(html, "Fri, Oct 16")).toContain("Due");
	});

	it("lists no Not paid month from before a monthly bill was added after its due day", async () => {
		await db
			.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name,added_on) VALUES(9706,'Gym',4500,5,'monthly','GYM CO','2026-10-10')",
			)
			.run();
		const html = await billPageAt(9706, "2026-10-12T16:00:00Z");
		expect(paymentRow(html, "October")).toBe("");
		expect(paymentRow(html, "September")).toBe("");
		expect(html).not.toContain("Not paid");
		expect(paymentRow(html, "November")).toContain("Upcoming");
	});

	it("still opens the picker for a handled occurrence, so a payment can be linked to it by hand", async () => {
		await db
			.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name,added_on) VALUES(9706,'Gym',4500,5,'monthly','GYM CO','2026-10-10')",
			)
			.run();
		vi.setSystemTime(new Date("2026-10-12T16:00:00Z"));
		const picker = await exports.default.fetch(
			"http://tally.test/bills/9706/occurrences/2026-10/link",
		);
		expect(picker.status).toBe(200);
	});

	it("still opens the picker for a handled yearly occurrence more than six months back, and its page lists no row for it", async () => {
		await db
			.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,anchor_month,merchant_raw_name,added_on) VALUES(9710,'Car insurance',120000,3,'yearly',3,'INSURER','2026-10-10')",
			)
			.run();
		vi.setSystemTime(new Date("2026-10-12T16:00:00Z"));
		const picker = await exports.default.fetch(
			"http://tally.test/bills/9710/occurrences/2026/link",
		);
		expect(picker.status).toBe(200);
		const html = await billPageAt(9710, "2026-10-12T16:00:00Z");
		expect(paymentRow(html, "March")).toBe("");
	});

	it("still lists a payment that links a handled occurrence as Paid", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,anchor_month,merchant_raw_name,added_on) VALUES(9707,'Car insurance',120000,3,'yearly',3,'INSURER','2026-10-10')",
			),
			db.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9703,1,'2026-03-03',120000,'INSURER')",
			),
			db.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9707,'2026',9703,'auto','linked')",
			),
		]);
		const html = await billPageAt(9707, "2026-10-12T16:00:00Z");
		expect(paymentRow(html, "March")).toContain("Paid");
		expect(paymentRow(html, "March")).toContain("$1,200.00");
		expect(paymentRow(html, "March 2027")).toContain("Upcoming");
	});

	it("still lists an unpaid due date after the day the bill was added as Overdue", async () => {
		await db
			.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,anchor_month,merchant_raw_name,added_on) VALUES(9708,'Car insurance',120000,3,'yearly',3,'INSURER','2026-02-28')",
			)
			.run();
		const html = await billPageAt(9708, "2026-03-04T16:00:00Z");
		expect(paymentRow(html, "March")).toContain("Overdue");
	});
});

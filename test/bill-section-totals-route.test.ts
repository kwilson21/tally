import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDemo } from "../src/demo/reset";
import { loadBillRows } from "../src/routes/bills";

/** One Bills group: its `<section>` block, found by its heading, cut before the next section. */
const groupUnder = (html: string, heading: string) =>
	(
		html.split("<section").find((part) => part.includes(`>${heading}</h2>`)) ??
		""
	).split("</section>")[0] ?? "";

/** A group's heading total: the only ml-auto span in its section (rows never use it). */
const totalOf = (section: string) =>
	section.match(/<span class="ml-auto shrink-0">([^<]*)<\/span>/)?.[1];

/** The labels of a group's rows, in the order they are listed. */
const rowNamesOf = (section: string) =>
	[
		...section.matchAll(
			/<span class="block truncate text-lg leading-6">([^<]*)<\/span>/g,
		),
	].map((match) => match[1]);

const billsPage = async () =>
	(await exports.default.fetch("http://tally.test/bills")).text();

// Issue #601: each section heading's amount is the sum of the rows that section lists. The demo on 2026-10-15 has
// Streaming ($2.99) and Water ($13.99) paid today, Daycare's weekly Fridays, Rent part paid, and Soccer league
// due in July 2027.
describe("Bills section headings add up to the rows under them (issue #601)", () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-15T15:00:00Z"));
		await resetDemo(env.DB, "2026-10-15");
	});
	afterEach(() => vi.useRealTimers());

	it("Paid this month totals every bill paid this month, listed or not: the rows Streaming $2.99 and Water $13.99, and Daycare's Oct 2 and 9 Fridays (decision 122)", async () => {
		const paid = groupUnder(await billsPage(), "Paid this month");
		expect(rowNamesOf(paid)).toEqual(["Streaming", "Water"]);
		expect(totalOf(paid)).toBe("$496.98");
		expect(paid).toContain("Includes Daycare&#39;s Fridays on Oct 2 and 9</p>");
	});

	it("Paid this month adds a planned expense paid this month to the bills it lists", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 9501,id,'2026-10-15',18000,'DMV FIXTURE' FROM accounts WHERE type!='cash' LIMIT 1",
			),
			env.DB.prepare(
				"INSERT INTO planned_expenses(name,amount_cents,month,transaction_id,created_by) VALUES('Car registration',18000,'2026-10',9501,'test')",
			),
		]);
		const paid = groupUnder(await billsPage(), "Paid this month");
		expect(rowNamesOf(paid)).toEqual([
			"Streaming",
			"Water",
			"Car registration",
		]);
		expect(totalOf(paid)).toBe("$676.98");
	});

	it("Due in the next 7 days totals each row it lists once: Internet $65.00 and Daycare's Friday $240.00", async () => {
		const html = await billsPage();
		const due = groupUnder(html, "Due in the next 7 days");
		expect(rowNamesOf(due)).toEqual(["Internet", "Daycare"]);
		expect(totalOf(due)).toBe("$305.00");
	});

	it("Overdue counts a part-paid bill by what's left of it: Rent's $600 of $1,200", async () => {
		const overdue = groupUnder(await billsPage(), "Overdue");
		expect(rowNamesOf(overdue)).toEqual(["Electric", "Netflix", "Rent"]);
		expect(totalOf(overdue)).toBe("$757.49");
	});

	it("Upcoming counts only this month's upcoming occurrences, so Daycare's Fridays of Oct 23 and 30 and not Soccer league's", async () => {
		const html = await billsPage();
		const upcoming = groupUnder(html, "Upcoming");
		// The spec's rule (§8.4): Upcoming includes only occurrences due this month, and says so with "this month".
		expect(rowNamesOf(upcoming)).toEqual(["Soccer league"]);
		expect(totalOf(upcoming)).toBe("$480.00 this month");
		// The total counts Daycare's Oct 23 and 30 Fridays, which no row lists, and says so under the heading (decision 122).
		expect(upcoming).toContain(
			"Includes Daycare&#39;s Fridays on Oct 23 and 30</p>",
		);
		// Daycare's Oct 16 Friday is set aside under Due; the Upcoming total does not count it a second time.
		expect(groupUnder(html, "Due in the next 7 days")).toContain("Daycare");
		expect(groupUnder(html, "Due in the next 7 days")).not.toContain(
			"Includes",
		);
	});
});

// Decision 122 (#602): Paid this month counts a payment in the month it counts in (src/db/counted-month.ts), an early
// payment in its own month and a late one in its occurrence's month.
describe("Paid this month counts a bill payment in the month it counts in (#602)", () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-15T15:00:00Z"));
		await resetDemo(env.DB, "2026-10-15");
	});
	afterEach(() => vi.useRealTimers());

	it("leaves out Daycare's Oct 2 Friday paid on Sep 29, and names only Oct 9 under the heading", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET date='2026-09-29' WHERE id=(SELECT transaction_id FROM bill_payments WHERE status='linked' AND period='2026-10-02' AND bill_id=(SELECT id FROM bills WHERE name='Daycare'))",
		).run();
		const paid = groupUnder(await billsPage(), "Paid this month");
		expect(rowNamesOf(paid)).toEqual(["Streaming", "Water"]);
		expect(totalOf(paid)).toBe("$256.98");
		expect(paid).toContain("Includes Daycare&#39;s Friday on Oct 9</p>");
	});
});

describe("A late payment counts in its occurrence's month, and Paid this month does not move (#602)", () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-30T15:00:00Z"));
		await resetDemo(env.DB, "2026-10-30");
	});
	afterEach(() => vi.useRealTimers());

	it("gives Daycare's Oct 30 occurrence October when its payment is made on Nov 3, and keeps Paid this month's total", async () => {
		const before = totalOf(groupUnder(await billsPage(), "Paid this month"));
		await env.DB.prepare(
			"UPDATE transactions SET date='2026-11-03' WHERE id=(SELECT transaction_id FROM bill_payments WHERE status='linked' AND period='2026-10-30' AND bill_id=(SELECT id FROM bills WHERE name='Daycare'))",
		).run();
		const { rows } = await loadBillRows(env.DB, "2026-10-30");
		const daycare = rows.find((row) => row.name === "Daycare");
		expect(
			daycare?.totalOccurrences.find(
				(occurrence) => occurrence.dueDate === "2026-10-30",
			)?.paidMonth,
		).toBe("2026-10");
		expect(before).toBeDefined();
		expect(totalOf(groupUnder(await billsPage(), "Paid this month"))).toBe(
			before,
		);
	});
});

// Decision 122 (#602): a monthly bill's unpaid occurrence it has handed off stays in Overdue until the next one is due.
describe("Overdue counts a monthly bill's handed-off unpaid occurrence, named under the heading (#602)", () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-28T15:00:00Z"));
		await resetDemo(env.DB, "2026-10-28");
	});
	afterEach(() => vi.useRealTimers());

	it("names Rent's unpaid Oct 1 under Overdue and counts what is left of it, with Electric and Netflix as rows", async () => {
		const overdue = groupUnder(await billsPage(), "Overdue");
		expect(rowNamesOf(overdue)).toEqual(["Electric", "Netflix"]);
		expect(totalOf(overdue)).toBe("$757.49");
		expect(overdue).toContain("Includes Rent on Oct 1</p>");
		expect(overdue).toContain("<ul");
	});

	it("draws no empty list under a heading whose rows are none, only its total and the line naming its occurrences", async () => {
		await env.DB.prepare(
			"UPDATE bills SET active=0 WHERE name IN ('Electric','Netflix')",
		).run();
		const overdue = groupUnder(await billsPage(), "Overdue");
		expect(overdue).toContain(">Overdue</h2>");
		expect(totalOf(overdue)).toBe("$600.00");
		expect(overdue).toContain("Includes Rent on Oct 1</p>");
		expect(overdue).not.toContain("<ul");
	});
});

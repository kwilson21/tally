import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDemo } from "../src/demo/reset";

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

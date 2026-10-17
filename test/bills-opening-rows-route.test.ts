import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDemo } from "../src/demo/reset";

const get = async (path: string) =>
	(await exports.default.fetch(`http://tally.test${path}`)).text();

/** One Bills group: its `<section>` block, found by its heading, cut before the next section. */
const groupUnder = (html: string, heading: string) =>
	(
		html.split("<section").find((part) => part.includes(`>${heading}</h2>`)) ??
		""
	).split("</section>")[0] ?? "";

// Issue #602: rows that open end in the row arrow (P118 A), Home's due-soon rows open their bill, and the Band's pager
// dots show only when two or more plans wait.
describe("Bills' opening rows and Band on the page (issue #602)", () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-15T15:00:00Z"));
		await resetDemo(env.DB, "2026-10-15");
	});
	afterEach(() => vi.useRealTimers());

	it("opens each bill on Home's Bills due soon, ending in the row arrow", async () => {
		const { id } = (await env.DB.prepare(
			"SELECT id FROM bills WHERE name='Internet'",
		).first<{ id: number }>()) as { id: number };
		const home = await get("/");
		expect(home).toContain("Bills due soon");
		expect(home).toMatch(
			new RegExp(`<a href="/bills/${id}" class="[^"]*\\brow-opens\\b[^"]*"`),
		);
		expect(groupUnder(home, "Bills due soon")).toContain(">Internet<");
	});

	it("ends a planned row that opens its plan in the row arrow", async () => {
		const html = await get("/bills");
		expect(html).toMatch(
			/<a id="plan-\d+" href="\/plans\/\d+\/edit" class="[^"]*\brow-opens\b/,
		);
		expect(groupUnder(html, "Planned")).toContain("Lawn service");
	});

	it("draws no pager dot for the one plan that wasn't paid", async () => {
		const html = await get("/bills");
		expect(html).toContain("Car registration wasn&#39;t paid");
		expect(html).not.toContain("size-2.5 rounded-full");
		expect(html).not.toContain("planned expenses that weren&#39;t paid");
	});

	it("draws a dot for each of two plans that weren't paid, and says how many", async () => {
		await env.DB.prepare(
			"INSERT INTO planned_expenses(name,amount_cents,month,transaction_id,created_by) VALUES('Holiday gift',5000,'2026-09',NULL,'test')",
		).run();
		const html = await get("/bills");
		expect(html.match(/size-2\.5 rounded-full/g)?.length).toBe(2);
		expect(html).toContain("1 of 2 planned expenses that weren&#39;t paid");
	});
});

// Decision 122: a heading whose total counts only occurrences no row lists still shows, with its total and its line.
describe("Paid this month with only unlisted payments (decision 122)", () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-11T16:00:00Z"));
		await resetDemo(env.DB, "2026-10-11");
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bills"),
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9671,'Friday paid fixture',24000,5,'weekly',5,'FRIDAY PAID FIXTURE')",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9681,1,'2026-10-02',24000,'Friday Paid Oct Two'),(9682,1,'2026-10-09',24000,'Friday Paid Oct Nine')",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9671,'2026-10-02',9681,'user','linked'),(9671,'2026-10-09',9682,'user','linked')",
			),
		]);
	});
	afterEach(() => vi.useRealTimers());

	it("shows the heading with its total and the line naming the Fridays no row lists", async () => {
		const paid = groupUnder(await get("/bills"), "Paid this month");
		expect(paid).toContain(
			'<span class="ml-auto shrink-0 tabular-nums">$480.00</span>',
		);
		expect(paid).toContain(
			"Includes Friday paid fixture&#39;s Fridays on Oct 2 and 9</p>",
		);
		expect(paid).not.toContain("row-opens");
	});
});

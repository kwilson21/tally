import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	type BillFindingCharge,
	findBillSuggestions,
	loadBillSuggestions,
	threeMonthsBack,
} from "../src/bills/find";
import { todayUtc } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

const charge = (date: string, amountCents = 1000): BillFindingCharge => ({
	rawName: "GYM",
	displayName: "Gym",
	date,
	amountCents,
	categoryId: 2,
});

describe("finding bills", () => {
	it("allows other purchases between the monthly pair, anchored on the latest charge", () => {
		expect(
			findBillSuggestions([
				charge("2026-08-01", 1000),
				charge("2026-08-15", 5000),
				charge("2026-09-01", 1000),
			]),
		).toMatchObject([{ amountCents: 1000, dueDay: 1, chargeCount: 3 }]);
	});

	it("requires two eligible charges 25–35 days apart and within 10%", () => {
		expect(
			findBillSuggestions([charge("2026-08-01"), charge("2026-09-01", 1100)]),
		).toHaveLength(1);
		expect(
			findBillSuggestions([charge("2026-08-01"), charge("2026-08-26", 900)]),
		).toHaveLength(1);
		for (const rows of [
			[charge("2026-08-01")],
			[charge("2026-08-01"), charge("2026-08-25")],
			[charge("2026-08-01"), charge("2026-09-06")],
			[charge("2026-08-01"), charge("2026-09-01", 1101)],
		])
			expect(findBillSuggestions(rows)).toHaveLength(0);
	});

	it("suggests the latest amount/day and most-used category", () => {
		const found = findBillSuggestions([
			{ ...charge("2026-07-01"), categoryId: 3 },
			{ ...charge("2026-08-01", 1050), categoryId: 3 },
			{ ...charge("2026-09-01", 1075), categoryId: 2 },
		]);
		expect(found[0]).toMatchObject({
			amountCents: 1075,
			dueDay: 1,
			categoryId: 3,
		});
	});

	it("qualifies a merchant when its latest charge repeats an earlier one", () => {
		expect(
			findBillSuggestions([
				charge("2026-07-01", 900),
				charge("2026-08-01", 1000),
				charge("2026-09-01", 1050),
			]),
		).toMatchObject([{ amountCents: 1050, dueDay: 1, chargeCount: 3 }]);
	});

	it("does not qualify Whole Foods from an old pair when its latest charge is a one-off", () => {
		expect(
			findBillSuggestions([
				charge("2026-08-23", 10000),
				charge("2026-09-23", 10200),
				charge("2026-10-04", 9630),
			]),
		).toEqual([]);
	});

	it("clamps the three-month cutoff at month end", () => {
		expect(threeMonthsBack("2026-05-31")).toBe("2026-02-28");
		expect(threeMonthsBack("2024-05-31")).toBe("2024-02-29");
	});

	it("suggests exactly the seeded subscriptions on every representative date", async () => {
		for (const date of [
			"2026-01-01",
			"2026-06-15",
			"2028-02-29",
			"2026-10-31",
			"2026-12-31",
		]) {
			await resetDemo(env.DB, date);
			expect(
				(await loadBillSuggestions(env.DB, date)).map((row) => row.displayName),
			).toEqual(["City Gym", "Procreate Dreams", "YouTube Premium"]);
		}
	});

	it.each([
		["excluded rows", "excluded=1"],
		["income", "flag_income=1"],
		["split parents", "is_split=1"],
		["split children", "parent_id=1"],
		["money-in rows", "amount_cents=-amount_cents"],
	] as const)("filters %s", async (_label, mutation) => {
		await resetDemo(env.DB, todayUtc());
		await insertCandidate("FILTER ME");
		await env.DB.prepare(`UPDATE transactions SET ${mutation} WHERE raw_name=?`)
			.bind("FILTER ME")
			.run();
		expect(await loadBillSuggestions(env.DB, todayUtc())).not.toContainEqual(
			expect.objectContaining({ rawName: "FILTER ME" }),
		);
	});

	it("suggests a fresh candidate (the control for the filter tests)", async () => {
		await resetDemo(env.DB, todayUtc());
		await insertCandidate("KEEP ME");
		expect(await loadBillSuggestions(env.DB, todayUtc())).toContainEqual(
			expect.objectContaining({ rawName: "KEEP ME" }),
		);
	});

	it("dismisses a merchant whose name has a percent sign", async () => {
		await resetDemo(env.DB, todayUtc());
		await insertCandidate("100% PURE");
		const response = await exports.default.fetch(
			"http://tally.test/bills/find/100%25%20PURE/dismiss",
			{
				method: "POST",
				headers: { Origin: "http://tally.test", "HX-Request": "true" },
			},
		);
		expect(response.status).toBe(200);
		expect(
			await env.DB.prepare("SELECT not_a_bill FROM merchants WHERE raw_name=?")
				.bind("100% PURE")
				.first("not_a_bill"),
		).toBe(1);
	});

	it("saves nothing when the name isn't a current suggestion", async () => {
		await resetDemo(env.DB, todayUtc());
		const response = await exports.default.fetch(
			"http://tally.test/bills/find/NOT%20LISTED/dismiss",
			{ method: "POST", headers: { Origin: "http://tally.test" } },
		);
		expect(response.status).toBe(404);
		expect(
			await env.DB.prepare(
				"SELECT 1 FROM merchants WHERE raw_name='NOT LISTED'",
			).first(),
		).toBeNull();
	});

	it("filters merchants that already have a bill", async () => {
		await resetDemo(env.DB, todayUtc());
		await insertCandidate("HAS BILL");
		await env.DB.prepare(
			"INSERT INTO bills(name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES('Existing',1000,1,'monthly',1,?)",
		)
			.bind("HAS BILL")
			.run();
		expect(await loadBillSuggestions(env.DB, todayUtc())).not.toContainEqual(
			expect.objectContaining({ rawName: "HAS BILL" }),
		);
	});

	it("filters merchants marked not_a_bill", async () => {
		await resetDemo(env.DB, todayUtc());
		await insertCandidate("NOT A BILL", 1);
		expect(await loadBillSuggestions(env.DB, todayUtc())).not.toContainEqual(
			expect.objectContaining({ rawName: "NOT A BILL" }),
		);
	});

	it("prefills every Add value", async () => {
		await resetDemo(env.DB, todayUtc());
		const html = await (
			await exports.default.fetch("http://tally.test/bills/find")
		).text();
		expect(html).toContain(
			"/bills/new?name=City+Gym&amp;amount=42.50&amp;due_day=4&amp;frequency=monthly&amp;category_id=5&amp;merchant_raw_name=CITY+GYM+MEMBERSHIP",
		);
	});

	it("remembers Not a bill and removes the row with feedback", async () => {
		await resetDemo(env.DB, todayUtc());
		const raw = (await loadBillSuggestions(env.DB, todayUtc()))[0]?.rawName;
		const response = await exports.default.fetch(
			`http://tally.test/bills/find/${encodeURIComponent(raw ?? "")}/dismiss`,
			{
				method: "POST",
				headers: { Origin: "http://tally.test", "HX-Request": "true" },
			},
		);
		expect(JSON.parse(response.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: { message: "Marked as not a bill", type: "success" },
			announce: "Suggestion removed",
		});
		expect(
			await env.DB.prepare("SELECT not_a_bill FROM merchants WHERE raw_name=?")
				.bind(raw)
				.first("not_a_bill"),
		).toBe(1);
	});

	it("returns the empty state when dismissing the last suggestion", async () => {
		await resetDemo(env.DB, todayUtc());
		await env.DB.prepare(
			"UPDATE merchants SET not_a_bill=1 WHERE raw_name <> 'CITY GYM MEMBERSHIP'",
		).run();
		const response = await exports.default.fetch(
			"http://tally.test/bills/find/CITY%20GYM%20MEMBERSHIP/dismiss",
			{
				method: "POST",
				headers: { Origin: "http://tally.test", "HX-Request": "true" },
			},
		);
		expect(await response.text()).toContain("No possible bills to review.");
	});
});

/** A day `days` before today, as YYYY-MM-DD. */
const daysAgo = (days: number) =>
	new Date(Date.parse(`${todayUtc()}T00:00:00Z`) - days * 86400000)
		.toISOString()
		.slice(0, 10);

/** Two $10 charges 30 days apart, both inside the three-month window. */
async function insertCandidate(rawName: string, notABill = 0) {
	await env.DB.prepare(
		"INSERT INTO merchants(raw_name,display_name,default_category_id,not_a_bill) VALUES(?,?,4,?)",
	)
		.bind(rawName, rawName, notABill)
		.run();
	await env.DB.prepare(
		`INSERT INTO transactions(account_id,date,amount_cents,raw_name,category_id)
		 SELECT id,?,1000,?,4 FROM accounts LIMIT 1`,
	)
		.bind(daysAgo(40), rawName)
		.run();
	await env.DB.prepare(
		`INSERT INTO transactions(account_id,date,amount_cents,raw_name,category_id)
		 SELECT id,?,1000,?,4 FROM accounts LIMIT 1`,
	)
		.bind(daysAgo(10), rawName)
		.run();
}

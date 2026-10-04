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

	it("requires the latest two charges to be the monthly pattern", () => {
		expect(
			findBillSuggestions([charge("2026-08-01"), charge("2026-09-01")]),
		).toHaveLength(1);
		expect(
			findBillSuggestions([
				charge("2026-08-23", 8000),
				charge("2026-09-23", 8000),
				charge("2026-10-04", 9630),
			]),
		).toHaveLength(0);
	});

	it("clamps the three-month cutoff at month end", () => {
		expect(threeMonthsBack("2026-05-31")).toBe("2026-02-28");
		expect(threeMonthsBack("2024-05-31")).toBe("2024-02-29");
		expect(threeMonthsBack("2026-03-31")).toBe("2025-12-31");
	});

	it("filters income, exclusions, split parents and children in the database", async () => {
		await resetDemo(env.DB, todayUtc());
		expect(
			(await loadBillSuggestions(env.DB, todayUtc())).map(
				(row) => row.displayName,
			),
		).toEqual(["City Gym", "Procreate Dreams", "YouTube Premium"]);
		const html = await (
			await exports.default.fetch("http://tally.test/bills/find")
		).text();
		expect(html).toContain("Possible bills");
		expect(html).toContain("charges</p>");
		expect(html).toContain('<form method="post"');
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
});

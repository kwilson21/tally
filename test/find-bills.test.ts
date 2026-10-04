import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type BillFindingCharge, findBillSuggestions } from "../src/bills/find";
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
			findBillSuggestions([charge("2026-08-01"), charge("2026-08-26", 910)]),
		).toHaveLength(1);
		for (const rows of [
			[charge("2026-08-01")],
			[charge("2026-08-01"), charge("2026-08-25")],
			[charge("2026-08-01"), charge("2026-09-06")],
			[charge("2026-08-01"), charge("2026-09-01", 1112)],
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

	it("anchors the match on the latest charge while allowing intervening purchases", () => {
		const found = findBillSuggestions([
			charge("2026-08-01", 1000),
			charge("2026-08-15", 5000),
			charge("2026-09-01", 1000),
		]);
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ amountCents: 1000, dueDay: 1 });
	});

	it("does not qualify when only earlier charges form a monthly pair", () => {
		expect(
			findBillSuggestions([
				charge("2026-08-23", 8000),
				charge("2026-09-23", 8000),
				charge("2026-10-04", 9630),
			]),
		).toHaveLength(0);
	});

	it("filters income, exclusions, split parents and children in the database", async () => {
		await resetDemo(env.DB, todayUtc());
		const html = await (
			await exports.default.fetch("http://tally.test/bills/find")
		).text();
		expect(html).toContain("Possible bills");
		expect(html).toContain("about monthly, around the");
	});

	it("remembers Not a bill and removes the row with feedback", async () => {
		await resetDemo(env.DB, todayUtc());
		const raw = await env.DB.prepare(
			`SELECT raw_name FROM merchants WHERE raw_name NOT IN (SELECT merchant_raw_name FROM bills) LIMIT 1`,
		).first<string>("raw_name");
		const response = await exports.default.fetch(
			`http://tally.test/bills/find/${encodeURIComponent(raw ?? "")}/dismiss`,
			{
				method: "POST",
				headers: { Origin: "http://tally.test", "HX-Request": "true" },
			},
		);
		expect(response.headers.get("HX-Trigger")).toContain('"announce"');
		expect(
			await env.DB.prepare("SELECT not_a_bill FROM merchants WHERE raw_name=?")
				.bind(raw)
				.first("not_a_bill"),
		).toBe(1);
	});

	it("dismisses a raw merchant name containing a percent sign", async () => {
		await resetDemo(env.DB, todayUtc());
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name) VALUES (?, ?)",
		)
			.bind("100% PURE", "100% PURE")
			.run();
		const response = await exports.default.fetch(
			`http://tally.test/bills/find/${encodeURIComponent("100% PURE")}/dismiss`,
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
});

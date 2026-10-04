import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { todayUtc } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

describe("Bills", () => {
	beforeEach(() => resetDemo(env.DB, todayUtc()));
	it("shows grouped active bills and inactive disclosure", async () => {
		const html = await (
			await exports.default.fetch("http://tally.test/bills")
		).text();
		expect(html).toContain("<title>Bills · Tally</title>");
		for (const heading of [
			"Overdue",
			"Due in the next 7 days",
			"Upcoming",
			"Paid this month",
			"Inactive (1)",
		])
			expect(html).toContain(heading);
		expect(html).toContain("bills to pay soon");
	});

	it("adds a bill and returns htmx feedback", async () => {
		const body = new URLSearchParams({
			name: "Gym",
			amount: "42.50",
			due_day: "12",
			frequency: "monthly",
			category_id: "1",
			merchant_raw_name: "CITY GYM",
		});
		const res = await exports.default.fetch("http://tally.test/bills", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"HX-Request": "true",
				Origin: "http://tally.test",
			},
			body,
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Trigger")).toContain("Bill added");
		expect(
			(
				await env.DB.prepare(
					"SELECT amount_cents FROM bills WHERE name = 'Gym'",
				).first<{ amount_cents: number }>()
			)?.amount_cents,
		).toBe(4250);
	});
});

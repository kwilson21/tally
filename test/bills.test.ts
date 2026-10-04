import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { todayUtc } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { loadBillRows } from "../src/routes/bills";

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
		expect(res.headers.get("HX-Push-Url")).toBe("/bills");
		expect(
			(
				await env.DB.prepare(
					"SELECT amount_cents FROM bills WHERE name = 'Gym'",
				).first<{ amount_cents: number }>()
			)?.amount_cents,
		).toBe(4250);
	});

	it("focuses the sheet heading and uses CSS to reveal the yearly month", async () => {
		const html = await (
			await exports.default.fetch("http://tally.test/bills/new")
		).text();
		expect(html).toMatch(/id="bill-sheet-title"[^>]*autofocus/);
		expect(html).toContain('class="bill-form');
		expect(html).toContain('class="bill-month');
	});

	it("does not call an inactive-only bill list empty", async () => {
		await env.DB.prepare("UPDATE bills SET active=0").run();
		const html = await (
			await exports.default.fetch("http://tally.test/bills")
		).text();
		expect(html).toContain("Inactive (7)");
		expect(html).not.toContain("No bills yet.");
	});

	it("validates category and yearly month with alerts", async () => {
		const res = await exports.default.fetch("http://tally.test/bills", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				Origin: "http://tally.test",
			},
			body: new URLSearchParams({
				name: "Tax",
				amount: "10",
				due_day: "1",
				frequency: "yearly",
				anchor_month: "13",
				category_id: "999",
				merchant_raw_name: "TAX",
			}),
		});
		const html = await res.text();
		expect(html.match(/role="alert"/g)?.length).toBe(2);
		expect(html).toContain("Choose a month.");
		expect(html).toContain("Choose an existing category.");
	});

	it("redirects a successful non-htmx save", async () => {
		const res = await exports.default.fetch("http://tally.test/bills", {
			method: "POST",
			redirect: "manual",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				Origin: "http://tally.test",
			},
			body: new URLSearchParams({
				name: "Gym",
				amount: "20",
				due_day: "2",
				frequency: "monthly",
				anchor_month: "1",
				category_id: "1",
				merchant_raw_name: "GYM",
			}),
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/bills");
	});

	it("edits, deactivates and reactivates with announcements", async () => {
		const edit = await exports.default.fetch("http://tally.test/bills/1", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"HX-Request": "true",
				Origin: "http://tally.test",
			},
			body: new URLSearchParams({
				name: "Movies",
				amount: "3.99",
				due_day: "4",
				frequency: "monthly",
				anchor_month: "1",
				category_id: "5",
				merchant_raw_name: "APPLE.COM/BILL",
			}),
		});
		expect(edit.headers.get("HX-Trigger")).toContain('"announce":"Bill saved"');
		expect(
			await env.DB.prepare("SELECT name FROM bills WHERE id=1").first("name"),
		).toBe("Movies");
		for (const [action, message] of [
			["deactivate", "Bill deactivated"],
			["reactivate", "Bill reactivated"],
		]) {
			const res = await exports.default.fetch(
				`http://tally.test/bills/1/${action}`,
				{
					method: "POST",
					headers: { "HX-Request": "true", Origin: "http://tally.test" },
				},
			);
			expect(res.headers.get("HX-Trigger")).toContain(
				`"announce":"${message}"`,
			);
			expect(res.headers.get("HX-Trigger")).toContain("toast");
		}
	});

	it.each([
		"2026-01-01",
		"2026-06-15",
		"2028-02-29",
		"2026-12-09",
		"2026-12-31",
	])("keeps every demo status available on %s", async (date) => {
		await resetDemo(env.DB, date);
		const { rows } = await loadBillRows(env.DB, date);
		expect(
			new Set(rows.filter((row) => row.active).map((row) => row.status)),
		).toEqual(new Set(["overdue", "due", "upcoming", "paid"]));
		const late = rows.find((row) => row.name === "Water");
		expect(late?.paidDate).toBeTruthy();
		expect(late?.paidDate && late.paidDate > late.dueDate).toBe(true);
	});
});

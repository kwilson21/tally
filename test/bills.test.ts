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
		expect(html).toContain("Inactive (6)");
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
		"2026-02-24",
		"2026-03-02",
		"2026-10-26",
		"2026-10-31",
		"2026-12-09",
		"2026-12-31",
	])("keeps every demo status available on %s", async (date) => {
		await resetDemo(env.DB, date);
		const { rows } = await loadBillRows(env.DB, date);
		expect(
			new Set(rows.filter((row) => row.active).map((row) => row.status)),
		).toEqual(new Set(["overdue", "due", "upcoming", "paid"]));
		const late = rows.find((row) => row.name === "Water");
		expect(late).toBeTruthy();
		const waterPayment = await env.DB.prepare(
			`SELECT t.date, CASE WHEN length(bp.period)=4 THEN bp.period || '-' || printf('%02d', b.anchor_month) ELSE bp.period END || '-' || printf('%02d', b.due_day) AS due
			 FROM bill_payments bp JOIN bills b ON b.id=bp.bill_id JOIN transactions t ON t.id=bp.transaction_id
			 WHERE b.name='Water' AND bp.status='linked' ORDER BY bp.period DESC LIMIT 1`,
		).first<{ date: string; due: string }>();
		expect(waterPayment).toBeTruthy();
		expect(
			Math.floor(Date.parse(`${waterPayment?.date}T00:00:00Z`) / 86400000) -
				Math.floor(Date.parse(`${waterPayment?.due}T00:00:00Z`) / 86400000),
		).toBe(3);
		const future = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE date > ?",
		)
			.bind(date)
			.first<{ n: number }>();
		expect(future?.n).toBe(0);
		const onTime = rows.find((row) => row.name === "Streaming");
		expect(onTime?.status).toBe("paid");
		expect(onTime?.paidDate).toBe(onTime?.dueDate);
		// The demo's set-aside stays small enough that Safe to spend stays positive.
		const setAside = rows
			.filter((row) => row.active && ["due", "overdue"].includes(row.status))
			.reduce((sum, row) => sum + row.amountCents, 0);
		expect(setAside).toBeLessThan(25_000);
	});

	it("refuses to save, deactivate or reactivate a missing bill", async () => {
		const post = (path: string, body = "") =>
			exports.default.fetch(`http://tally.test${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"HX-Request": "true",
					Origin: "http://tally.test",
				},
				body,
			});
		const body = new URLSearchParams({
			name: "Gym",
			amount: "42.50",
			due_day: "12",
			frequency: "monthly",
			category_id: "1",
			merchant_raw_name: "CITY GYM",
		}).toString();
		expect((await post("/bills/999999", body)).status).toBe(404);
		expect((await post("/bills/999999/deactivate")).status).toBe(404);
		expect((await post("/bills/999999/reactivate")).status).toBe(404);
	});

	it("gives the bill sheet a Cancel link and clears the URL after deactivating", async () => {
		const html = await (
			await exports.default.fetch("http://tally.test/bills/new")
		).text();
		expect(html).toMatch(/<a[^>]*href="\/bills"[^>]*>\s*Cancel/);
		const { id } = (await env.DB.prepare(
			"SELECT id FROM bills WHERE active=1 LIMIT 1",
		).first<{ id: number }>()) as { id: number };
		const res = await exports.default.fetch(
			`http://tally.test/bills/${id}/deactivate`,
			{
				method: "POST",
				headers: { "HX-Request": "true", Origin: "http://tally.test" },
			},
		);
		expect(res.headers.get("HX-Push-Url")).toBe("/bills");
	});

	it("shows a bill page and lets a person unlink and hand-link a chosen month", async () => {
		let html = await (
			await exports.default.fetch("http://tally.test/bills/1")
		).text();
		expect(html).toContain("Payments");
		expect(html).toContain("Not this one");
		const linked = await env.DB.prepare(
			"SELECT period FROM bill_payments WHERE bill_id=1 AND status='linked'",
		).first<{ period: string }>();
		const unlink = await exports.default.fetch(
			`http://tally.test/bills/1/occurrences/${linked?.period}/unlink`,
			{
				method: "POST",
				redirect: "manual",
				headers: { Origin: "http://tally.test", "HX-Request": "true" },
			},
		);
		expect(unlink.headers.get("HX-Trigger")).toContain("Payment unlinked");
		expect(
			await env.DB.prepare(
				"SELECT status FROM bill_payments WHERE bill_id=1 AND period=?",
			)
				.bind(linked?.period)
				.first("status"),
		).toBe("dismissed");
		html = await (
			await exports.default.fetch(
				`http://tally.test/bills/1/occurrences/${linked?.period}/link`,
			)
		).text();
		expect(html).toContain("Counts in");
		expect(html).toContain("same merchant first, then closest amount");
	});

	it("always shows the current overdue yearly occurrence outside the history window", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare(
				"UPDATE bills SET frequency='yearly',anchor_month=12,due_day=1 WHERE id=1",
			),
		]);
		const html = await (
			await exports.default.fetch("http://tally.test/bills/1")
		).text();
		expect(html).toContain("2025");
		expect(html).toContain("Overdue");
	});

	it("clears links and dismissals when frequency changes", async () => {
		await env.DB.prepare(
			"INSERT OR IGNORE INTO bill_payments(bill_id,period,transaction_id,matched_by,status) SELECT 1,'old-dismissal',id,'user','dismissed' FROM transactions LIMIT 1",
		).run();
		const response = await exports.default.fetch("http://tally.test/bills/1", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				Origin: "http://tally.test",
			},
			body: new URLSearchParams({
				name: "Movies",
				amount: "3.99",
				due_day: "4",
				frequency: "yearly",
				anchor_month: "1",
				category_id: "5",
				merchant_raw_name: "NO AUTOMATIC REMATCH",
			}),
		});
		expect(response.status).toBe(200);
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM bill_payments WHERE bill_id=1",
				).first<{ n: number }>()
			)?.n,
		).toBe(0);
	});

	it("lists only unpaid month choices and captions monthly payments", async () => {
		const linked = await env.DB.prepare(
			"SELECT period FROM bill_payments WHERE bill_id=1 AND status='linked' LIMIT 1",
		).first<{ period: string }>();
		const html = await (
			await exports.default.fetch(
				`http://tally.test/bills/1/occurrences/${linked?.period}/link`,
			)
		).text();
		expect(html).toContain("Which month&#39;s bill does it pay?");
		expect(html).not.toContain(`name="period" value="${linked?.period}"`);
		expect(html).toContain("Counts in the bill month");
	});

	it("returns typed toast and announcement headers for htmx unlink and link", async () => {
		const linked = await env.DB.prepare(
			"SELECT period,transaction_id FROM bill_payments WHERE bill_id=1 AND status='linked' LIMIT 1",
		).first<{ period: string; transaction_id: number }>();
		const unlink = await exports.default.fetch(
			`http://tally.test/bills/1/occurrences/${linked?.period}/unlink`,
			{
				method: "POST",
				headers: { Origin: "http://tally.test", "HX-Request": "true" },
			},
		);
		expect(JSON.parse(unlink.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: { message: "Payment unlinked", type: "success" },
			announce: "Payment unlinked",
		});
		const link = await exports.default.fetch("http://tally.test/bills/1/link", {
			method: "POST",
			headers: {
				Origin: "http://tally.test",
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				transaction_id: String(linked?.transaction_id),
				period: String(linked?.period),
				opened_period: String(linked?.period),
			}),
		});
		expect(JSON.parse(link.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: { message: "Payment linked", type: "success" },
			announce: "Payment linked",
		});
	});

	it("picker uses a 30-day window, preferred order, 50-row cap, and exclusions", async () => {
		const today = todayUtc();
		const period = today.slice(0, 7);
		const day = Number(today.slice(8, 10));
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=1"),
			env.DB.prepare(
				"UPDATE bills SET due_day=?,amount_cents=1000,frequency='monthly',merchant_raw_name='PREFERRED' WHERE id=1",
			).bind(day),
		]);
		const statements = [];
		for (let i = 0; i < 55; i++)
			statements.push(
				env.DB.prepare(
					"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT ?,id,?,?,? FROM accounts LIMIT 1",
				).bind(
					1000 + i,
					today,
					1000 + i,
					i === 54 ? "PREFERRED" : `CANDIDATE ${i}`,
				),
			);
		statements.push(
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,flag_income) SELECT 1100,id,?,1000,'INCOME',1 FROM accounts LIMIT 1",
			).bind(today),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 1101,id,date(?, '-31 day'),1000,'TOO OLD' FROM accounts LIMIT 1",
			).bind(today),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(1,?,1001,'user','dismissed')",
			).bind(period),
		);
		await env.DB.batch(statements);
		const html = await (
			await exports.default.fetch(
				`http://tally.test/bills/1/occurrences/${period}/link`,
			)
		).text();
		expect(html.match(/name="transaction_id"/g) ?? []).toHaveLength(50);
		expect(html).not.toContain("INCOME");
		expect(html).not.toContain("TOO OLD");
		expect(html).not.toContain("CANDIDATE 1");
		const picker = html.slice(html.indexOf('<section id="payment-picker"'));
		expect(picker.indexOf('value="1054"')).toBeLessThan(
			picker.indexOf('value="1000"'),
		);
	});

	it("returns 404 for a malformed occurrence period", async () => {
		expect(
			(
				await exports.default.fetch(
					"http://tally.test/bills/1/occurrences/not-a-month/link",
				)
			).status,
		).toBe(404);
	});
});

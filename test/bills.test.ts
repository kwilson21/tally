import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { loadBillSuggestions } from "../src/bills/find";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { app } from "../src/index";
import { loadBillRows } from "../src/routes/bills";

describe("Bills", () => {
	beforeEach(() => resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE)));
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

	it("has a How this works link to the Bills section, under the status sentence (decision 82)", async () => {
		const html = await (
			await exports.default.fetch("http://tally.test/bills")
		).text();
		const link =
			/<a href="\/how-it-works#bills" aria-label="How this works: bills" class="[^"]*min-h-11[^"]*">How this works<\/a>/;
		expect(html).toMatch(link);
		expect(html.match(/\/how-it-works#bills/g)).toHaveLength(1);
		const at = (text: string | RegExp) =>
			typeof text === "string" ? html.indexOf(text) : html.search(text);
		expect(at("bills to pay soon")).toBeLessThan(at(link));
		expect(at(link)).toBeLessThan(at("Add a bill"));
		// The section it points to is on How Tally works.
		const how = await (
			await exports.default.fetch("http://tally.test/how-it-works")
		).text();
		expect(how).toMatch(/<section[^>]*id="bills"/);
	});

	it("keeps the How this works link when there are no bills", async () => {
		await env.DB.prepare("DELETE FROM bills").run();
		const html = await (
			await exports.default.fetch("http://tally.test/bills")
		).text();
		expect(html).toContain('href="/how-it-works#bills"');
	});

	// DESIGN.md Type roles: a page title is 5xl, so the title does not shrink on the Bills tab.
	it.each([
		["/bills", "Bills"],
		["/bills/find", "Possible bills"],
	])("draws %s's h1 as a 5xl page title", async (path, title) => {
		const html = await (
			await exports.default.fetch(`http://tally.test${path}`)
		).text();
		expect(html).toMatch(
			new RegExp(
				`<h1 class="font-serif text-5xl font-semibold tracking-tight">\\s*${title}\\s*</h1>`,
			),
		);
	});

	it("keeps the Add a bill sheet's title at the 4xl sheet role, a size below the page's", async () => {
		const html = await (
			await exports.default.fetch("http://tally.test/bills/new")
		).text();
		expect(html).toContain(
			'<h2 id="bill-sheet-title" class="font-serif text-4xl font-semibold tracking-tight"',
		);
		expect(html).toContain(
			'<h1 class="font-serif text-5xl font-semibold tracking-tight">Bills</h1>',
		);
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
			(await loadBillSuggestions(env.DB, date)).map((row) => row.displayName),
		).toEqual(["City Gym", "Procreate Dreams", "YouTube Premium"]);
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
		const lookalike = await env.DB.prepare(
			`SELECT t.id, t.date, t.amount_cents, bp.status
			 FROM transactions t
			 JOIN bills b ON b.name='Streaming' AND b.merchant_raw_name=t.raw_name
			 LEFT JOIN bill_payments bp ON bp.transaction_id=t.id
			 WHERE t.amount_cents BETWEEN b.amount_cents * 0.9 AND b.amount_cents * 1.1
			   AND t.date <> ?
			 ORDER BY t.date DESC LIMIT 1`,
		)
			.bind(onTime?.paidDate)
			.first<{
				id: number;
				date: string;
				amount_cents: number;
				status: string | null;
			}>();
		expect(lookalike).toBeTruthy();
		expect(Boolean(lookalike?.date && lookalike.date <= date)).toBe(true);
		expect(lookalike?.status).toBeNull();
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
		expect(html).toContain("A late payment counts in its bill&#39;s month");
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

	it("keeps a bill's schedule while it has linked payments, and clears old dismissals otherwise", async () => {
		const change = () =>
			exports.default.fetch("http://tally.test/bills/1", {
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
		const count = async () =>
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM bill_payments WHERE bill_id=1",
				).first<{ n: number }>()
			)?.n;
		const before = await count();
		expect(before).toBeGreaterThan(0);
		const refused = await change();
		expect(refused.status).toBe(200);
		expect(await refused.text()).toContain("This bill has payments linked");
		expect(await count()).toBe(before);
		expect(
			(
				await env.DB.prepare("SELECT frequency FROM bills WHERE id=1").first<{
					frequency: string;
				}>()
			)?.frequency,
		).toBe("monthly");

		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=1"),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) SELECT 1,'2026-01',id,'user','dismissed' FROM transactions LIMIT 1",
			),
		]);
		expect((await change()).status).toBe(200);
		expect(await count()).toBe(0);
	});

	it("also refuses to change a linked yearly bill's month", async () => {
		await env.DB.prepare(
			"UPDATE bills SET frequency='yearly',anchor_month=3 WHERE id=1",
		).run();
		const res = await exports.default.fetch("http://tally.test/bills/1", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				Origin: "http://tally.test",
			},
			body: new URLSearchParams({
				name: "Streaming",
				amount: "2.99",
				due_day: "4",
				frequency: "yearly",
				anchor_month: "4",
				category_id: "5",
				merchant_raw_name: "APPLE.COM/BILL",
			}),
		});
		expect(await res.text()).toContain(
			"To change when it&#39;s due, deactivate it and add a new bill.",
		);
		expect(
			await env.DB.prepare("SELECT anchor_month FROM bills WHERE id=1").first(
				"anchor_month",
			),
		).toBe(3);
	});

	it("keeps an unpaid recent month before a newer linked month", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=1"),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) SELECT 1,?,id,'user','linked' FROM transactions LIMIT 1",
			).bind(todayIn(DEFAULT_TIME_ZONE).slice(0, 7)),
		]);
		const earlier = new Date(
			`${todayIn(DEFAULT_TIME_ZONE).slice(0, 7)}-01T00:00:00Z`,
		);
		earlier.setUTCMonth(earlier.getUTCMonth() - 5);
		const period = earlier.toISOString().slice(0, 7);
		const html = await (
			await exports.default.fetch("http://tally.test/bills/1")
		).text();
		expect(html).toContain(`occurrences/${period}/link`);
		expect(html).toContain("Not paid");
	});

	it("refreshes candidates and explanation when the chosen month changes", async () => {
		const period = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		await env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=1").run();
		const html = await (
			await exports.default.fetch(
				`http://tally.test/bills/1/occurrences/${period}/link`,
			)
		).text();
		expect(html).toContain('hx-target="#payment-picker"');
		expect(html).toContain(
			'hx-include="[name=&#39;transaction_id&#39;],[name=&#39;period&#39;]"',
		);
		expect(html).toContain('aria-live="polite"');
		expect(html).toContain(
			"A late payment counts in its bill&#39;s month; an early one stays in the month it was paid.",
		);
	});

	it("reports the selected month when a payment is outside its 30-day window", async () => {
		const period = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		await env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=1").run();
		const old = await env.DB.prepare(
			"SELECT id FROM transactions ORDER BY date LIMIT 1",
		).first<number>("id");
		const res = await exports.default.fetch("http://tally.test/bills/1/link", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				Origin: "http://tally.test",
			},
			body: new URLSearchParams({
				transaction_id: String(old),
				period,
				opened_period: period,
			}),
		});
		expect(await res.text()).toContain(
			`That payment isn&#39;t within 30 days of`,
		);
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
		expect(html).toContain("A late payment counts in its bill&#39;s month");
		expect(html).toMatch(/To [A-Z][a-z]+&#39;s Streaming, \$2\.99\./);
		expect(html).toMatch(
			/Within 30 days of [A-Z][a-z]{2} \d{1,2}, same merchant first, then closest amount\./,
		);
		expect(html).toContain("an early one stays in the month it was paid");
	});

	it("bill rows use drawn statuses, compact month labels, actions, and guidance", async () => {
		const html = await (
			await exports.default.fetch("http://tally.test/bills/1")
		).text();
		expect(html).toContain("rounded-control bg-band");
		expect(html).toContain('class="size-4"');
		expect(html).toContain("-ml-2");
		expect(html).toContain("Deactivate");
		expect(html).toContain("&quot;Not this one&quot;");
		expect(html).not.toContain("· matched");
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

	it("picker uses a 30-day window, preferred order, every eligible payment, and exclusions", async () => {
		const today = todayIn(DEFAULT_TIME_ZONE);
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
		// Every eligible payment stays reachable, even the furthest in amount.
		expect(
			html.match(/name="transaction_id" value="10\d\d"/g) ?? [],
		).toHaveLength(54);
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

// Spec §8.5, decision 72 (P45 A): no two active bills share a name, and an amount over $100,000
// is saved only once a "Yes, $X is right" chip for that exact amount is ticked.
describe("Bill guards", () => {
	beforeEach(() => resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE)));

	const fields = (over: Record<string, string> = {}) =>
		new URLSearchParams({
			name: "Gym",
			amount: "42.50",
			due_day: "12",
			frequency: "monthly",
			anchor_month: "1",
			category_id: "5",
			merchant_raw_name: "CITY GYM",
			...over,
		});
	const post = (path: string, body: URLSearchParams, htmx = true) =>
		exports.default.fetch(`http://tally.test${path}`, {
			method: "POST",
			redirect: "manual",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				Origin: "http://tally.test",
				...(htmx ? { "HX-Request": "true" } : {}),
			},
			body,
		});
	const billCount = async () =>
		(
			await env.DB.prepare("SELECT COUNT(*) AS n FROM bills").first<{
				n: number;
			}>()
		)?.n;
	const nameOf = async (id: number) =>
		env.DB.prepare("SELECT name FROM bills WHERE id=?").bind(id).first("name");
	const amountOf = async (id: number) =>
		env.DB.prepare("SELECT amount_cents FROM bills WHERE id=?")
			.bind(id)
			.first("amount_cents");
	/** The confirm chip's input tag, or undefined when the form has none. */
	const confirmChip = (html: string) =>
		html.match(/<input[^>]*name="confirm_amount"[^>]*>/)?.[0];

	describe("duplicate names", () => {
		it.each([
			["the same name", "Streaming"],
			["another case", "STREAMING"],
			["spaces around it", "  streaming  "],
		])("refuses adding %s as an active bill", async (_label, name) => {
			const before = await billCount();
			const res = await post("/bills", fields({ name }));
			const html = await res.text();
			expect(res.status).toBe(200);
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(html).toContain("You already have a bill called Streaming.");
			expect(html).toMatch(
				/<p id="bill-name-error" role="alert"[^>]*>You already have a bill called Streaming\.<\/p>/,
			);
			expect(html).toMatch(
				/<input[^>]*id="bill-name"[^>]*aria-describedby="bill-name-error"/,
			);
			// The form comes back with what was typed, ready to fix.
			expect(html).toContain('id="bill-sheet-title"');
			expect(html).toContain('value="CITY GYM"');
			expect(await billCount()).toBe(before);
		});

		it("refuses it without JavaScript the same way", async () => {
			const before = await billCount();
			const res = await post("/bills", fields({ name: "water" }), false);
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("<form");
			expect(html).toContain('role="alert"');
			expect(html).toContain("You already have a bill called Water.");
			expect(await billCount()).toBe(before);
		});

		it("lets a bill keep its own name when it is edited", async () => {
			for (const name of ["Streaming", "  streaming ", "STREAMING"]) {
				const res = await post(
					"/bills/1",
					fields({ name, amount: "3.99", merchant_raw_name: "APPLE.COM/BILL" }),
				);
				expect(res.headers.get("HX-Trigger")).toContain(
					'"announce":"Bill saved"',
				);
				expect(await nameOf(1)).toBe(name.trim());
			}
		});

		it("refuses editing a bill to another active bill's name", async () => {
			const res = await post(
				"/bills/1",
				fields({ name: " water", merchant_raw_name: "APPLE.COM/BILL" }),
			);
			const html = await res.text();
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(html).toContain("You already have a bill called Water.");
			expect(await nameOf(1)).toBe("Streaming");
		});

		describe("bills that already share a name", () => {
			// Two active Rent bills, as a family's data may already hold. Ids 8 and 9.
			beforeEach(async () => {
				for (const merchant of ["LANDLORD", "LANDLORD 2"])
					await env.DB.prepare(
						`INSERT INTO bills(name,amount_cents,due_day,frequency,category_id,merchant_raw_name)
						 VALUES('Rent',100000,1,'monthly',5,?)`,
					)
						.bind(merchant)
						.run();
			});
			const edit = (id: number, over: Record<string, string>) =>
				post(
					`/bills/${id}`,
					fields({
						name: "Rent",
						amount: "1200.00",
						due_day: "1",
						merchant_raw_name: id === 8 ? "LANDLORD" : "LANDLORD 2",
						...over,
					}),
				);

			it.each([8, 9])("still lets bill %i's amount be changed", async (id) => {
				const res = await edit(id, { amount: "1250.00" });
				expect(res.headers.get("HX-Trigger")).toContain(
					'"announce":"Bill saved"',
				);
				expect(await amountOf(id)).toBe(125000);
				expect(await nameOf(id)).toBe("Rent");
			});

			it.each([8, 9])(
				"still refuses renaming bill %i to a third bill's name",
				async (id) => {
					const res = await edit(id, { name: "water" });
					const html = await res.text();
					expect(res.headers.get("HX-Trigger")).toBeNull();
					expect(html).toContain("You already have a bill called Water.");
					expect(await nameOf(id)).toBe("Rent");
				},
			);

			it("still refuses adding another bill with the shared name", async () => {
				const res = await post("/bills", fields({ name: "RENT" }));
				expect(res.headers.get("HX-Trigger")).toBeNull();
				expect(await res.text()).toContain(
					"You already have a bill called Rent.",
				);
			});
		});

		it("compares names as the database does: spaces and A to Z only", async () => {
			const add = (name: string) =>
				post("/bills", fields({ name, merchant_raw_name: name }));
			expect((await add("Café")).headers.get("HX-Trigger")).toContain(
				"Bill added",
			);
			// É is a different letter from é, in the form and in the write alike.
			expect((await add("CAFÉ")).headers.get("HX-Trigger")).toContain(
				"Bill added",
			);
			// Rent and " RENT " are the same name in both.
			expect((await add("Rent")).headers.get("HX-Trigger")).toContain(
				"Bill added",
			);
			const again = await add(" RENT ");
			expect(again.headers.get("HX-Trigger")).toBeNull();
			expect(await again.text()).toContain(
				"You already have a bill called Rent.",
			);
			expect(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM bills WHERE active=1 AND name IN ('Café','CAFÉ','Rent')",
				).first("n"),
			).toBe(3);
		});

		it("lets an add reuse an inactive bill's name", async () => {
			const res = await post(
				"/bills",
				fields({ name: "old PHONE plan", merchant_raw_name: "PHONE CO" }),
			);
			expect(res.headers.get("HX-Trigger")).toContain("Bill added");
			expect(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM bills WHERE name='old PHONE plan' AND active=1",
				).first("n"),
			).toBe(1);
		});

		it("refuses reactivating a bill that would duplicate an active one", async () => {
			await env.DB.prepare(
				`INSERT INTO bills(name,amount_cents,due_day,frequency,category_id,merchant_raw_name)
				 VALUES('old phone plan',4000,3,'monthly',5,'PHONE CO')`,
			).run();
			for (const htmx of [true, false]) {
				const res = await post(
					"/bills/7/reactivate",
					new URLSearchParams(),
					htmx,
				);
				const html = await res.text();
				expect(res.status).toBe(200);
				expect(res.headers.get("HX-Trigger")).toBeNull();
				expect(html).toContain(
					"You already have a bill called old phone plan.",
				);
				expect(html).toMatch(/<p id="bill-name-error" role="alert"/);
				expect(
					await env.DB.prepare("SELECT active FROM bills WHERE id=7").first(
						"active",
					),
				).toBe(0);
			}
		});

		it("reactivates an inactive bill when no active bill has its name", async () => {
			const res = await post("/bills/7/reactivate", new URLSearchParams());
			expect(res.headers.get("HX-Trigger")).toContain("Bill reactivated");
			expect(
				await env.DB.prepare("SELECT active FROM bills WHERE id=7").first(
					"active",
				),
			).toBe(1);
		});

		it("still refuses reactivating a missing bill with a 404", async () => {
			expect(
				(await post("/bills/999999/reactivate", new URLSearchParams())).status,
			).toBe(404);
		});
	});

	// Two saves can both pass the form's check; the write itself then refuses the second.
	describe("a duplicate that lands between the check and the write", () => {
		const competing = (name: string) =>
			`INSERT INTO bills(name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES('${name}',1000,1,'monthly',5,'RIVAL CO')`;
		/** The worker's env with a DB that runs `rival` just before the first statement starting with `sql` runs. */
		const racing = (sql: string, rival: string) => {
			let raced = false;
			const guard = (statement: D1PreparedStatement): D1PreparedStatement =>
				new Proxy(statement, {
					get(target, prop) {
						if (prop === "bind")
							return (...values: unknown[]) => guard(target.bind(...values));
						if (prop === "run")
							return async () => {
								if (!raced) {
									raced = true;
									await env.DB.prepare(rival).run();
								}
								return target.run();
							};
						const value = Reflect.get(target, prop);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			const DB = new Proxy(env.DB, {
				get(target, prop) {
					if (prop === "prepare")
						return (text: string) =>
							text.startsWith(sql)
								? guard(target.prepare(text))
								: target.prepare(text);
					const value = Reflect.get(target, prop);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			return { ...env, DB };
		};
		const send = (path: string, body: URLSearchParams, worker: Env) =>
			app.request(
				`http://tally.test${path}`,
				{
					method: "POST",
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						"HX-Request": "true",
						Origin: "http://tally.test",
					},
					body,
				},
				worker,
			);
		const gyms = async () =>
			(
				await env.DB.prepare(
					"SELECT name FROM bills WHERE lower(name)='gym' AND active=1",
				).all<{ name: string }>()
			).results.map((r) => r.name);

		it("refuses an add, and shows the Name error", async () => {
			const res = await send(
				"/bills",
				fields({ name: "Gym" }),
				racing("INSERT INTO bills", competing("gym")),
			);
			const html = await res.text();
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(html).toContain("You already have a bill called gym.");
			expect(html).toMatch(/<p id="bill-name-error" role="alert"/);
			expect(await gyms()).toEqual(["gym"]);
		});

		it("refuses an edit, and leaves the bill as it was", async () => {
			const res = await send(
				"/bills/1",
				fields({ name: "Gym", merchant_raw_name: "APPLE.COM/BILL" }),
				racing("UPDATE bills SET name", competing("gym")),
			);
			const html = await res.text();
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(html).toContain("You already have a bill called gym.");
			expect(await nameOf(1)).toBe("Streaming");
			expect(await amountOf(1)).toBe(299);
			expect(await gyms()).toEqual(["gym"]);
		});

		it("refuses a reactivation", async () => {
			const res = await send(
				"/bills/7/reactivate",
				new URLSearchParams(),
				racing("UPDATE bills SET active", competing("Old phone plan")),
			);
			const html = await res.text();
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(html).toContain("You already have a bill called Old phone plan.");
			expect(
				await env.DB.prepare("SELECT active FROM bills WHERE id=7").first(
					"active",
				),
			).toBe(0);
		});
	});

	// When reactivating is refused, the Name field is the way out: rename it, then Reactivate.
	describe("renaming while reactivating", () => {
		const repeatActive = () =>
			env.DB.prepare(
				`INSERT INTO bills(name,amount_cents,due_day,frequency,category_id,merchant_raw_name)
				 VALUES('old phone plan',4000,3,'monthly',5,'PHONE CO')`,
			).run();
		const statusOf = (id: number) =>
			env.DB.prepare("SELECT name,active FROM bills WHERE id=?")
				.bind(id)
				.first<{ name: string; active: number }>();

		it("makes Reactivate send the typed name only after a refusal", async () => {
			const plain = await (
				await exports.default.fetch("http://tally.test/bills/7/edit")
			).text();
			expect(plain).toContain('formaction="/bills/7/reactivate"');
			expect(plain).not.toContain("reactivate?rename");
			await repeatActive();
			const refused = await (
				await post("/bills/7/reactivate", new URLSearchParams())
			).text();
			expect(refused).toContain('formaction="/bills/7/reactivate?rename=1"');
			expect(refused).toContain('hx-post="/bills/7/reactivate?rename=1"');
			// The sheet's Name field holds the bill's name, ready to be changed.
			expect(refused).toMatch(
				/<input[^>]*id="bill-name"[^>]*value="Old phone plan"/,
			);
		});

		it("renames and reactivates in one step when the new name is free", async () => {
			await repeatActive();
			const res = await post(
				"/bills/7/reactivate?rename=1",
				new URLSearchParams({ name: "  Old phone plan (2022) " }),
			);
			expect(res.headers.get("HX-Trigger")).toContain(
				'"announce":"Bill reactivated"',
			);
			expect(await statusOf(7)).toEqual({
				name: "Old phone plan (2022)",
				active: 1,
			});
		});

		it("redirects the same way without JavaScript", async () => {
			await repeatActive();
			const res = await post(
				"/bills/7/reactivate?rename=1",
				new URLSearchParams({ name: "Old phone plan (2022)" }),
				false,
			);
			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/bills");
			expect(await statusOf(7)).toEqual({
				name: "Old phone plan (2022)",
				active: 1,
			});
		});

		it("refuses again when the typed name is also taken, keeping what was typed", async () => {
			await repeatActive();
			const res = await post(
				"/bills/7/reactivate?rename=1",
				new URLSearchParams({ name: "WATER" }),
			);
			const html = await res.text();
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(html).toContain("You already have a bill called Water.");
			expect(html).toMatch(/<input[^>]*id="bill-name"[^>]*value="WATER"/);
			expect(html).toContain('formaction="/bills/7/reactivate?rename=1"');
			expect(await statusOf(7)).toEqual({ name: "Old phone plan", active: 0 });
		});

		it("asks for a name when the Name field was emptied", async () => {
			const res = await post(
				"/bills/7/reactivate?rename=1",
				new URLSearchParams({ name: "  " }),
			);
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(await res.text()).toContain("Enter a name.");
			expect(await statusOf(7)).toEqual({ name: "Old phone plan", active: 0 });
		});

		it("does not rename on a plain Reactivate", async () => {
			const res = await post(
				"/bills/7/reactivate",
				new URLSearchParams({ name: "Something else" }),
			);
			expect(res.headers.get("HX-Trigger")).toContain("Bill reactivated");
			expect(await statusOf(7)).toEqual({ name: "Old phone plan", active: 1 });
		});
	});

	describe("amounts over $100,000.00", () => {
		it("comes back with the alert line and an unticked chip, and saves nothing", async () => {
			const before = await billCount();
			const res = await post(
				"/bills",
				fields({ name: "Rent", amount: "150000.00" }),
			);
			const html = await res.text();
			expect(res.status).toBe(200);
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(await billCount()).toBe(before);
			expect(html).toMatch(
				/<p id="bill-amount-error" role="alert"[^>]*>\$150,000\.00 is a lot for a bill\.<\/p>/,
			);
			const chip = confirmChip(html);
			expect(chip).toContain('type="checkbox"');
			expect(chip).toContain('value="15000000"');
			expect(chip).toContain('aria-describedby="bill-amount-error"');
			expect(chip).not.toContain("checked");
			expect(html).toContain("Yes, $150,000.00 is right");
			// The form keeps what was typed.
			expect(html).toContain('value="150000.00"');
		});

		it("does not ask at exactly $100,000.00, and asks one cent over", async () => {
			const exact = await post(
				"/bills",
				fields({ name: "Land", amount: "100,000.00" }),
			);
			expect(exact.headers.get("HX-Trigger")).toContain("Bill added");
			expect(
				await env.DB.prepare(
					"SELECT amount_cents FROM bills WHERE name='Land'",
				).first("amount_cents"),
			).toBe(10_000_000);
			const over = await post(
				"/bills",
				fields({ name: "Land 2", amount: "100000.01" }),
			);
			expect(over.headers.get("HX-Trigger")).toBeNull();
			expect(await over.text()).toContain("$100,000.01 is a lot for a bill.");
			expect(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM bills WHERE name='Land 2'",
				).first("n"),
			).toBe(0);
		});

		it("saves once the chip for that amount is ticked", async () => {
			const res = await post(
				"/bills",
				fields({
					name: "Rent",
					amount: "150000.00",
					confirm_amount: "15000000",
				}),
			);
			expect(res.headers.get("HX-Trigger")).toContain(
				'"announce":"Bill added"',
			);
			expect(
				await env.DB.prepare(
					"SELECT amount_cents FROM bills WHERE name='Rent'",
				).first("amount_cents"),
			).toBe(15_000_000);
		});

		it("asks again when the amount changed after confirming", async () => {
			const before = await billCount();
			const res = await post(
				"/bills",
				fields({
					name: "Rent",
					amount: "200000.00",
					confirm_amount: "15000000",
				}),
			);
			const html = await res.text();
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(await billCount()).toBe(before);
			expect(html).toContain("$200,000.00 is a lot for a bill.");
			expect(html).toContain("Yes, $200,000.00 is right");
			const chip = confirmChip(html);
			expect(chip).toContain('value="20000000"');
			expect(chip).not.toContain("checked");
		});

		it("does not take any other value as a confirmation", async () => {
			for (const confirm_amount of ["on", "1", "150000.00", ""]) {
				const res = await post(
					"/bills",
					fields({ name: "Rent", amount: "150000.00", confirm_amount }),
				);
				expect(res.headers.get("HX-Trigger")).toBeNull();
			}
			expect(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM bills WHERE name='Rent'",
				).first("n"),
			).toBe(0);
		});

		it("works without JavaScript: the form again, then a redirect once ticked", async () => {
			const asked = await post(
				"/bills",
				fields({ name: "Rent", amount: "150000" }),
				false,
			);
			expect(asked.status).toBe(200);
			const html = await asked.text();
			expect(html).toContain("<form");
			expect(html).toContain("Yes, $150,000.00 is right");
			const saved = await post(
				"/bills",
				fields({ name: "Rent", amount: "150000", confirm_amount: "15000000" }),
				false,
			);
			expect(saved.status).toBe(303);
			expect(saved.headers.get("location")).toBe("/bills");
		});

		it("asks when an edit makes the amount that big, and saves once confirmed", async () => {
			const edit = {
				name: "Streaming",
				amount: "150000.00",
				merchant_raw_name: "APPLE.COM/BILL",
			};
			const asked = await post("/bills/1", fields(edit));
			const html = await asked.text();
			expect(asked.headers.get("HX-Trigger")).toBeNull();
			expect(html).toContain("$150,000.00 is a lot for a bill.");
			expect(confirmChip(html)).toContain('value="15000000"');
			expect(await amountOf(1)).toBe(299);
			const saved = await post(
				"/bills/1",
				fields({ ...edit, confirm_amount: "15000000" }),
			);
			expect(saved.headers.get("HX-Trigger")).toContain(
				'"announce":"Bill saved"',
			);
			expect(await amountOf(1)).toBe(15_000_000);
		});

		it("asks on every save of a bill over $100,000.00, even with the amount unchanged", async () => {
			await env.DB.prepare(
				"UPDATE bills SET amount_cents=20000000 WHERE id=1",
			).run();
			const edit = {
				name: "Streaming plus",
				amount: "200000.00",
				merchant_raw_name: "APPLE.COM/BILL",
			};
			const asked = await post("/bills/1", fields(edit));
			expect(asked.headers.get("HX-Trigger")).toBeNull();
			expect(await asked.text()).toContain("Yes, $200,000.00 is right");
			expect(await nameOf(1)).toBe("Streaming");
			const saved = await post(
				"/bills/1",
				fields({ ...edit, confirm_amount: "20000000" }),
			);
			expect(saved.headers.get("HX-Trigger")).toContain("Bill saved");
			expect(await nameOf(1)).toBe("Streaming plus");
		});

		it("keeps a ticked chip, without the alert, when another field needs fixing", async () => {
			const before = await billCount();
			const res = await post(
				"/bills",
				fields({
					name: "water",
					amount: "150000.00",
					confirm_amount: "15000000",
				}),
			);
			const html = await res.text();
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(await billCount()).toBe(before);
			expect(html).toContain("You already have a bill called Water.");
			expect(html).not.toContain("is a lot for a bill");
			expect(html).not.toContain('id="bill-amount-error"');
			const chip = confirmChip(html);
			expect(chip).toContain('value="15000000"');
			expect(chip).toContain("checked");
			expect(chip).not.toContain("aria-describedby");
		});

		it("shows both problems at once", async () => {
			const html = await (
				await post("/bills", fields({ name: "water", amount: "150000.00" }))
			).text();
			expect(html).toContain("You already have a bill called Water.");
			expect(html).toContain("$150,000.00 is a lot for a bill.");
			expect(html.match(/role="alert"/g)?.length).toBe(2);
		});

		it("has no chip on an ordinary form or a normal amount", async () => {
			const html = await (
				await exports.default.fetch("http://tally.test/bills/new")
			).text();
			expect(confirmChip(html)).toBeUndefined();
			const bad = await (
				await post("/bills", fields({ name: "Gym", due_day: "40" }))
			).text();
			expect(confirmChip(bad)).toBeUndefined();
		});
	});
});

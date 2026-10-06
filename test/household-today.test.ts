import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchBillPayments } from "../src/bills/match";
import { DEFAULT_TIME_ZONE, householdToday, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { runScheduled } from "../src/index";
import { loadBillRows } from "../src/routes/bills";

// "Today" is the household's date, so the month and bill status change at midnight Eastern, not UTC.
// Only Date is faked: the Workers runtime and D1 keep their real timers.
const at = (instant: string) => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(instant));
};

const setZone = (value: string) =>
	env.DB.prepare(
		"INSERT INTO household_settings (key, value) VALUES ('time_zone', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	)
		.bind(value)
		.run();

const get = async (path: string) => {
	const res = await exports.default.fetch(`http://tally.test${path}`);
	return { res, html: await res.text() };
};

beforeEach(async () => {
	await setZone(DEFAULT_TIME_ZONE);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the month at the household's midnight", () => {
	// 03:30 UTC on Nov 1 is 23:30 Eastern on Oct 31.
	const LATE_OCTOBER = "2026-11-01T03:30:00Z";

	it("Home is still October at 23:30 Eastern on Oct 31", async () => {
		at(LATE_OCTOBER);
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		const { res, html } = await get("/");
		expect(res.status).toBe(200);
		expect(html).toContain("October");
		expect(html).not.toContain("November");
	});

	it("Home turns to November once it is November in Eastern", async () => {
		at("2026-11-01T05:30:00Z");
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		const { html } = await get("/");
		expect(html).toContain("November");
		expect(html).not.toContain("October");
	});

	it("Home follows the stored time zone", async () => {
		await setZone("Asia/Tokyo");
		at(LATE_OCTOBER);
		await resetDemo(env.DB, todayIn("Asia/Tokyo"));
		// resetDemo puts the demo's zone back, so choose Tokyo again for the page under test.
		await setZone("Asia/Tokyo");
		const { html } = await get("/");
		expect(html).toContain("November");
	});

	it("falls back to Eastern when the stored zone is not a real one", async () => {
		await setZone("Not/AZone");
		at(LATE_OCTOBER);
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await setZone("Not/AZone");
		const { res, html } = await get("/");
		expect(res.status).toBe(200);
		expect(html).toContain("October");
	});

	it("falls back to Eastern when the setting is missing", async () => {
		at(LATE_OCTOBER);
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await env.DB.prepare("DELETE FROM household_settings").run();
		const { html } = await get("/");
		expect(html).toContain("October");
	});

	it("Transactions opens on the household's month", async () => {
		at(LATE_OCTOBER);
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await env.DB.prepare(
			"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name) VALUES (9001, 1, '2026-10-31', 1250, 'CORNER CAFE')",
		).run();
		const { html } = await get("/transactions");
		expect(html).toContain("October");
		expect(html).toContain("Today, Oct 31");
	});

	it("How Tally works names the household's month", async () => {
		at(LATE_OCTOBER);
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		const { html } = await get("/how-it-works");
		expect(html).toContain("October");
		expect(html).not.toContain("November");
	});
});

describe("a bill due Oct 5 at 22:00 Eastern on Oct 5", () => {
	// 02:00 UTC on Oct 6 is 22:00 Eastern on Oct 5.
	const EVENING = "2026-10-06T02:00:00Z";

	beforeEach(async () => {
		at(EVENING);
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM bills"),
			env.DB.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (1, 'Rent', 150000, 5, 'monthly', 'LANDLORD LLC')",
			),
		]);
	});

	it("is due, not overdue", async () => {
		const { today, rows } = await loadBillRows(
			env.DB,
			await householdToday(env.DB),
		);
		expect(today).toBe("2026-10-05");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ status: "due", dueDate: "2026-10-05" });
	});

	it("reads Due today on Bills", async () => {
		const { html } = await get("/bills");
		expect(html).toContain("Due today, Oct 5");
		expect(html).not.toContain("Was due");
		expect(html).not.toContain("Overdue");
	});

	it("is overdue once Eastern reaches Oct 6", async () => {
		at("2026-10-06T04:00:00Z");
		const { rows } = await loadBillRows(env.DB, await householdToday(env.DB));
		expect(rows[0]).toMatchObject({ status: "overdue" });
	});

	it("is due on the bill's own page, too", async () => {
		const { res, html } = await get("/bills/1");
		expect(res.status).toBe(200);
		expect(html).not.toContain("Overdue");
		expect(html).toContain("Due");
	});
});

describe("jobs that decide today", () => {
	beforeEach(async () => {
		await resetDemo(env.DB, "2026-09-22");
	});

	it("matches bills against the household's date, not UTC's", async () => {
		// A payment dated Nov 8 is within a week of Nov 1 (UTC) but not of Oct 31 (Eastern).
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM bills"),
			env.DB.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (1, 'Phone', 5000, 8, 'monthly', 'PHONE CO')",
			),
			env.DB.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name) VALUES (9001, 1, '2026-11-08', 5000, 'PHONE CO')",
			),
		]);
		at("2026-11-01T03:30:00Z");
		await matchBillPayments(env.DB);
		const early = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM bill_payments WHERE bill_id = 1 AND period = '2026-11'",
		).first<{ n: number }>();
		expect(early?.n).toBe(0);

		at("2026-11-01T05:30:00Z");
		await matchBillPayments(env.DB);
		const later = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM bill_payments WHERE bill_id = 1 AND period = '2026-11'",
		).first<{ n: number }>();
		expect(later?.n).toBe(1);
	});

	it("the nightly demo reset seeds the household's date", async () => {
		at("2026-11-01T03:30:00Z");
		await runScheduled({ ...env, DEMO: "true" });
		const count = (where: string) =>
			env.DB.prepare(
				`SELECT COUNT(*) AS n FROM transactions WHERE ${where}`,
			).first<{ n: number }>();
		// Nothing is dated November: at 23:30 Eastern on Oct 31 it is still October.
		expect(
			(await count("date >= '2026-11-01' AND date < '2026-11-02'"))?.n,
		).toBe(0);
		expect((await count("date LIKE '2026-10-%'"))?.n).toBeGreaterThan(0);
	});

	it("the demo reset puts the time zone back to Eastern", async () => {
		await setZone("Asia/Tokyo");
		await resetDemo(env.DB, "2026-09-22");
		const row = await env.DB.prepare(
			"SELECT value FROM household_settings WHERE key = 'time_zone'",
		).first<{ value: string }>();
		expect(row?.value).toBe(DEFAULT_TIME_ZONE);
	});
});

describe("one date for the whole request", () => {
	const LATE_OCTOBER = "2026-11-01T03:30:00Z";
	const AFTER_MIDNIGHT = "2026-11-01T05:30:00Z";

	// Counts reads of the setting, and moves the clock past Eastern midnight right after the first,
	// so a request that read it a second time would mix October with November.
	function watchSetting() {
		let reads = 0;
		const prepare = env.DB.prepare.bind(env.DB);
		vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
			if (sql.includes("household_settings") && sql.includes("SELECT value")) {
				reads += 1;
				vi.setSystemTime(new Date(AFTER_MIDNIGHT));
			}
			return prepare(sql);
		});
		return () => reads;
	}

	const form = (fields: Record<string, string>): RequestInit => ({
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: "http://tally.test",
			"HX-Request": "true",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(fields).toString(),
	});

	beforeEach(async () => {
		at(LATE_OCTOBER);
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		["Home", "/", undefined],
		["a budget sheet", "/budget/1", undefined],
		["Transactions", "/transactions", undefined],
		["an edit panel", "/transactions/1", undefined],
		["a split sheet", "/transactions/1/split", undefined],
		["the cash sheet", "/transactions/cash/new", undefined],
		["Bills", "/bills", undefined],
		["a bill's page", "/bills/1", undefined],
		["a bill's payment picker", "/bills/1/occurrences/2026-10/link", undefined],
		["Possible bills", "/bills/find", undefined],
		["How Tally works", "/how-it-works", undefined],
		["Settings", "/settings", undefined],
		["the CSV download", "/settings/export/transactions.csv", undefined],
		["saving a budget", "/budget/1", form({ budget: "300" })],
		["nudging a budget", "/budget/1/nudge/up", form({})],
		[
			"adding cash",
			"/transactions/cash",
			form({
				date: "2026-10-31",
				amount: "5.00",
				merchant: "Cafe",
				category: "1",
			}),
		],
		[
			"cash with a mistake",
			"/transactions/cash",
			form({ date: "2026-10-31", amount: "", merchant: "", category: "1" }),
		],
		[
			"saving a bill",
			"/bills/1",
			form({
				name: "Movies",
				amount: "3.99",
				due_day: "4",
				frequency: "monthly",
				anchor_month: "1",
				category_id: "5",
				merchant_raw_name: "APPLE.COM/BILL",
			}),
		],
		["moving a category", "/settings/categories/3/move/up", form({})],
		[
			"a time zone that isn't offered",
			"/settings/time-zone",
			form({ time_zone: "Not/AZone" }),
		],
	])("reads the date once for %s", async (_name, path, init) => {
		const reads = watchSetting();
		const res = await exports.default.fetch(`http://tally.test${path}`, init);
		await res.text();
		expect(res.status).toBeLessThan(500);
		expect(reads()).toBe(1);
	});

	it("reads no saved zone when saving the time zone: the new one comes from the form", async () => {
		const reads = watchSetting();
		const res = await exports.default.fetch(
			"http://tally.test/settings/time-zone",
			form({ time_zone: "America/Chicago" }),
		);
		await res.text();
		expect(res.status).toBeLessThan(500);
		expect(reads()).toBe(0);
	});

	it("keeps the budget month the same all through a save", async () => {
		const reads = watchSetting();
		const res = await exports.default.fetch(
			"http://tally.test/budget/1",
			form({ budget: "300" }),
		);
		const html = await res.text();
		expect(reads()).toBe(1);
		// Saved from October on, and Home answers for October.
		const saved = await env.DB.prepare(
			"SELECT MAX(effective_month) AS month FROM budget_amounts WHERE category_id = 1 AND amount_cents = 30000",
		).first<{ month: string }>();
		expect(saved?.month).toBe("2026-10");
		expect(html).toContain("October");
		expect(html).not.toContain("November");
	});

	it("shows one month in a budget sheet", async () => {
		watchSetting();
		const html = await (
			await exports.default.fetch("http://tally.test/budget/1")
		).text();
		expect(html).toContain("spent so far in October");
		expect(html).toContain("Budget from October on");
		expect(html).not.toContain("November");
	});

	it("shows one date in the edit panel and its list", async () => {
		await env.DB.prepare(
			"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name) VALUES (9001, 1, '2026-10-31', 1250, 'CORNER CAFE')",
		).run();
		watchSetting();
		const html = await (
			await exports.default.fetch("http://tally.test/transactions/9001")
		).text();
		// The panel and the list behind it both call Oct 31 today.
		expect(html.match(/Today, Oct 31/g)?.length).toBeGreaterThanOrEqual(2);
	});
});

describe("a time zone other than Eastern", () => {
	// 05:30 UTC on Nov 1 is 22:30 Pacific on Oct 31, and already 01:30 Eastern on Nov 1.
	const PACIFIC_EVENING = "2026-11-01T05:30:00Z";
	// 10:00 UTC on Nov 1 is 02:00 Pacific on Nov 1, after daylight time ended.
	const PACIFIC_NEXT_DAY = "2026-11-01T10:00:00Z";
	const LOS_ANGELES = "America/Los_Angeles";

	beforeEach(async () => {
		at(PACIFIC_EVENING);
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await setZone(LOS_ANGELES);
	});

	it("Home's month follows Pacific time, while Eastern is already in November", async () => {
		const pacific = await get("/");
		expect(pacific.html).toContain("October");
		expect(pacific.html).not.toContain("November");

		await setZone(DEFAULT_TIME_ZONE);
		const eastern = await get("/");
		expect(eastern.html).toContain("November");
	});

	it("Transactions and How Tally works open on Pacific's month", async () => {
		const transactions = await get("/transactions");
		expect(transactions.html).toContain("October");
		const how = await get("/how-it-works");
		expect(how.html).toContain("October");
		expect(how.html).not.toContain("November");
	});

	describe("with a bill due on the 31st", () => {
		beforeEach(async () => {
			await env.DB.batch([
				env.DB.prepare("DELETE FROM bill_payments"),
				env.DB.prepare("DELETE FROM bills"),
				env.DB.prepare(
					"INSERT INTO bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (1, 'Mortgage', 200000, 31, 'monthly', 'BANK MORTGAGE')",
				),
			]);
		});

		it("is due today in Pacific, but overdue in Eastern", async () => {
			const pacific = await loadBillRows(env.DB, await householdToday(env.DB));
			expect(pacific.today).toBe("2026-10-31");
			expect(pacific.rows[0]).toMatchObject({ status: "due" });
			const page = await get("/bills");
			expect(page.html).toContain("Due today, Oct 31");
			expect(page.html).not.toContain("Overdue");
			const bill = await get("/bills/1");
			expect(bill.html).not.toContain("Overdue");

			await setZone(DEFAULT_TIME_ZONE);
			const eastern = await loadBillRows(env.DB, await householdToday(env.DB));
			expect(eastern.rows[0]).toMatchObject({ status: "overdue" });
		});
	});

	it("matches a bill's payment only once Pacific is within a week of it", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM bills"),
			env.DB.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (1, 'Phone', 5000, 8, 'monthly', 'PHONE CO')",
			),
			env.DB.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name) VALUES (9001, 1, '2026-11-08', 5000, 'PHONE CO')",
			),
		]);
		const links = async () =>
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM bill_payments WHERE bill_id = 1 AND period = '2026-11'",
				).first<{ n: number }>()
			)?.n;
		// Pacific is on Oct 31: Nov 8 is eight days off, so it waits (Eastern, on Nov 1, would match it).
		await matchBillPayments(env.DB);
		expect(await links()).toBe(0);

		at(PACIFIC_NEXT_DAY);
		await matchBillPayments(env.DB);
		expect(await links()).toBe(1);
	});

	it("the cash form defaults to Pacific's date and won't take a later one", async () => {
		const sheet = await get("/transactions/cash/new");
		expect(sheet.html).toContain('max="2026-10-31"');
		expect(sheet.html).toContain('value="2026-10-31"');
		expect(sheet.html).not.toContain("2026-11-01");
	});

	it("cash dated Eastern's tomorrow is refused, and Pacific's today is saved", async () => {
		const post = (date: string) =>
			exports.default.fetch("http://tally.test/transactions/cash", {
				method: "POST",
				headers: {
					Origin: "http://tally.test",
					"HX-Request": "true",
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					date,
					amount: "5.00",
					merchant: "Corner cafe",
					category: "1",
				}),
			});
		const early = await post("2026-11-01");
		expect(early.status).toBe(422);
		expect(await early.text()).toContain("Choose today or an earlier date.");
		const saved = await post("2026-10-31");
		expect(saved.status).toBe(200);
		const row = await env.DB.prepare(
			"SELECT date FROM transactions WHERE raw_name = 'Corner cafe'",
		).first<{ date: string }>();
		expect(row?.date).toBe("2026-10-31");
	});
});

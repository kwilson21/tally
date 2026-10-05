import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchBillPayments } from "../src/bills/match";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
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
		const { today, rows } = await loadBillRows(env.DB);
		expect(today).toBe("2026-10-05");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ status: "due", dueDate: "2026-10-05" });
	});

	it("reads Due today on Bills", async () => {
		const { html } = await get("/bills");
		expect(html).toContain("Due Today, Oct 5");
		expect(html).not.toContain("Was due");
		expect(html).not.toContain("Overdue");
	});

	it("is overdue once Eastern reaches Oct 6", async () => {
		at("2026-10-06T04:00:00Z");
		const { rows } = await loadBillRows(env.DB);
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
		expect((await count("date >= '2026-11-01'"))?.n).toBe(0);
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

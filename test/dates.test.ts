import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_TIME_ZONE,
	daysBefore,
	householdToday,
	monthName,
	shortDay,
	todayIn,
} from "../src/dates";

describe("monthName", () => {
	it.each([
		["2026-09", "September"],
		["2027-01", "January"],
		["2026-12", "December"],
	])("%s is %s", (month, name) => expect(monthName(month)).toBe(name));
});

describe("todayIn", () => {
	it("is a YYYY-MM-DD string", () => {
		expect(todayIn("America/New_York")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it.each([
		// 23:30 Eastern (daylight time) on Oct 31 is already Nov 1 in UTC.
		["America/New_York", "2026-11-01T03:30:00Z", "2026-10-31"],
		["UTC", "2026-11-01T03:30:00Z", "2026-11-01"],
		// Daylight time ends Nov 1 at 2:00; after that Eastern is UTC-5.
		["America/New_York", "2026-11-02T04:59:00Z", "2026-11-01"],
		["America/New_York", "2026-11-02T05:00:00Z", "2026-11-02"],
		["Asia/Tokyo", "2026-10-31T15:00:00Z", "2026-11-01"],
		["America/Los_Angeles", "2027-01-01T07:59:00Z", "2026-12-31"],
		["America/New_York", "2028-02-29T04:59:00Z", "2028-02-28"],
	])("%s at %s is %s", (zone, instant, date) =>
		expect(todayIn(zone, new Date(instant))).toBe(date),
	);

	it("falls back to Eastern for a zone that doesn't exist", () => {
		const now = new Date("2026-11-01T03:30:00Z");
		expect(todayIn("Not/AZone", now)).toBe("2026-10-31");
		expect(todayIn("", now)).toBe("2026-10-31");
	});
});

describe("householdToday", () => {
	const NOW = new Date("2026-11-01T03:30:00Z");
	const setZone = (value: string) =>
		env.DB.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('time_zone', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
			.bind(value)
			.run();

	afterEach(() => setZone(DEFAULT_TIME_ZONE));

	it("starts as Eastern", async () => {
		const row = await env.DB.prepare(
			"SELECT value FROM household_settings WHERE key = 'time_zone'",
		).first<{ value: string }>();
		expect(row?.value).toBe("America/New_York");
		expect(await householdToday(env.DB, NOW)).toBe("2026-10-31");
	});

	it("uses the stored time zone", async () => {
		await setZone("Asia/Tokyo");
		expect(await householdToday(env.DB, NOW)).toBe("2026-11-01");
		await setZone("America/Los_Angeles");
		expect(await householdToday(env.DB, NOW)).toBe("2026-10-31");
	});

	it("falls back to Eastern when the row is missing", async () => {
		await env.DB.prepare(
			"DELETE FROM household_settings WHERE key = 'time_zone'",
		).run();
		expect(await householdToday(env.DB, NOW)).toBe("2026-10-31");
	});

	it("falls back to Eastern when the stored zone is invalid", async () => {
		await setZone("Not/AZone");
		expect(await householdToday(env.DB, NOW)).toBe("2026-10-31");
	});

	it("falls back to Eastern when the table is unavailable", async () => {
		const broken = {
			prepare: () => ({
				first: async () => {
					throw new Error("D1_ERROR: no such table: household_settings");
				},
			}),
		} as unknown as D1Database;
		expect(await householdToday(broken, NOW)).toBe("2026-10-31");
	});

	it("reads the real clock when no time is given", async () => {
		expect(await householdToday(env.DB)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

describe("shortDay", () => {
	it.each([
		["2026-09-05", "2026-09-26", "Sep 5"],
		["2026-09-26", "2026-09-26", "Sep 26"],
		["2025-12-31", "2026-01-04", "Dec 31, 2025"],
	])("%s beside %s is %s", (date, beside, label) =>
		expect(shortDay(date, beside)).toBe(label),
	);
});

describe("daysBefore", () => {
	it.each([
		["2026-10-04", 5, "2026-09-29"],
		["2026-10-04", 30, "2026-09-04"],
		["2026-03-01", 1, "2026-02-28"],
		["2028-03-01", 1, "2028-02-29"],
		["2026-01-03", 5, "2025-12-29"],
	])("%s minus %i days is %s", (date, days, result) =>
		expect(daysBefore(date, days)).toBe(result),
	);
});

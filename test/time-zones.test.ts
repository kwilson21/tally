import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_TIME_ZONE,
	householdTimeZone,
	householdToday,
	todayIn,
} from "../src/dates";
import { saveTimeZone } from "../src/db/time-zone";
import {
	isSupportedZone,
	OTHER_ZONES,
	parseTimeZone,
	TIME_ZONE_ERROR,
	US_ZONES,
	zoneLabel,
} from "../src/settings/time-zones";

// The zones Settings offers (spec §8.5, decision 72, P35 A): the six US ones by their everyday
// names, then the other zones the drawing lists. Only these are saved.

const stored = () =>
	env.DB.prepare(
		"SELECT value FROM household_settings WHERE key = 'time_zone'",
	).first<{ value: string }>();

afterEach(() => saveTimeZone(env.DB, DEFAULT_TIME_ZONE));

describe("the zones Settings offers", () => {
	it("are the six US zones by their everyday names, Eastern first", () => {
		expect(US_ZONES).toEqual([
			["America/New_York", "Eastern"],
			["America/Chicago", "Central"],
			["America/Denver", "Mountain"],
			["America/Los_Angeles", "Pacific"],
			["America/Anchorage", "Alaska"],
			["Pacific/Honolulu", "Hawaii"],
		]);
	});

	it("then the other zones the drawing lists", () => {
		expect(OTHER_ZONES).toEqual([
			["America/Phoenix", "Phoenix"],
			["America/Puerto_Rico", "Puerto Rico"],
			["America/Toronto", "Toronto"],
			["Europe/London", "London"],
		]);
	});

	it("are all zones the runtime knows, with no repeats and no repeated names", () => {
		const all = [...US_ZONES, ...OTHER_ZONES];
		expect(new Set(all.map(([zone]) => zone)).size).toBe(all.length);
		expect(new Set(all.map(([, label]) => label)).size).toBe(all.length);
		for (const [zone] of all)
			expect(
				() => new Intl.DateTimeFormat("en-CA", { timeZone: zone }),
			).not.toThrow();
	});

	it("start as the default zone", () => {
		expect(US_ZONES[0]?.[0]).toBe(DEFAULT_TIME_ZONE);
	});
});

describe("zoneLabel", () => {
	it.each([
		["America/New_York", "Eastern"],
		["America/Chicago", "Central"],
		["Pacific/Honolulu", "Hawaii"],
		["America/Puerto_Rico", "Puerto Rico"],
		["Europe/London", "London"],
	])("%s is %s", (zone, label) => expect(zoneLabel(zone)).toBe(label));

	it("names a zone that isn't on the list by its city, never by its code", () => {
		expect(zoneLabel("Asia/Tokyo")).toBe("Tokyo");
		expect(zoneLabel("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
	});
});

describe("isSupportedZone", () => {
	it("accepts each listed zone", () => {
		for (const [zone] of [...US_ZONES, ...OTHER_ZONES])
			expect(isSupportedZone(zone)).toBe(true);
	});

	it.each([
		"",
		"Eastern",
		"america/new_york",
		"Not/AZone",
		"Asia/Tokyo",
		"UTC",
		" America/New_York",
		"America/New_York\n",
		"__proto__",
		"constructor",
	])("refuses %j", (zone) => expect(isSupportedZone(zone)).toBe(false));
});

describe("parseTimeZone", () => {
	const form = (fields: Record<string, string>) => {
		const data = new FormData();
		for (const [key, value] of Object.entries(fields)) data.set(key, value);
		return data;
	};

	it("takes a listed zone", () => {
		expect(parseTimeZone(form({ time_zone: "America/Chicago" }))).toEqual({
			ok: true,
			zone: "America/Chicago",
		});
	});

	it("refuses an unknown zone with a sentence for the field", () => {
		expect(parseTimeZone(form({ time_zone: "Not/AZone" }))).toEqual({
			ok: false,
			error: TIME_ZONE_ERROR,
		});
		expect(TIME_ZONE_ERROR).toBe("Choose a time zone from the list.");
	});

	it("refuses a missing field", () => {
		expect(parseTimeZone(form({}))).toEqual({
			ok: false,
			error: TIME_ZONE_ERROR,
		});
	});
});

describe("saveTimeZone and householdTimeZone", () => {
	it("save the zone in the one household_settings row, and read it back", async () => {
		expect(await householdTimeZone(env.DB)).toBe(DEFAULT_TIME_ZONE);
		await saveTimeZone(env.DB, "America/Chicago");
		expect(await stored()).toEqual({ value: "America/Chicago" });
		expect(await householdTimeZone(env.DB)).toBe("America/Chicago");
		await saveTimeZone(env.DB, "Pacific/Honolulu");
		expect(await householdTimeZone(env.DB)).toBe("Pacific/Honolulu");
		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM household_settings WHERE key = 'time_zone'",
		).first<{ n: number }>();
		expect(rows?.n).toBe(1);
	});

	it("change nothing else in household_settings", async () => {
		await env.DB.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('ai_income', 'off') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		).run();
		await saveTimeZone(env.DB, "America/Denver");
		const other = await env.DB.prepare(
			"SELECT key, value FROM household_settings WHERE key = 'ai_income'",
		).first();
		expect(other).toEqual({ key: "ai_income", value: "off" });
		await env.DB.prepare(
			"DELETE FROM household_settings WHERE key = 'ai_income'",
		).run();
	});

	it("feed householdToday, so today follows the saved zone", async () => {
		const now = new Date("2026-11-01T03:30:00Z");
		await saveTimeZone(env.DB, "Europe/London");
		expect(await householdToday(env.DB, now)).toBe(
			todayIn("Europe/London", now),
		);
		expect(await householdToday(env.DB, now)).toBe("2026-11-01");
		await saveTimeZone(env.DB, "America/New_York");
		expect(await householdToday(env.DB, now)).toBe("2026-10-31");
	});

	it("read an unknown stored zone as the zone today follows: Eastern", async () => {
		await env.DB.prepare(
			"UPDATE household_settings SET value = 'Not/AZone' WHERE key = 'time_zone'",
		).run();
		expect(await householdTimeZone(env.DB)).toBe(DEFAULT_TIME_ZONE);
	});
});

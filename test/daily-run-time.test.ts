import { describe, expect, it } from "vitest";
import { DAILY_RUN_UTC_HOUR, dailyRunTime } from "../src/first-tally/setup";

// The daily run's time in the household's zone, as the reading screen says it (decision 150, spec §8.8): the next 09:00 UTC
// run, in words such as "5 AM" or "2:30 PM".
const at = (iso: string) => Date.parse(iso);
/** The narrow no-break space (U+202F) that newer ICU puts before AM and PM. */
const NARROW_NO_BREAK_SPACE = String.fromCharCode(0x202f);

describe("dailyRunTime", () => {
	it("exports the run's UTC hour, the wrangler cron's 09:00", () => {
		expect(DAILY_RUN_UTC_HOUR).toBe(9);
	});

	it("reads Eastern in daylight time as 5 AM", () => {
		expect(dailyRunTime("America/New_York", at("2026-10-25T12:00:00Z"))).toBe(
			"5 AM",
		);
	});

	it("reads Eastern in standard time as 4 AM after the clocks go back", () => {
		expect(dailyRunTime("America/New_York", at("2026-11-02T12:00:00Z"))).toBe(
			"4 AM",
		);
	});

	it("keeps today's run while it is still ahead, before 09:00 UTC", () => {
		expect(dailyRunTime("America/New_York", at("2026-10-25T08:59:00Z"))).toBe(
			"5 AM",
		);
	});

	it("moves to tomorrow's run at 09:00 UTC exactly, so the zone's clock can change between", () => {
		// London's clocks go forward at 01:00 UTC on 2026-03-29. Just before 09:00 UTC on the 28th the next run is that day's,
		// at 9 AM (GMT); at 09:00 UTC exactly today's run has started, so the next is the 29th's, at 10 AM (BST).
		expect(dailyRunTime("Europe/London", at("2026-03-28T08:59:59.999Z"))).toBe(
			"9 AM",
		);
		expect(dailyRunTime("Europe/London", at("2026-03-28T09:00:00Z"))).toBe(
			"10 AM",
		);
	});

	it("reads London in summer as 10 AM", () => {
		expect(dailyRunTime("Europe/London", at("2026-07-01T12:00:00Z"))).toBe(
			"10 AM",
		);
	});

	it("reads London in winter as 9 AM", () => {
		expect(dailyRunTime("Europe/London", at("2026-12-01T12:00:00Z"))).toBe(
			"9 AM",
		);
	});

	it("reads a half-hour zone with its minutes, as 2:30 PM", () => {
		expect(dailyRunTime("Asia/Kolkata", at("2026-10-25T12:00:00Z"))).toBe(
			"2:30 PM",
		);
	});

	it("reads UTC as 9 AM", () => {
		expect(dailyRunTime("UTC", at("2026-10-25T12:00:00Z"))).toBe("9 AM");
	});

	it("never uses the narrow no-break space before AM and PM, only a plain space", () => {
		const zones = ["America/New_York", "Europe/London", "Asia/Kolkata", "UTC"];
		for (const zone of zones) {
			const words = dailyRunTime(zone, at("2026-10-25T12:00:00Z"));
			expect(words).not.toContain(NARROW_NO_BREAK_SPACE);
			expect(words).toMatch(/^\d{1,2}(:\d{2})? (AM|PM)$/);
		}
	});
});

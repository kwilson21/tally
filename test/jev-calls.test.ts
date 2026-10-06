import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { claimJevCall, jevCallsLeft } from "../src/db/jev-calls";

// The day's Jev count (spec §8.6): one number per household date that every run, at a sync or
// overnight, counts against, so a day never goes over the cap.

const db = env.DB;
const rows = async () =>
	(
		await db
			.prepare(
				"SELECT key, value FROM household_settings WHERE key GLOB 'jev_calls_*' ORDER BY key",
			)
			.all<{ key: string; value: string }>()
	).results;

beforeEach(async () => {
	await db
		.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'")
		.run();
});

describe("Jev's calls for the day", () => {
	it("starts a day with the whole cap left and no row", async () => {
		expect(await jevCallsLeft(db, "2026-10-06", 40)).toBe(40);
		expect(await rows()).toEqual([]);
	});

	it("counts each call it lets through", async () => {
		expect(await claimJevCall(db, "2026-10-06", 40)).toBe(true);
		expect(await claimJevCall(db, "2026-10-06", 40)).toBe(true);
		expect(await jevCallsLeft(db, "2026-10-06", 40)).toBe(38);
		expect(await rows()).toEqual([{ key: "jev_calls_2026-10-06", value: "2" }]);
	});

	it("refuses a call once the cap is used, and counts nothing more", async () => {
		for (let i = 0; i < 3; i++)
			expect(await claimJevCall(db, "2026-10-06", 3)).toBe(true);
		expect(await claimJevCall(db, "2026-10-06", 3)).toBe(false);
		expect(await jevCallsLeft(db, "2026-10-06", 3)).toBe(0);
		expect(await rows()).toEqual([{ key: "jev_calls_2026-10-06", value: "3" }]);
	});

	it("never gives out more than the cap to calls made at the same moment", async () => {
		const claims = await Promise.all(
			Array.from({ length: 12 }, () => claimJevCall(db, "2026-10-06", 5)),
		);
		expect(claims.filter(Boolean)).toHaveLength(5);
		expect(await jevCallsLeft(db, "2026-10-06", 5)).toBe(0);
	});

	it("gives nothing when the cap is zero", async () => {
		expect(await claimJevCall(db, "2026-10-06", 0)).toBe(false);
		expect(await rows()).toEqual([]);
	});

	it("a call counts against the cap it's asked under, so a bigger cap leaves room", async () => {
		for (let i = 0; i < 3; i++) await claimJevCall(db, "2026-10-06", 3);
		expect(await claimJevCall(db, "2026-10-06", 3)).toBe(false);
		expect(await jevCallsLeft(db, "2026-10-06", 500)).toBe(497);
		expect(await claimJevCall(db, "2026-10-06", 500)).toBe(true);
	});

	it("starts each household day at zero and drops the days before it", async () => {
		for (let i = 0; i < 3; i++) await claimJevCall(db, "2026-10-05", 3);
		expect(await jevCallsLeft(db, "2026-10-05", 3)).toBe(0);

		expect(await jevCallsLeft(db, "2026-10-06", 3)).toBe(3);
		expect(await claimJevCall(db, "2026-10-06", 3)).toBe(true);
		// Yesterday's count is gone; today's is the only row kept.
		expect(await rows()).toEqual([{ key: "jev_calls_2026-10-06", value: "1" }]);
	});

	it("leaves the household's other settings alone", async () => {
		await claimJevCall(db, "2026-10-06", 3);
		await jevCallsLeft(db, "2026-10-07", 3);
		const others = await db
			.prepare(
				"SELECT key FROM household_settings WHERE key NOT GLOB 'jev_calls_*' ORDER BY key",
			)
			.all<{ key: string }>();
		expect(others.results.map((r) => r.key)).toContain("time_zone");
	});
});

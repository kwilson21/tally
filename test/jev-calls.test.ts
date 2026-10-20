import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { saveAiSwitches } from "../src/db/ai-switches";
import {
	giveBackJevCallsStatement,
	reserveJevCalls,
} from "../src/db/jev-calls";
import { resetDemo } from "../src/demo/reset";

// The day's Jev count (spec §8.6): one number per household date that every run, at a sync or
// overnight, counts against, so a day never goes over the cap. A run reserves the calls it wants in
// one step before it starts, and gives back what it didn't use when it ends.

const db = env.DB;
const rows = async () =>
	(
		await db
			.prepare(
				"SELECT key, value FROM household_settings WHERE key GLOB 'jev_calls_*' ORDER BY key",
			)
			.all<{ key: string; value: string }>()
	).results;
let turns = 0;
/** A reserve for a new sorting group: each group's name is unique, so each reserve gets its own turn. */
const reserve = (day: string, cap: number, wanted: number) =>
	reserveJevCalls(db, day, cap, wanted, `group:${++turns}`);
/** How many of the day's calls are spoken for. */
const used = async (day: string) =>
	Number((await rows()).find((r) => r.key === `jev_calls_${day}`)?.value ?? 0);

beforeEach(async () => {
	await db
		.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'")
		.run();
});

describe("reserving Jev's calls for the day", () => {
	it("grants what's wanted when the day has room, and counts it", async () => {
		expect(await reserve("2026-10-06", 40, 12)).toBe(12);
		expect(await rows()).toEqual([
			{ key: "jev_calls_2026-10-06", value: "12" },
		]);
	});

	it("grants only what's left of the cap, and counts exactly that", async () => {
		expect(await reserve("2026-10-06", 40, 35)).toBe(35);
		expect(await reserve("2026-10-06", 40, 10)).toBe(5);
		expect(await used("2026-10-06")).toBe(40);
	});

	it("grants a new day's first reservation up to the cap too", async () => {
		expect(await reserve("2026-10-06", 40, 100)).toBe(40);
		expect(await used("2026-10-06")).toBe(40);
	});

	it("grants nothing once the cap is used, and counts nothing more", async () => {
		await reserve("2026-10-06", 3, 3);
		expect(await reserve("2026-10-06", 3, 1)).toBe(0);
		expect(await used("2026-10-06")).toBe(3);
	});

	it("grants nothing when nothing is wanted or the cap is zero, and writes no row", async () => {
		expect(await reserve("2026-10-06", 40, 0)).toBe(0);
		expect(await reserve("2026-10-06", 0, 5)).toBe(0);
		expect(await rows()).toEqual([]);
	});

	it("never grants more than the cap between runs reserving at the same moment", async () => {
		const grants = await Promise.all(
			Array.from({ length: 12 }, () => reserve("2026-10-06", 50, 7)),
		);
		const total = grants.reduce((a, b) => a + b, 0);
		expect(total).toBe(50);
		expect(await used("2026-10-06")).toBe(50);
		// Each run got a whole number between none and what it asked for.
		for (const granted of grants) {
			expect(granted).toBeGreaterThanOrEqual(0);
			expect(granted).toBeLessThanOrEqual(7);
		}
	});

	it("reserves against the cap it's asked under, so a bigger cap leaves room", async () => {
		await reserve("2026-10-06", 3, 3);
		expect(await reserve("2026-10-06", 3, 1)).toBe(0);
		expect(await reserve("2026-10-06", 500, 10)).toBe(10);
		expect(await used("2026-10-06")).toBe(13);
	});

	it("starts each household day at zero and drops the days before it", async () => {
		await reserve("2026-10-05", 3, 3);
		expect(await reserve("2026-10-06", 3, 2)).toBe(2);
		// Yesterday's count is gone; today's is the only row kept.
		expect(await rows()).toEqual([{ key: "jev_calls_2026-10-06", value: "2" }]);
	});

	it("leaves the household's other settings alone", async () => {
		await reserve("2026-10-06", 3, 3);
		await reserve("2026-10-07", 3, 1);
		const others = await db
			.prepare(
				"SELECT key FROM household_settings WHERE key NOT GLOB 'jev_calls_*' ORDER BY key",
			)
			.all<{ key: string }>();
		expect(others.results.map((r) => r.key)).toContain("time_zone");
	});

	it("takes one batch, so the count it read and the count it wrote are one step", async () => {
		const batches: number[] = [];
		const spied = new Proxy(db, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (property === "batch")
					return (statements: unknown[]) => {
						batches.push(statements.length);
						return (value as (s: unknown[]) => unknown).call(
							target,
							statements,
						);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await reserveJevCalls(spied, "2026-10-06", 40, 12, "spied:1");
		expect(batches).toHaveLength(1);
	});
});

describe("giving back what a run didn't use", () => {
	it("takes the unused part off the day's count", async () => {
		await reserve("2026-10-06", 40, 30);
		await giveBackJevCallsStatement(db, "2026-10-06", 22)?.run();
		expect(await used("2026-10-06")).toBe(8);
	});

	it("leaves room for the next run, up to the cap", async () => {
		await reserve("2026-10-06", 40, 40);
		await giveBackJevCallsStatement(db, "2026-10-06", 15)?.run();
		expect(await reserve("2026-10-06", 40, 40)).toBe(15);
	});

	it("never takes the count below zero, whatever it's told", async () => {
		await reserve("2026-10-06", 40, 5);
		await giveBackJevCallsStatement(db, "2026-10-06", 9)?.run();
		expect(await used("2026-10-06")).toBe(0);
	});

	it("does nothing when nothing is unused, or the day has no row", async () => {
		await giveBackJevCallsStatement(db, "2026-10-06", 0)?.run();
		await giveBackJevCallsStatement(db, "2026-10-06", 4)?.run();
		expect(await rows()).toEqual([]);
		await reserve("2026-10-06", 40, 5);
		await giveBackJevCallsStatement(db, "2026-10-06", 0)?.run();
		expect(await used("2026-10-06")).toBe(5);
	});

	it("gives back to the day it reserved from, not the day it is now", async () => {
		await reserve("2026-10-05", 40, 10);
		await reserve("2026-10-06", 40, 10);
		await giveBackJevCallsStatement(db, "2026-10-05", 10)?.run();
		expect(await used("2026-10-06")).toBe(10);
	});
});

// The demo's nightly reset clears the household's choices, but not how many calls the day has used,
// so two runs on one household day can't spend the demo's 40 each.
describe("the demo's nightly reset", () => {
	it("keeps the day's count, so a second run the same day gets what's left", async () => {
		await resetDemo(db, "2026-10-06");
		await reserve("2026-10-06", 40, 25);
		await resetDemo(db, "2026-10-06");
		expect(await used("2026-10-06")).toBe(25);
		expect(await reserve("2026-10-06", 40, 40)).toBe(15);
	});

	it("still puts the time zone and the AI switches back, and leaves one time zone row", async () => {
		await resetDemo(db, "2026-10-06");
		await reserve("2026-10-06", 40, 3);
		await db
			.prepare(
				"UPDATE household_settings SET value = 'Asia/Tokyo' WHERE key = 'time_zone'",
			)
			.run();
		await saveAiSwitches(db, { categories: false, income: false });
		await resetDemo(db, "2026-10-06");
		const settings = (
			await db
				.prepare("SELECT key, value FROM household_settings ORDER BY key")
				.all<{ key: string; value: string }>()
		).results;
		expect(settings).toEqual([
			{ key: "jev_calls_2026-10-06", value: "3" },
			{ key: "time_zone", value: "America/New_York" },
		]);
	});
});

// A group's reservation is kept under its name, the day and its turn, in the same batch as the count (decision 142).
describe("a group's reservation is kept under its name", () => {
	const recorded = async (day: string, turnId: string) =>
		(
			await db
				.prepare("SELECT value FROM household_settings WHERE key = ?")
				.bind(`jev_reserved_${day}_${turnId}`)
				.first<{ value: string }>()
		)?.value ?? null;

	it("keeps the grant under the day and the turn, and returns it", async () => {
		expect(await reserveJevCalls(db, "2026-10-06", 40, 12, "run:a:1")).toBe(12);
		expect(await recorded("2026-10-06", "run:a:1")).toBe("12");
		expect(await used("2026-10-06")).toBe(12);
	});

	it("keeps a grant of nothing when the day is full, so a re-run grants nothing too", async () => {
		await reserve("2026-10-06", 3, 3);
		expect(await reserveJevCalls(db, "2026-10-06", 3, 1, "run:a:full")).toBe(0);
		expect(await recorded("2026-10-06", "run:a:full")).toBe("0");
	});

	it("fails the whole batch when the same group reserves again, so the count is never charged twice", async () => {
		await reserveJevCalls(db, "2026-10-06", 40, 12, "run:a:2");
		await expect(
			reserveJevCalls(db, "2026-10-06", 40, 12, "run:a:2"),
		).rejects.toThrow();
		expect(await used("2026-10-06")).toBe(12);
		expect(await recorded("2026-10-06", "run:a:2")).toBe("12");
	});

	it("clears the records of days before the last two, and keeps the last two days' and today's", async () => {
		await reserveJevCalls(db, "2026-10-03", 40, 1, "old");
		await reserveJevCalls(db, "2026-10-05", 40, 1, "recent");
		await reserveJevCalls(db, "2026-10-06", 40, 1, "today");
		expect(await recorded("2026-10-03", "old")).toBeNull();
		expect(await recorded("2026-10-05", "recent")).toBe("1");
		expect(await recorded("2026-10-06", "today")).toBe("1");
	});
});

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import {
	AI_SWITCHES_ALL_ON,
	asksJev,
	readAiSwitches,
	saveAiSwitches,
} from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";

const db = env.DB;

const stored = async () =>
	(
		await db
			.prepare(
				"SELECT key, value FROM household_settings WHERE key LIKE 'ai_%' ORDER BY key",
			)
			.all<{ key: string; value: string }>()
	).results;

beforeEach(async () => {
	await resetDemo(db, todayIn(DEFAULT_TIME_ZONE));
});

describe("migration 0023", () => {
	const migration = env.TEST_MIGRATIONS.find((m) =>
		m.name.startsWith("0023_ai_switches"),
	);

	it("puts all four switches on, and leaves the time zone and any choice already made", async () => {
		expect(migration).toBeDefined();
		await db.batch([
			db.prepare("DELETE FROM household_settings"),
			db.prepare(
				"INSERT INTO household_settings (key, value) VALUES ('time_zone', 'America/Chicago'), ('ai_income', 'off')",
			),
		]);
		for (const query of migration?.queries ?? []) await db.prepare(query).run();
		expect(await stored()).toEqual([
			{ key: "ai_categories", value: "on" },
			{ key: "ai_income", value: "off" },
			{ key: "ai_names", value: "on" },
			{ key: "ai_sort_on_arrival", value: "on" },
		]);
		expect(
			await db
				.prepare("SELECT value FROM household_settings WHERE key = 'time_zone'")
				.first(),
		).toEqual({ value: "America/Chicago" });
	});
});

describe("readAiSwitches", () => {
	it("is all on when nothing is stored, as after the demo's reset", async () => {
		expect(await stored()).toEqual([]);
		expect(await readAiSwitches(db)).toEqual(AI_SWITCHES_ALL_ON);
		expect(AI_SWITCHES_ALL_ON).toEqual({
			names: true,
			categories: true,
			income: true,
			sortOnArrival: true,
		});
	});

	it("reads each switch from its own row, and only off turns one off", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO household_settings (key, value) VALUES ('ai_names', 'off'), ('ai_categories', 'on'), ('ai_income', 'anything else'), ('ai_sort_on_arrival', 'off')",
			),
		]);
		expect(await readAiSwitches(db)).toEqual({
			names: false,
			categories: true,
			income: true,
			sortOnArrival: false,
		});
	});

	it("fails rather than guess when the database can't be read, so a run never calls an AI the household turned off", async () => {
		const broken = {
			prepare: () => {
				throw new Error("D1_ERROR: network connection lost");
			},
		} as unknown as D1Database;
		await expect(readAiSwitches(broken)).rejects.toThrow("network connection");
	});
});

describe("saveAiSwitches", () => {
	it("stores each switch as on or off, and reads it back", async () => {
		await saveAiSwitches(db, {
			names: false,
			categories: true,
			income: false,
			sortOnArrival: true,
		});
		expect(await stored()).toEqual([
			{ key: "ai_categories", value: "on" },
			{ key: "ai_income", value: "off" },
			{ key: "ai_names", value: "off" },
			{ key: "ai_sort_on_arrival", value: "on" },
		]);
		expect(await readAiSwitches(db)).toEqual({
			names: false,
			categories: true,
			income: false,
			sortOnArrival: true,
		});
	});

	it("saves only the switches it's given, leaving the others as they were", async () => {
		await saveAiSwitches(db, { names: false, sortOnArrival: false });
		await saveAiSwitches(db, { income: false });
		expect(await readAiSwitches(db)).toEqual({
			names: false,
			categories: true,
			income: false,
			sortOnArrival: false,
		});
		// Nothing given saves nothing.
		await saveAiSwitches(db, {});
		expect(await stored()).toHaveLength(3);
	});

	it("changes a stored switch in place, never adding a second row, and leaves the time zone alone", async () => {
		await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, income: false });
		await saveAiSwitches(db, AI_SWITCHES_ALL_ON);
		expect((await stored()).map((row) => row.value)).toEqual([
			"on",
			"on",
			"on",
			"on",
		]);
		expect(
			await db
				.prepare("SELECT value FROM household_settings WHERE key = 'time_zone'")
				.first(),
		).toEqual({ value: DEFAULT_TIME_ZONE });
	});

	it("is put back to all on by the demo's nightly reset", async () => {
		await saveAiSwitches(db, {
			names: false,
			categories: false,
			income: false,
			sortOnArrival: false,
		});
		await resetDemo(db, todayIn(DEFAULT_TIME_ZONE));
		expect(await readAiSwitches(db)).toEqual(AI_SWITCHES_ALL_ON);
	});
});

describe("asksJev", () => {
	it.each([
		{ categories: true, income: true, asked: true },
		{ categories: true, income: false, asked: true },
		{ categories: false, income: true, asked: true },
		{ categories: false, income: false, asked: false },
	])(
		"is $asked with categories $categories and income $income, whatever names and sorting say",
		({ categories, income, asked }) => {
			for (const names of [true, false])
				for (const sortOnArrival of [true, false])
					expect(asksJev({ names, categories, income, sortOnArrival })).toBe(
						asked,
					);
		},
	);
});

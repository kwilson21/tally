import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { householdToday } from "../src/dates";
import { saveAiSwitches } from "../src/db/ai-switches";
import { takeSortingTurn } from "../src/db/sorting-turn";
import { resetDemo } from "../src/demo/reset";
import { sortGroups } from "../src/sort-groups";
import { fakeSteps } from "./fake-sort-steps";

const db = env.DB;
const TODAY = "2026-09-22";

/** A Jev reply: Eating Out at the given confidence, no flags. */
const reply = (confidence: number) =>
	new Response(
		JSON.stringify({
			answers: {
				category: { type: "choice", choice: "Eating Out", confidence },
				transfer: { type: "noul", noul: 0.01 },
				reimbursement: { type: "noul", noul: 0.01 },
				income: { type: "noul", noul: 0.01 },
			},
		}),
		{ status: 200 },
	);

const withKey = { DB: db, JEV_API_KEY: "test-key" };

/** Inserts `n` unsorted purchases and returns their ids, oldest first. */
async function addWaiting(n: number): Promise<number[]> {
	const ids: number[] = [];
	for (let i = 0; i < n; i++) {
		const row = await db
			.prepare(
				"INSERT INTO transactions(account_id,date,amount_cents,raw_name) VALUES(1,?,?,?) RETURNING id",
			)
			.bind(TODAY, -500 - i, `SORT STEP ${i}`)
			.first<{ id: number }>();
		ids.push(Number(row?.id));
	}
	return ids;
}

const categoryOf = async (id: number) =>
	(
		await db
			.prepare("SELECT category_id AS c FROM transactions WHERE id = ?")
			.bind(id)
			.first<{ c: number | null }>()
	)?.c ?? null;

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await saveAiSwitches(db, { details: false });
	await db
		.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'")
		.run();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const ASK = {
	retries: { limit: 0, delay: 0 },
	timeout: "1 minute",
	sensitive: "output",
};
const READ = {
	retries: { limit: 50, delay: "20 seconds", backoff: "constant" },
	timeout: "1 minute",
	sensitive: "output",
};
const WRITE = {
	retries: { limit: 4, delay: "10 seconds", backoff: "constant" },
	timeout: "1 minute",
	sensitive: "output",
};

describe("sortGroups with a fake step runner", () => {
	it("runs the steps in order, each with its config (rules, read, one ask per row, write)", async () => {
		const ids = await addWaiting(3);
		const fake = fakeSteps();
		const fetchImpl = vi.fn(async () => reply(0.9));
		await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: false,
			onlyIds: ids,
			runId: "run-14",
		});
		expect(fake.names()).toEqual([
			"rules",
			"group-1-read",
			`group-1-ask-${ids[2]}`,
			`group-1-ask-${ids[1]}`,
			`group-1-ask-${ids[0]}`,
			"group-1-write",
		]);
		const config = (name: string) =>
			fake.steps.find((step) => step.name === name)?.config;
		expect(config("rules")).toEqual(WRITE);
		expect(config("group-1-read")).toEqual(READ);
		expect(config("group-1-write")).toEqual(WRITE);
		expect(config(`group-1-ask-${ids[2]}`)).toEqual(ASK);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("an ask step never throws: a failing call ends the group's asking with no retry", async () => {
		const ids = await addWaiting(3);
		const fake = fakeSteps();
		const fetchImpl = vi.fn(async () => {
			throw new TypeError("network down");
		});
		const done = await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			onlyIds: ids,
			runId: "run-15",
		});
		const asks = fake.steps.filter((step) => step.name.includes("-ask-"));
		expect(asks).toHaveLength(1);
		expect(asks[0]?.attempts).toBe(1);
		expect(done.asked).toBe(1);
		expect(await categoryOf(ids[0] as number)).toBeNull();
	});

	it("an ask step at attempt 2 makes no Jev call and gives the row no failure mark", async () => {
		const ids = await addWaiting(3);
		const second = `group-1-ask-${ids[1]}`;
		const fake = fakeSteps({ throws: { [second]: 1 } });
		const fetchImpl = vi.fn(async () => reply(0.9));
		const done = await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			onlyIds: ids,
			runId: "run-16",
		});
		// The lost row counts as asked and stops this group's asking: the third row gets no step.
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fake.steps.find((step) => step.name === second)?.attempts).toBe(2);
		expect(fake.names()).not.toContain(`group-1-ask-${ids[0]}`);
		expect(done.asked).toBe(2);
		const failed = await db
			.prepare("SELECT jev_failed_at AS f FROM transactions WHERE id = ?")
			.bind(ids[1])
			.first<{ f: string | null }>();
		expect(failed?.f).toBeNull();
		expect(await categoryOf(ids[1] as number)).toBeNull();
	});

	it("replaying the same step results makes no Jev call and writes nothing again", async () => {
		const ids = await addWaiting(3);
		const fake = fakeSteps();
		const fetchImpl = vi.fn(async () => reply(0.9));
		const first = await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			onlyIds: ids,
			runId: "run-17",
		});
		const before = fake.steps.length;
		const again = await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			onlyIds: ids,
			runId: "run-17",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(again).toEqual(first);
		const replayed = fake.steps.slice(before);
		expect(replayed.every((step) => step.cached)).toBe(true);
		expect(replayed.map((step) => step.name)).toEqual(
			fake.steps.slice(0, before).map((step) => step.name),
		);
	});

	it("a demo reset in the middle of a group makes the write change nothing", async () => {
		const ids = await addWaiting(3);
		const fake = fakeSteps({
			beforeAttempt: async (name, attempt) => {
				if (name === "group-1-write" && attempt === 1)
					await db
						.prepare(
							"DELETE FROM household_settings WHERE key = 'sorting_turn'",
						)
						.run();
			},
		});
		const fetchImpl = vi.fn(async () => reply(0.9));
		await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			onlyIds: ids,
			runId: "run-18",
		});
		for (const id of ids) expect(await categoryOf(id as number)).toBeNull();
		const logged = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM ai_log WHERE transaction_id IN (SELECT value FROM json_each(?))",
			)
			.bind(JSON.stringify(ids))
			.first<{ n: number }>();
		expect(logged?.n).toBe(0);
	});

	it("a read with the turn held by another group waits (throws) until the turn is free, then reads", async () => {
		const ids = await addWaiting(2);
		await db
			.prepare(
				"INSERT INTO household_settings (key, value) VALUES ('sorting_turn', ?)",
			)
			.bind(JSON.stringify({ id: "someone-else", until: Date.now() + 60_000 }))
			.run();
		const fake = fakeSteps({
			beforeAttempt: async (name, attempt) => {
				if (name === "group-1-read" && attempt === 2)
					await db
						.prepare(
							"DELETE FROM household_settings WHERE key = 'sorting_turn'",
						)
						.run();
			},
		});
		const fetchImpl = vi.fn(async () => reply(0.9));
		await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			onlyIds: ids,
			runId: "run-8",
			waitForTurn: true,
		});
		expect(
			fake.steps.find((step) => step.name === "group-1-read")?.attempts,
		).toBe(2);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("a group whose first ask is already past its 2-minute budget asks nothing and ends the run", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-22T15:00:00Z"));
		const ids = await addWaiting(25);
		const fake = fakeSteps({
			beforeAttempt: async (name) => {
				if (name.startsWith("group-1-ask-"))
					vi.setSystemTime(Date.now() + 3 * 60_000);
			},
		});
		const fetchImpl = vi.fn(async () => reply(0.9));
		const done = await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			onlyIds: ids,
			runId: "run-budget-first",
		});
		expect(done).toEqual({ asked: 0, applied: 0 });
		expect(fetchImpl).not.toHaveBeenCalled();
		// The group stops the run, so the same rows aren't read again by a second group in this run.
		expect(fake.names()).not.toContain("group-2-read");
		const turn = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM household_settings WHERE key = 'sorting_turn'",
			)
			.first<{ n: number }>();
		expect(turn?.n).toBe(0);
		const used = await db
			.prepare(
				"SELECT value FROM household_settings WHERE key = 'jev_calls_2026-09-22'",
			)
			.first<{ value: string }>();
		expect(Number(used?.value ?? 0)).toBe(0);
	});

	it("failures carry across groups: two at the end of one group and one at the start of the next stop the run", async () => {
		const ids = await addWaiting(50);
		let calls = 0;
		const fetchImpl = vi.fn(async () => {
			calls += 1;
			return calls >= 24 && calls <= 26
				? new Response("{}", { status: 400 })
				: reply(0.9);
		});
		const fake = fakeSteps();
		await sortGroups(
			{ DB: db, JEV_API_KEY: "test-key", DEMO: "false" },
			fake.runStep,
			fetchImpl,
			{ rulesApplied: true, onlyIds: ids, runId: "run-streak" },
		);
		expect(fetchImpl).toHaveBeenCalledTimes(26);
		expect(fake.names()).toContain("group-2-write");
		expect(fake.names()).not.toContain("group-3-read");
	});

	it("a group's 2-minute budget ending after two failures keeps the streak: the next group's first failure stops the run", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-22T15:00:00Z"));
		const ids = await addWaiting(50);
		let calls = 0;
		const fetchImpl = vi.fn(async () => {
			calls += 1;
			return calls === 1 ? reply(0.9) : new Response("{}", { status: 400 });
		});
		let asks = 0;
		const fake = fakeSteps({
			beforeAttempt: async (name) => {
				// The fourth ask of group 1 finds its 2-minute budget spent: it makes no call.
				if (name.startsWith("group-1-ask-") && ++asks === 4)
					vi.setSystemTime(Date.now() + 3 * 60_000);
			},
		});
		await sortGroups(
			{ DB: db, JEV_API_KEY: "test-key", DEMO: "false" },
			fake.runStep,
			fetchImpl,
			{ rulesApplied: true, onlyIds: ids, runId: "run-streak-budget" },
		);
		// Calls 2 and 3 (group 1) and call 4 (group 2) fail in a row: the run stops after the fourth call.
		expect(fetchImpl).toHaveBeenCalledTimes(4);
		expect(fake.names()).toContain("group-2-write");
		expect(fake.names()).not.toContain("group-3-read");
	});
});

describe("the sorting turn", () => {
	it("is taken when free, kept by its own id, and taken over once its until has passed", async () => {
		expect(await takeSortingTurn(db, "a:1")).toBe(true);
		expect(await takeSortingTurn(db, "a:1")).toBe(true);
		expect(await takeSortingTurn(db, "b:1")).toBe(false);
		await db
			.prepare(
				"UPDATE household_settings SET value = ? WHERE key = 'sorting_turn'",
			)
			.bind(JSON.stringify({ id: "a:1", until: Date.now() - 1 }))
			.run();
		expect(await takeSortingTurn(db, "b:1")).toBe(true);
	});

	it("a turn with no until can't block forever", async () => {
		await db
			.prepare(
				"INSERT INTO household_settings (key, value) VALUES ('sorting_turn', ?)",
			)
			.bind(JSON.stringify({ id: "a:1" }))
			.run();
		expect(await takeSortingTurn(db, "b:1")).toBe(true);
	});
});

describe("the household's day", () => {
	it("is read once a group: the same day's calls are reserved under the day the read used", async () => {
		const ids = await addWaiting(2);
		const fake = fakeSteps();
		await sortGroups(
			withKey,
			fake.runStep,
			vi.fn(async () => reply(0.9)),
			{
				rulesApplied: true,
				onlyIds: ids,
				runId: "run-day",
			},
		);
		const day = await householdToday(db);
		const used = await db
			.prepare("SELECT value FROM household_settings WHERE key = ?")
			.bind(`jev_calls_${day}`)
			.first<{ value: string }>();
		expect(Number(used?.value)).toBe(2);
	});
});

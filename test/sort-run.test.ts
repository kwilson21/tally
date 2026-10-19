import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	categorizePending,
	MAX_CALLS_PER_RUN,
} from "../src/categorize-pending";
import { householdToday } from "../src/dates";
import { saveAiSwitches } from "../src/db/ai-switches";
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

const withKey = { DB: db, JEV_API_KEY: "test-key", DEMO: "false" };
const demoWithKey = { DB: db, JEV_API_KEY: "test-key", DEMO: "true" };

/** Inserts `n` unsorted purchases in one batch and returns their ids, oldest first. */
async function addWaiting(n: number): Promise<number[]> {
	const results = await db.batch(
		Array.from({ length: n }, (_, i) =>
			db
				.prepare(
					"INSERT INTO transactions(account_id,date,amount_cents,raw_name) VALUES(1,?,?,?) RETURNING id",
				)
				.bind(TODAY, -500 - i, `SORT RUN ${i}`),
		),
	);
	return results.map((result) =>
		Number((result.results[0] as { id: number }).id),
	);
}

const categoryOf = async (id: number) =>
	(
		await db
			.prepare("SELECT category_id AS c FROM transactions WHERE id = ?")
			.bind(id)
			.first<{ c: number | null }>()
	)?.c ?? null;

const categorizedIn = async (ids: number[]) => {
	let n = 0;
	for (const id of ids) if ((await categoryOf(id)) !== null) n += 1;
	return n;
};

const callsUsed = async (day?: string) =>
	Number(
		(
			await db
				.prepare("SELECT value FROM household_settings WHERE key = ?")
				.bind(`jev_calls_${day ?? (await householdToday(db))}`)
				.first<{ value: string }>()
		)?.value ?? 0,
	);

const turnRow = () =>
	db
		.prepare("SELECT value FROM household_settings WHERE key = 'sorting_turn'")
		.first<{ value: string }>();

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await saveAiSwitches(db, { details: false });
	await db
		.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'")
		.run();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	await db.prepare("DROP TRIGGER IF EXISTS sort_test_fail").run();
});

describe("sorting in groups of 25, in one process", () => {
	it("asks 60 waiting rows in groups of 25, 25 and 10, saves all of them and leaves no turn behind", async () => {
		const ids = await addWaiting(60);
		const fetchImpl = vi.fn(async () => reply(0.9));
		const done = await categorizePending(withKey, fetchImpl, { onlyIds: ids });
		expect(done).toEqual({ asked: 60, applied: 60 });
		expect(await categorizedIn(ids)).toBe(60);
		expect(await callsUsed()).toBe(60);
		expect(await turnRow()).toBeNull();
	});

	it("exactly 25 waiting: one full group, then an empty read ends the run", async () => {
		const ids = await addWaiting(25);
		const fetchImpl = vi.fn(async () => reply(0.9));
		const done = await categorizePending(withKey, fetchImpl, { onlyIds: ids });
		expect(done.asked).toBe(25);
		expect(fetchImpl).toHaveBeenCalledTimes(25);
		expect(await turnRow()).toBeNull();
	});

	it("600 waiting against the 500 cap asks 500 and leaves 100; the demo's 40 cap asks 25 then 15", async () => {
		const ids = await addWaiting(600);
		const fetchImpl = vi.fn(async () => reply(0.9));
		// One run asks at most MAX_CALLS_PER_RUN (the D1 query limit); the runs share the day's 500.
		const first = await categorizePending(withKey, fetchImpl, { onlyIds: ids });
		expect(first.asked).toBe(MAX_CALLS_PER_RUN);
		const second = await categorizePending(withKey, fetchImpl, {
			onlyIds: ids,
		});
		expect(second.asked).toBe(500 - MAX_CALLS_PER_RUN);
		expect(await categorizedIn(ids)).toBe(500);
		expect(await callsUsed()).toBe(500);
		expect(
			await categorizePending(withKey, fetchImpl, { onlyIds: ids }),
		).toEqual({ asked: 0, applied: 0 });

		// A new household day, so the demo's cap of 40 is what's left.
		await db
			.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'")
			.run();
		const demoIds = await addWaiting(40);
		const fake = fakeSteps();
		await sortGroups(
			demoWithKey,
			fake.runStep,
			vi.fn(async () => reply(0.9)),
			{
				rulesApplied: true,
				onlyIds: demoIds,
				runId: "run-demo-cap",
			},
		);
		const asks = (group: number) =>
			fake.steps.filter((step) => step.name.startsWith(`group-${group}-ask-`))
				.length;
		expect(asks(1)).toBe(25);
		expect(asks(2)).toBe(15);
	});

	it("all or none: a save that fails leaves the group's 25 waiting, and a retried save saves all 25", async () => {
		const ids = await addWaiting(25);
		const tenth = ids[9];
		await db
			.prepare(
				`CREATE TRIGGER sort_test_fail BEFORE INSERT ON ai_log WHEN NEW.transaction_id = ${tenth} BEGIN SELECT RAISE(ABORT, 'test: the tenth answer fails'); END`,
			)
			.run();
		await expect(
			categorizePending(
				withKey,
				vi.fn(async () => reply(0.9)),
				{ onlyIds: ids },
			),
		).rejects.toThrow();
		expect(await categorizedIn(ids)).toBe(0);
		expect(await turnRow()).toBeNull();

		const fake = fakeSteps({
			beforeAttempt: async (name, attempt) => {
				if (name === "group-1-write" && attempt === 2)
					await db.prepare("DROP TRIGGER sort_test_fail").run();
			},
		});
		const fetchImpl = vi.fn(async () => reply(0.9));
		await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			onlyIds: ids,
			runId: "run-all-or-none",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(25);
		expect(await categorizedIn(ids)).toBe(25);
	});

	it("a write retried after its batch committed changes nothing again", async () => {
		const ids = await addWaiting(3);
		const fake = fakeSteps({ replayAfter: ["group-1-write"] });
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(reply(0.9))
			.mockResolvedValueOnce(new Response("nope", { status: 503 }))
			.mockImplementation(async () => reply(0.9));
		await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			onlyIds: ids,
			runId: "run-replay-write",
		});
		// One answer, one failure (a 503): 2 calls used of the 3 reserved, and the unused one given back once.
		expect(await callsUsed()).toBe(2);
		const logged = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM ai_log WHERE kind = 'category' AND transaction_id IN (SELECT value FROM json_each(?))",
			)
			.bind(JSON.stringify(ids))
			.first<{ n: number }>();
		expect(logged?.n).toBe(1);
	});

	it("switches are read once a group: turning categories and income off mid-group applies nothing and starts no new group", async () => {
		const ids = await addWaiting(30);
		let calls = 0;
		const fetchImpl = vi.fn(async () => {
			calls += 1;
			if (calls === 3)
				await saveAiSwitches(db, { categories: false, income: false });
			return reply(0.9);
		});
		await categorizePending(withKey, fetchImpl, { onlyIds: ids });
		expect(fetchImpl).toHaveBeenCalledTimes(25);
		expect(await categorizedIn(ids)).toBe(0);
	});

	it("sort right away turned off mid-group (a sync's run) applies nothing of that group", async () => {
		const ids = await addWaiting(30);
		let calls = 0;
		const fetchImpl = vi.fn(async () => {
			calls += 1;
			if (calls === 3) await saveAiSwitches(db, { sortOnArrival: false });
			return reply(0.9);
		});
		await categorizePending(withKey, fetchImpl, { onlyIds: ids, bySync: true });
		expect(fetchImpl).toHaveBeenCalledTimes(25);
		expect(await categorizedIn(ids)).toBe(0);
	});

	it("a live turn held by another group: nothing is asked and nothing changes", async () => {
		const ids = await addWaiting(2);
		await db
			.prepare(
				"INSERT INTO household_settings (key, value) VALUES ('sorting_turn', ?)",
			)
			.bind(JSON.stringify({ id: "other:1", until: Date.now() + 60_000 }))
			.run();
		const fetchImpl = vi.fn(async () => reply(0.9));
		const done = await categorizePending(withKey, fetchImpl, { onlyIds: ids });
		expect(done.asked).toBe(0);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(await categorizedIn(ids)).toBe(0);
	});

	it.each([
		["an expired turn", { id: "other:1", until: Date.now() - 1 }],
		["a turn with no until", { id: "other:1" }],
	])("%s is taken over and sorting proceeds", async (_name, value) => {
		const ids = await addWaiting(2);
		await db
			.prepare(
				"INSERT INTO household_settings (key, value) VALUES ('sorting_turn', ?)",
			)
			.bind(JSON.stringify(value))
			.run();
		const done = await categorizePending(
			withKey,
			vi.fn(async () => reply(0.9)),
			{
				onlyIds: ids,
			},
		);
		expect(done.asked).toBe(2);
		expect(await turnRow()).toBeNull();
	});

	it("two runs over the same rows: the second, started while the first holds the turn, asks nothing", async () => {
		const ids = await addWaiting(25);
		const second = vi.fn(async () => reply(0.9));
		let started = false;
		const first = vi.fn(async () => {
			if (!started) {
				started = true;
				const done = await categorizePending(withKey, second, { onlyIds: ids });
				expect(done.asked).toBe(0);
			}
			return reply(0.9);
		});
		await categorizePending(withKey, first, { onlyIds: ids });
		expect(first).toHaveBeenCalledTimes(25);
		expect(second).not.toHaveBeenCalled();
		expect(await categorizedIn(ids)).toBe(25);
	});

	it.each([
		["a 503", () => new Response("down", { status: 503 })],
		["a 429", () => new Response("slow down", { status: 429 })],
		["a timeout", () => Promise.reject(new Error("timeout"))],
	])(
		"Jev down (%s) on the 3rd call stops the run: 2 answers saved, 3 calls counted, the turn released",
		async (_name, failing) => {
			const ids = await addWaiting(25);
			const fetchImpl = vi
				.fn()
				.mockResolvedValueOnce(reply(0.9))
				.mockResolvedValueOnce(reply(0.9))
				.mockImplementationOnce(failing);
			const done = await categorizePending(withKey, fetchImpl, {
				onlyIds: ids,
			});
			expect(done.asked).toBe(3);
			expect(fetchImpl).toHaveBeenCalledTimes(3);
			expect(await categorizedIn(ids)).toBe(2);
			expect(await callsUsed()).toBe(3);
			expect(await turnRow()).toBeNull();
		},
	);

	it("one bad transaction (a 400) is marked and not asked again in a later group of the run", async () => {
		const ids = await addWaiting(60);
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(reply(0.9))
			.mockResolvedValueOnce(reply(0.9))
			.mockResolvedValueOnce(new Response("bad", { status: 400 }))
			.mockImplementation(async () => reply(0.9));
		await categorizePending(withKey, fetchImpl, { onlyIds: ids });
		expect(fetchImpl).toHaveBeenCalledTimes(60);
		expect(await categorizedIn(ids)).toBe(59);
		const failed = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE id IN (SELECT value FROM json_each(?)) AND jev_failed_at IS NOT NULL",
			)
			.bind(JSON.stringify(ids))
			.first<{ n: number }>();
		expect(failed?.n).toBe(1);
	});

	it("the household's date changes mid-group: no further calls, and the answers so far are saved", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-22T15:00:00Z"));
		const ids = await addWaiting(25);
		let calls = 0;
		const fetchImpl = vi.fn(async () => {
			calls += 1;
			if (calls === 3) vi.setSystemTime(new Date("2026-09-23T15:00:00Z"));
			return reply(0.9);
		});
		await categorizePending(withKey, fetchImpl, { onlyIds: ids });
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(await categorizedIn(ids)).toBe(3);
		expect(await callsUsed("2026-09-22")).toBe(3);
	});

	it("the 2-minute budget: rows past it wait in this group and the next group asks them", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-22T15:00:00Z"));
		const ids = await addWaiting(25);
		let calls = 0;
		const fetchImpl = vi.fn(async () => {
			calls += 1;
			if (calls === 4) vi.setSystemTime(new Date("2026-09-22T15:03:00Z"));
			return reply(0.9);
		});
		let callsAtSecondGroup = -1;
		const fake = fakeSteps({
			beforeAttempt: async (name) => {
				if (name === "group-2-read") callsAtSecondGroup = calls;
			},
		});
		await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			onlyIds: ids,
			runId: "run-budget",
		});
		expect(callsAtSecondGroup).toBe(4);
		expect(fetchImpl).toHaveBeenCalledTimes(25);
		expect(await categorizedIn(ids)).toBe(25);
	});
});

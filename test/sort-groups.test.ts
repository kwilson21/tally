import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { householdToday } from "../src/dates";
import { saveAiSwitches } from "../src/db/ai-switches";
import { takeSortingTurn } from "../src/db/sorting-turn";
import { resetDemo } from "../src/demo/reset";
import { type StepRunner, sortGroups } from "../src/sort-groups";
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

/** A Jev reply that answers the details questions too, as a run that asks for details needs. */
const replyWithDetails = (person = "none") =>
	new Response(
		JSON.stringify({
			answers: {
				category: { type: "choice", choice: "Eating Out", confidence: 0.9 },
				transfer: { type: "noul", noul: 0.01 },
				reimbursement: { type: "noul", noul: 0.01 },
				income: { type: "noul", noul: 0.01 },
				kind: { type: "choice", choice: "one_off", confidence: 0.9 },
				for_person: { type: "choice", choice: person, confidence: 0.9 },
				note_worth_writing: { type: "noul", noul: 0.01 },
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

/** Jev calls reserved for today (the household's day), as the sorting groups count them. */
const callsUsed = async () =>
	Number(
		(
			await db
				.prepare("SELECT value FROM household_settings WHERE key = ?")
				.bind(`jev_calls_${await householdToday(db)}`)
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
const RULES = {
	retries: { limit: 4, delay: "10 seconds", backoff: "constant" },
	timeout: "1 minute",
	sensitive: "output",
};
const WRITE = {
	retries: { limit: 960, delay: "1 minute", backoff: "constant" },
	timeout: "30 seconds",
	sensitive: "output",
};
const RESERVE = {
	retries: { limit: 0, delay: 0 },
	timeout: "1 minute",
	sensitive: "output",
};

describe("sortGroups with a fake step runner", () => {
	it("runs the steps in order, each with its config (rules, read, reserve, one ask per row, write)", async () => {
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
			"group-1-reserve",
			`group-1-ask-${ids[2]}`,
			`group-1-ask-${ids[1]}`,
			`group-1-ask-${ids[0]}`,
			"group-1-write",
		]);
		const config = (name: string) =>
			fake.steps.find((step) => step.name === name)?.config;
		expect(config("rules")).toEqual(RULES);
		expect(config("group-1-read")).toEqual(READ);
		expect(config("group-1-reserve")).toEqual(RESERVE);
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
							"DELETE FROM household_settings WHERE key NOT GLOB 'jev_calls_*'",
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

	it("a read whose result is lost after its turn was taken reserves no calls again", async () => {
		const ids = await addWaiting(3);
		// The read's callback runs once more after it succeeded, as when Workflows loses its result: that run takes the
		// same turn and must not reserve the day's calls a second time.
		const fake = fakeSteps({ replayAfter: ["group-1-read"] });
		const done = await sortGroups(
			withKey,
			fake.runStep,
			vi.fn(async () => reply(0.9)),
			{ rulesApplied: true, onlyIds: ids, runId: "run-read-replay" },
		);
		expect(done.asked).toBe(3);
		expect(await callsUsed()).toBe(3);
	});

	it("a reserve re-run after its calls were reserved reserves no calls again", async () => {
		const ids = await addWaiting(3);
		const fake = fakeSteps({ replayAfter: ["group-1-reserve"] });
		await sortGroups(
			withKey,
			fake.runStep,
			vi.fn(async () => reply(0.9)),
			{ rulesApplied: true, onlyIds: ids, runId: "run-reserve-replay" },
		);
		expect(fake.names()).toContain("group-1-reserve");
		expect(await callsUsed()).toBe(3);
	});

	it("a reserve step that rejects grants nothing: the write releases the turn and the run stops", async () => {
		const ids = await addWaiting(3);
		// A step that rejects fails with no retry (its config's limit is 0), so its callback never runs.
		const fake = fakeSteps({
			beforeAttempt: async (name) => {
				if (name === "group-1-reserve") throw new Error("timeout");
			},
		});
		const fetchImpl = vi.fn(async () => reply(0.9));
		const done = await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			onlyIds: ids,
			runId: "run-reserve-reject",
		});
		expect(done).toEqual({ asked: 0, applied: 0 });
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(fake.names()).toContain("group-1-write");
		expect(fake.names()).not.toContain("group-2-read");
		expect(await turnRow()).toBeNull();
		expect(await callsUsed()).toBe(0);
	});

	it("an ask step that rejects mid-group saves the answers before it, gives back the unused calls, and stops the run", async () => {
		const ids = await addWaiting(3);
		// Rows are asked newest first: the first ask answers ids[2], and the second one rejects (its timeout).
		const second = `group-1-ask-${ids[1]}`;
		const fake = fakeSteps({
			beforeAttempt: async (name) => {
				if (name === second) throw new Error("timeout");
			},
		});
		const fetchImpl = vi.fn(async () => reply(0.9));
		const done = await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			onlyIds: ids,
			runId: "run-ask-reject",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(done.asked).toBe(2);
		expect(await categoryOf(ids[2] as number)).not.toBeNull();
		expect(await categoryOf(ids[1] as number)).toBeNull();
		expect(await categoryOf(ids[0] as number)).toBeNull();
		// Three calls were reserved and two were used (one answer, one lost), so one is given back.
		expect(await callsUsed()).toBe(2);
		expect(await turnRow()).toBeNull();
		expect(fake.names()).toContain("group-1-write");
		expect(fake.names()).not.toContain(`group-1-ask-${ids[0]}`);
		expect(fake.names()).not.toContain("group-2-read");
	});

	it("a short group that runs out of its 2-minute budget after 4 asks leaves 6 rows, and the next group asks them", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-22T15:00:00Z"));
		const ids = await addWaiting(10);
		let asks = 0;
		const fake = fakeSteps({
			beforeAttempt: async (name) => {
				// The fifth ask of group 1 finds its 2-minute budget spent.
				if (name.startsWith("group-1-ask-") && ++asks === 5)
					vi.setSystemTime(Date.now() + 3 * 60_000);
			},
		});
		const fetchImpl = vi.fn(async () => reply(0.9));
		const done = await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			onlyIds: ids,
			runId: "run-short-budget",
		});
		expect(
			fake.names().filter((name) => name.startsWith("group-2-ask-")),
		).toHaveLength(6);
		expect(fetchImpl).toHaveBeenCalledTimes(10);
		expect(done).toEqual({ asked: 10, applied: 10 });
		expect(fake.names()).not.toContain("group-3-read");
	});

	it("a short group whose first ask is already past its budget asks nothing and ends the run", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-22T15:00:00Z"));
		const ids = await addWaiting(10);
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
			runId: "run-short-budget-first",
		});
		expect(done).toEqual({ asked: 0, applied: 0 });
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(fake.names()).not.toContain("group-2-read");
		expect(await turnRow()).toBeNull();
		expect(await callsUsed()).toBe(0);
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

/** The reservation record a group keeps for its calls (decision 143). */
const recordOf = async (turnId: string) =>
	(
		await db
			.prepare("SELECT value FROM household_settings WHERE key = ?")
			.bind(`jev_reserved_${await householdToday(db)}_${turnId}`)
			.first<{ value: string }>()
	)?.value ?? null;

/** The day's count as stored (null when there is no row), so a count of 0 can't be mistaken for no row. */
const countText = async (day: string) =>
	(
		await db
			.prepare("SELECT value FROM household_settings WHERE key = ?")
			.bind(`jev_calls_${day}`)
			.first<{ value: string }>()
	)?.value ?? null;

/** The "What AI did" rows for these transactions: one per answer that applied. */
const logged = async (ids: number[]) =>
	(
		await db
			.prepare(
				"SELECT COUNT(*) AS n FROM ai_log WHERE transaction_id IN (SELECT value FROM json_each(?))",
			)
			.bind(JSON.stringify(ids))
			.first<{ n: number }>()
	)?.n ?? 0;

const turnValue = async () =>
	(
		await db
			.prepare(
				"SELECT value FROM household_settings WHERE key = 'sorting_turn'",
			)
			.first<{ value: string }>()
	)?.value ?? null;

/** Sets a transaction field between the read and the save, the way a person or a sync would. */
const changeRow = (sql: string, ...binds: unknown[]) =>
	db
		.prepare(sql)
		.bind(...binds)
		.run();

describe("a save that fails keeps Jev's answers (decision 143)", () => {
	const attemptsOf = (fake: ReturnType<typeof fakeSteps>, name: string) =>
		fake.steps.find((step) => step.name === name)?.attempts;

	/** Each row's details as a save leaves them: whether they were asked, and Jev's kind and who it's for. */
	const detailsOf = async (ids: number[]) =>
		(
			await db
				.prepare(
					"SELECT id, details_asked AS detailsAsked, kind, for_person_id AS forPersonId FROM transactions WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
				)
				.bind(JSON.stringify(ids))
				.all<{
					id: number;
					detailsAsked: number;
					kind: string | null;
					forPersonId: number | null;
				}>()
		).results;

	it("a save that fails is tried again with the kept answers, and Jev isn't asked again", async () => {
		const ids = await addWaiting(3);
		const fake = fakeSteps({ throws: { "group-1-write": 2 } });
		const fetchImpl = vi.fn(async () => reply(0.9));
		const done = await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			onlyIds: ids,
			runId: "run-again",
		});
		expect(done).toEqual({ asked: 3, applied: 3 });
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(attemptsOf(fake, "group-1-write")).toBe(3);
		for (const id of ids) expect(await categoryOf(id as number)).not.toBeNull();
		expect(await logged(ids)).toBe(3);
		expect(await callsUsed()).toBe(3);
		expect(await recordOf("run-again:1")).toBeNull();
		expect(await turnRow()).toBeNull();
	});

	it("a save that fails four times, then goes through, applies the kept answers without asking Jev again", async () => {
		const ids = await addWaiting(3);
		const fake = fakeSteps({ throws: { "group-1-write": 4 } });
		const fetchImpl = vi.fn(async () => reply(0.9));
		const done = await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			onlyIds: ids,
			runId: "run-many-tries",
		});
		expect(done).toEqual({ asked: 3, applied: 3 });
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(attemptsOf(fake, "group-1-write")).toBe(5);
		expect(await logged(ids)).toBe(3);
		expect(await callsUsed()).toBe(3);
	});

	it("a save that fails every try ends the run, logs the save step's name only, and leaves its rows waiting", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const ids = await addWaiting(3);
		let turnAsRead: string | null = null;
		const fake = fakeSteps({
			// Three tries stand for the save's 960. Each one is a real batch that fails, so each is rolled back.
			limits: { "group-1-write": 2 },
			beforeAttempt: async (name, attempt) => {
				if (name !== "group-1-write") return;
				if (attempt === 1) {
					turnAsRead = await turnValue();
					await db
						.prepare(
							"CREATE TRIGGER fail_log BEFORE INSERT ON ai_log BEGIN SELECT RAISE(ABORT, 'nope'); END",
						)
						.run();
				}
			},
		});
		const fetchImpl = vi.fn(async () => reply(0.9));
		try {
			const done = await sortGroups(withKey, fake.runStep, fetchImpl, {
				rulesApplied: true,
				onlyIds: ids,
				runId: "run-never-saved",
				waitForTurn: true,
			});
			expect(attemptsOf(fake, "group-1-write")).toBe(3);
			expect(
				fake.steps.find((step) => step.name === "group-1-write")?.config,
			).toEqual(WRITE);
			expect(done).toEqual({ asked: 0, applied: 0 });
			expect(errors.mock.calls.map((call) => call.join(" "))).toEqual([
				"sorting: save step Error",
			]);
			expect(fake.names()).not.toContain("group-2-read");
			expect(await logged(ids)).toBe(0);
			for (const id of ids) expect(await categoryOf(id as number)).toBeNull();
			// The save never gave the calls back, so they stay counted for the day (decision 143).
			expect(await callsUsed()).toBe(3);
			// Each failed batch rolled its take back, so the turn is as the read left it.
			expect(turnAsRead).not.toBeNull();
			expect(await turnValue()).toBe(turnAsRead);
		} finally {
			await db.prepare("DROP TRIGGER fail_log").run();
		}
	});

	it("the save is tried about once a minute for up to a day, and no second save step follows it", async () => {
		const ids = await addWaiting(1);
		const fake = fakeSteps();
		await sortGroups(
			withKey,
			fake.runStep,
			vi.fn(async () => reply(0.9)),
			{
				rulesApplied: true,
				onlyIds: ids,
				runId: "run-config",
			},
		);
		expect(
			fake.steps.find((step) => step.name === "group-1-write")?.config,
		).toEqual(WRITE);
		expect(fake.names().some((name) => name.includes("save-again"))).toBe(
			false,
		);
	});

	it.each([
		["the save", { replayAfter: ["group-1-write"] }],
		[
			"a save that was tried again",
			{ throws: { "group-1-write": 2 }, replayAfter: ["group-1-write"] },
		],
	])(
		"replaying %s after it went through changes nothing: one log row, the unused calls given back once, the details as the first save left them, the record gone",
		async (_label, replay) => {
			await saveAiSwitches(db, { details: true });
			const ids = await addWaiting(3);
			let afterFirstSave: Awaited<ReturnType<typeof detailsOf>> | undefined;
			const fake = fakeSteps({
				...replay,
				// The second row's ask times out, so two calls are used and one is given back.
				beforeAttempt: async (name) => {
					if (name === `group-1-ask-${ids[1]}`) throw new Error("timeout");
				},
			});
			const runStep = (async (name, config, fn) =>
				fake.runStep(name, config, async (ctx) => {
					const result = await fn(ctx);
					// Read as the first save returns, before any replay of it runs.
					if (name === "group-1-write" && afterFirstSave === undefined)
						afterFirstSave = await detailsOf(ids);
					return result;
				})) as StepRunner;
			await sortGroups(
				withKey,
				runStep,
				vi.fn(async () => replyWithDetails("person:1")),
				{
					rulesApplied: true,
					onlyIds: ids,
					runId: "run-replay",
				},
			);
			expect(await logged(ids)).toBe(1);
			expect(await callsUsed()).toBe(2);
			expect(await recordOf("run-replay:1")).toBeNull();
			expect(await turnRow()).toBeNull();
			// The answered row's details were saved once: asked, Jev's kind and who it's for.
			expect(afterFirstSave?.find((row) => row.id === ids[2])).toEqual({
				id: ids[2],
				detailsAsked: 1,
				kind: "one_off",
				forPersonId: 1,
			});
			expect(await detailsOf(ids)).toEqual(afterFirstSave);
		},
	);

	it("a replay after another group took the turn returns without throwing and saves nothing", async () => {
		const ids = await addWaiting(3);
		const fake = fakeSteps();
		const runStep = (async (name, config, fn) => {
			const result = await fake.runStep(name, config, fn);
			if (name === "group-1-write") {
				// Another group takes the turn once this save has committed; the replay must leave it alone.
				await db
					.prepare(
						"INSERT INTO household_settings (key, value) VALUES ('sorting_turn', ?)",
					)
					.bind(JSON.stringify({ id: "other:1", until: Date.now() + 60_000 }))
					.run();
				await fn({ attempt: 2 });
			}
			return result;
		}) as StepRunner;
		await expect(
			sortGroups(
				withKey,
				runStep,
				vi.fn(async () => reply(0.9)),
				{
					rulesApplied: true,
					onlyIds: ids,
					runId: "run-busy-replay",
				},
			),
		).resolves.toEqual({ asked: 3, applied: 3 });
		expect(await logged(ids)).toBe(3);
		expect(JSON.parse((await turnValue()) ?? "{}").id).toBe("other:1");
	});

	it("a save that finds another group holding the turn waits, then takes the turn back and saves", async () => {
		const ids = await addWaiting(3);
		const fake = fakeSteps({
			beforeAttempt: async (name, attempt) => {
				if (name !== "group-1-write") return;
				if (attempt === 1)
					await db
						.prepare(
							"UPDATE household_settings SET value = ? WHERE key = 'sorting_turn'",
						)
						.bind(JSON.stringify({ id: "other:1", until: Date.now() + 60_000 }))
						.run();
				if (attempt === 2)
					await db
						.prepare(
							"DELETE FROM household_settings WHERE key = 'sorting_turn'",
						)
						.run();
			},
		});
		const done = await sortGroups(
			withKey,
			fake.runStep,
			vi.fn(async () => reply(0.9)),
			{
				rulesApplied: true,
				onlyIds: ids,
				runId: "run-turn-wait",
			},
		);
		expect(attemptsOf(fake, "group-1-write")).toBe(2);
		expect(done).toEqual({ asked: 3, applied: 3 });
		expect(await logged(ids)).toBe(3);
		expect(await turnRow()).toBeNull();
	});

	it("a save batch that fails rolls its take back, so the turn is left as the group had it", async () => {
		const ids = await addWaiting(3);
		const expired = JSON.stringify({ id: "run-rollback:1", until: 0 });
		const fake = fakeSteps({
			limits: { "group-1-write": 2 },
			beforeAttempt: async (name, attempt) => {
				if (name === "group-1-write" && attempt === 1) {
					// The turn ran out between the read and the save. A save that fails must not extend it.
					await changeRow(
						"UPDATE household_settings SET value = ? WHERE key = 'sorting_turn'",
						expired,
					);
					await db
						.prepare(
							"CREATE TRIGGER fail_log BEFORE INSERT ON ai_log BEGIN SELECT RAISE(ABORT, 'nope'); END",
						)
						.run();
				}
			},
		});
		try {
			await sortGroups(
				withKey,
				fake.runStep,
				vi.fn(async () => reply(0.9)),
				{
					rulesApplied: true,
					onlyIds: ids,
					runId: "run-rollback",
					// Not in-process: the turn is left as the batch left it, not released.
					waitForTurn: true,
				},
			);
			expect(await turnValue()).toBe(expired);
			expect(await takeSortingTurn(db, "other:1")).toBe(true);
			expect(await logged(ids)).toBe(0);
			for (const id of ids) expect(await categoryOf(id as number)).toBeNull();
		} finally {
			await db.prepare("DROP TRIGGER fail_log").run();
		}
	});

	it("a person's category set between a failed save and its next try wins", async () => {
		const ids = await addWaiting(3);
		const personal = (
			await db
				.prepare(
					"SELECT id FROM categories WHERE archived = 0 ORDER BY sort_order DESC LIMIT 1",
				)
				.first<{ id: number }>()
		)?.id as number;
		const fake = fakeSteps({
			throws: { "group-1-write": 1 },
			beforeAttempt: async (name, attempt) => {
				if (name === "group-1-write" && attempt === 2)
					await changeRow(
						"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
						personal,
						ids[1],
					);
			},
		});
		const done = await sortGroups(
			withKey,
			fake.runStep,
			vi.fn(async () => reply(0.9)),
			{
				rulesApplied: true,
				onlyIds: ids,
				runId: "run-person",
			},
		);
		expect(await categoryOf(ids[1] as number)).toBe(personal);
		expect(await logged([ids[1] as number])).toBe(0);
		expect(done.asked).toBe(3);
	});

	it("a save on the next household day dates its log rows with that day and gives back to the read's day", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-22T15:00:00Z"));
		const ids = await addWaiting(2);
		const fake = fakeSteps({
			throws: { "group-1-write": 1 },
			beforeAttempt: async (name, attempt) => {
				if (name === "group-1-write" && attempt === 2)
					vi.setSystemTime(new Date("2026-09-23T15:00:00Z"));
			},
		});
		const done = await sortGroups(
			withKey,
			fake.runStep,
			vi.fn(async () => reply(0.9)),
			{
				rulesApplied: true,
				onlyIds: ids,
				runId: "run-next-day",
			},
		);
		expect(done).toEqual({ asked: 2, applied: 2 });
		const days = await db
			.prepare(
				"SELECT DISTINCT household_day AS d FROM ai_log WHERE transaction_id IN (SELECT value FROM json_each(?))",
			)
			.bind(JSON.stringify(ids))
			.all<{ d: string }>();
		expect(days.results.map((row) => row.d)).toEqual(["2026-09-23"]);
		expect(await countText("2026-09-22")).toBe("2");
		expect(await countText("2026-09-23")).toBeNull();
	});
});

describe("a changed row keeps no answer (decision 143)", () => {
	const CHANGES: [string, string][] = [
		[
			"bank text",
			"UPDATE transactions SET raw_name = 'CHANGED TEXT' WHERE id = ?",
		],
		["own name", "UPDATE transactions SET own_name = 'Mine' WHERE id = ?"],
		[
			"merchant key",
			"UPDATE transactions SET merchant_name = 'Other Store' WHERE id = ?",
		],
		[
			"merchant name",
			"INSERT INTO merchants (raw_name, display_name) VALUES ('SORT STEP 1', 'Named store') ON CONFLICT(raw_name) DO UPDATE SET display_name = 'Named store'",
		],
		[
			"amount",
			"UPDATE transactions SET amount_cents = amount_cents - 1 WHERE id = ?",
		],
		["account", "UPDATE transactions SET account_id = 2 WHERE id = ?"],
		[
			"Plaid category",
			"UPDATE transactions SET plaid_category = 'FOOD_AND_DRINK' WHERE id = ?",
		],
		["note", "UPDATE transactions SET note = 'A new note' WHERE id = ?"],
		["kind", "UPDATE transactions SET kind = 'one_off' WHERE id = ?"],
		["who it's for", "UPDATE transactions SET for_person_id = 1 WHERE id = ?"],
		// The bank-name suggestion Jev is told when a row has no name of its own or a chosen merchant name.
		[
			"suggested name",
			"INSERT INTO merchants (raw_name, suggested_name) VALUES ('SORT STEP 1', '[\"Corner shop\"]') ON CONFLICT(raw_name) DO UPDATE SET suggested_name = excluded.suggested_name",
		],
		[
			"suggestion status",
			"INSERT INTO merchants (raw_name, suggestion_status) VALUES ('SORT STEP 1', 'pending') ON CONFLICT(raw_name) DO UPDATE SET suggestion_status = excluded.suggestion_status",
		],
	];

	it.each(CHANGES)(
		"a row whose %s changed after the read keeps no answer, and the rest of the group is saved",
		async (_label, sql) => {
			const ids = await addWaiting(3);
			const target = ids[1] as number;
			const fake = fakeSteps({
				beforeAttempt: async (name, attempt) => {
					if (name === "group-1-write" && attempt === 1)
						await changeRow(
							sql,
							...(sql.includes("WHERE id = ?") ? [target] : []),
						);
				},
			});
			const fetchImpl = vi.fn(async () => reply(0.9));
			const done = await sortGroups(withKey, fake.runStep, fetchImpl, {
				rulesApplied: true,
				onlyIds: ids,
				runId: "run-changed",
			});
			expect(fetchImpl).toHaveBeenCalledTimes(3);
			expect(await categoryOf(target)).toBeNull();
			expect(await logged([target])).toBe(0);
			expect(await categoryOf(ids[0] as number)).not.toBeNull();
			expect(await categoryOf(ids[2] as number)).not.toBeNull();
			expect(done).toEqual({ asked: 3, applied: 2 });
			expect(await callsUsed()).toBe(3);
		},
	);

	it("a credit a person reviewed, asked only for its category, keeps no answer once its note changed", async () => {
		const ids = await addWaiting(3);
		const credit = ids[2] as number;
		await changeRow(
			"UPDATE transactions SET amount_cents = -1200, income_source = 'user', credit_reviewed = 1, credit_reviewed_by = 'user' WHERE id = ?",
			credit,
		);
		const fake = fakeSteps({
			beforeAttempt: async (name, attempt) => {
				if (name === "group-1-write" && attempt === 1)
					await changeRow(
						"UPDATE transactions SET note = 'Changed note' WHERE id = ?",
						credit,
					);
			},
		});
		const done = await sortGroups(
			withKey,
			fake.runStep,
			vi.fn(async () => reply(0.9)),
			{
				rulesApplied: true,
				onlyIds: ids,
				runId: "run-credit",
			},
		);
		expect(await categoryOf(credit)).toBeNull();
		expect(await logged([credit])).toBe(0);
		expect(done).toEqual({ asked: 3, applied: 2 });
	});

	it("a split part keeps no answer once its parent's own name changed", async () => {
		const parent = (await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, is_split, own_name) VALUES (1, ?, -1000, 'SPLIT STEP PARENT', 1, 'Parent name') RETURNING id",
			)
			.bind(TODAY)
			.first<{ id: number }>()) as { id: number };
		const part = (await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, parent_id) VALUES (1, ?, -400, 'SPLIT STEP PARENT', ?) RETURNING id",
			)
			.bind(TODAY, parent.id)
			.first<{ id: number }>()) as { id: number };
		const fake = fakeSteps({
			beforeAttempt: async (name, attempt) => {
				if (name === "group-1-write" && attempt === 1)
					await changeRow(
						"UPDATE transactions SET own_name = 'Changed parent' WHERE id = ?",
						parent.id,
					);
			},
		});
		const fetchImpl = vi.fn(async () => reply(0.9));
		await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			onlyIds: [part.id],
			runId: "run-split",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(await categoryOf(part.id)).toBeNull();
		expect(await logged([part.id])).toBe(0);
	});

	it("a row whose kind changed keeps its details waiting too", async () => {
		await saveAiSwitches(db, { details: true });
		const ids = await addWaiting(3);
		const target = ids[1] as number;
		const fake = fakeSteps({
			beforeAttempt: async (name, attempt) => {
				if (name === "group-1-write" && attempt === 1)
					await changeRow(
						"UPDATE transactions SET kind = 'one_off' WHERE id = ?",
						target,
					);
			},
		});
		await sortGroups(
			withKey,
			fake.runStep,
			vi.fn(async () => replyWithDetails()),
			{
				rulesApplied: true,
				onlyIds: ids,
				runId: "run-details",
			},
		);
		const detailsAsked = async (id: number) =>
			(
				await db
					.prepare("SELECT details_asked AS d FROM transactions WHERE id = ?")
					.bind(id)
					.first<{ d: number }>()
			)?.d;
		expect(await detailsAsked(target)).toBe(0);
		expect(await detailsAsked(ids[0] as number)).toBe(1);
		expect(await categoryOf(target)).toBeNull();
	});

	it("a plan cached before this deploy, with no seen fields, saves as it always did", async () => {
		const ids = await addWaiting(3);
		const fake = fakeSteps();
		const runStep = (async (name, config, fn) =>
			fake.runStep(name, config, async (ctx) => {
				const result = await fn(ctx);
				const read = result as unknown as {
					kind?: string;
					plan?: { rows: { seen?: unknown }[] };
				};
				if (name === "group-1-read" && read.kind === "group")
					for (const row of read.plan?.rows ?? []) delete row.seen;
				return result;
			})) as StepRunner;
		const done = await sortGroups(
			withKey,
			runStep,
			vi.fn(async () => reply(0.9)),
			{
				rulesApplied: true,
				onlyIds: ids,
				runId: "run-no-seen",
			},
		);
		expect(done).toEqual({ asked: 3, applied: 3 });
		expect(await logged(ids)).toBe(3);
	});

	it("a plan cached before this deploy, with no seen fields, also saves its details as it always did", async () => {
		await saveAiSwitches(db, { details: true });
		const ids = await addWaiting(3);
		const fake = fakeSteps();
		const runStep = (async (name, config, fn) =>
			fake.runStep(name, config, async (ctx) => {
				const result = await fn(ctx);
				const read = result as unknown as {
					kind?: string;
					plan?: { rows: { seen?: unknown }[] };
				};
				if (name === "group-1-read" && read.kind === "group")
					for (const row of read.plan?.rows ?? []) delete row.seen;
				return result;
			})) as StepRunner;
		await sortGroups(
			withKey,
			runStep,
			vi.fn(async () => replyWithDetails()),
			{
				rulesApplied: true,
				onlyIds: ids,
				runId: "run-no-seen-details",
			},
		);
		const asked = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE id IN (SELECT value FROM json_each(?)) AND details_asked = 1",
			)
			.bind(JSON.stringify(ids))
			.first<{ n: number }>();
		expect(asked?.n).toBe(3);
	});

	it("Jev's request carries only what it was always told, never the seen fields", async () => {
		const ids = await addWaiting(2);
		const bodies: string[] = [];
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			bodies.push(String(init?.body));
			return reply(0.9);
		});
		await sortGroups(withKey, fakeSteps().runStep, fetchImpl, {
			rulesApplied: true,
			onlyIds: ids,
			runId: "run-body",
		});
		expect(bodies).toHaveLength(2);
		for (const body of bodies) {
			expect(body).not.toContain("seen");
			expect(body).not.toContain("merchantKey");
		}
	});
});

type Answer = { choice: string; confidence: number; also?: string };

/** A Jev reply with a category answer, and the other category it names when `also` is given (the mixed trip, #233). */
const answerReply = ({ choice, confidence, also }: Answer) =>
	new Response(
		JSON.stringify({
			answers: {
				category: { type: "choice", choice, confidence },
				...(also
					? {
							mixed: { type: "noul", noul: 0.9 },
							also_category: { type: "choice", choice: also, confidence: 0.9 },
						}
					: {}),
				transfer: { type: "noul", noul: 0.01 },
				reimbursement: { type: "noul", noul: 0.01 },
				income: { type: "noul", noul: 0.01 },
			},
		}),
		{ status: 200 },
	);

describe("a category archived since the read keeps no answer (decision 143)", () => {
	/** Jev's answer for the row whose bank text is `bank`, and `others` for every other row. */
	const perRow = (bank: string, answer: Answer, others: Answer) =>
		vi.fn(async (_url: string, init?: RequestInit) => {
			const sent = JSON.parse(String(init?.body)) as {
				state: { bank_description: string };
			};
			return answerReply(
				sent.state.bank_description === bank ? answer : others,
			);
		});

	/** What Jev's answer stored on a row: its suggested category and its category confidence (null when none). */
	const storedAnswer = (id: number) =>
		db
			.prepare(
				"SELECT jev_category_id AS suggested, category_confidence AS confidence FROM transactions WHERE id = ?",
			)
			.bind(id)
			.first<{ suggested: number | null; confidence: number | null }>();

	const GROCERIES: Answer = { choice: "Groceries", confidence: 0.9 };
	// The row whose answer names the archived category is the second one (bank text "SORT STEP 1"); the others name
	// Groceries, which stays active.
	const CASES: [string, Answer, string][] = [
		[
			"Jev's chosen category",
			{ choice: "Eating Out", confidence: 0.9 },
			"Eating Out",
		],
		[
			"Jev's suggestion",
			{ choice: "Eating Out", confidence: 0.3 },
			"Eating Out",
		],
		[
			"Jev's also category",
			{ choice: "Groceries", confidence: 0.9, also: "Eating Out" },
			"Eating Out",
		],
	];

	it.each(CASES)(
		"a row whose answer names %s, archived between the read and the save, keeps no answer and no log row, and the rest of the group is saved",
		async (_label, answer, archived) => {
			const ids = await addWaiting(3);
			const target = ids[1] as number;
			const fake = fakeSteps({
				beforeAttempt: async (name, attempt) => {
					if (name === "group-1-write" && attempt === 1)
						await changeRow(
							"UPDATE categories SET archived = 1 WHERE name = ?",
							archived,
						);
				},
			});
			const done = await sortGroups(
				withKey,
				fake.runStep,
				perRow("SORT STEP 1", answer, GROCERIES),
				{ rulesApplied: true, onlyIds: ids, runId: "run-archived" },
			);
			expect(done).toEqual({ asked: 3, applied: 2 });
			expect(await categoryOf(target)).toBeNull();
			expect(await storedAnswer(target)).toEqual({
				suggested: null,
				confidence: null,
			});
			expect(await logged([target])).toBe(0);
			expect(await categoryOf(ids[0] as number)).not.toBeNull();
			expect(await categoryOf(ids[2] as number)).not.toBeNull();
			expect(await logged([ids[0] as number, ids[2] as number])).toBe(2);
			expect(await callsUsed()).toBe(3);
		},
	);

	it("a credit asked only for its category keeps no answer when its category was archived since the read", async () => {
		const ids = await addWaiting(3);
		const credit = ids[2] as number;
		await changeRow(
			"UPDATE transactions SET amount_cents = -1200, income_source = 'user', credit_reviewed = 1, credit_reviewed_by = 'user' WHERE id = ?",
			credit,
		);
		const fake = fakeSteps({
			beforeAttempt: async (name, attempt) => {
				if (name === "group-1-write" && attempt === 1)
					await changeRow(
						"UPDATE categories SET archived = 1 WHERE name = 'Eating Out'",
					);
			},
		});
		const done = await sortGroups(
			withKey,
			fake.runStep,
			perRow(
				"SORT STEP 2",
				{ choice: "Eating Out", confidence: 0.9 },
				GROCERIES,
			),
			{ rulesApplied: true, onlyIds: ids, runId: "run-archived-credit" },
		);
		expect(await categoryOf(credit)).toBeNull();
		expect(await logged([credit])).toBe(0);
		expect(done).toEqual({ asked: 3, applied: 2 });
	});

	it("a category archived and restored before the save still applies", async () => {
		const ids = await addWaiting(3);
		const fake = fakeSteps({
			beforeAttempt: async (name, attempt) => {
				if (name === "group-1-write" && attempt === 1) {
					await changeRow(
						"UPDATE categories SET archived = 1 WHERE name = 'Eating Out'",
					);
					await changeRow(
						"UPDATE categories SET archived = 0 WHERE name = 'Eating Out'",
					);
				}
			},
		});
		const done = await sortGroups(
			withKey,
			fake.runStep,
			vi.fn(async () => reply(0.9)),
			{ rulesApplied: true, onlyIds: ids, runId: "run-restored" },
		);
		expect(done).toEqual({ asked: 3, applied: 3 });
		for (const id of ids) expect(await categoryOf(id as number)).not.toBeNull();
		expect(await logged(ids)).toBe(3);
	});
});

describe("the reservation record (decision 143)", () => {
	it("a reserve that throws before its batch reserves normally when it runs again", async () => {
		const ids = await addWaiting(3);
		const fake = fakeSteps({ throws: { "group-1-reserve": 1 } });
		const done = await sortGroups(
			withKey,
			fake.runStep,
			vi.fn(async () => reply(0.9)),
			{
				rulesApplied: true,
				onlyIds: ids,
				runId: "run-reserve-throw",
			},
		);
		expect(
			fake.steps.find((step) => step.name === "group-1-reserve")?.attempts,
		).toBe(2);
		expect(done).toEqual({ asked: 3, applied: 3 });
		expect(await callsUsed()).toBe(3);
	});

	it("a reserve that rejected after its batch gives its calls back at the save, and never writes NULL", async () => {
		const ids = await addWaiting(3);
		const day = await householdToday(db);
		// What the reserve's batch wrote before the step rejected: the day's three calls and their record.
		await db.batch([
			db
				.prepare("INSERT INTO household_settings (key, value) VALUES (?, '3')")
				.bind(`jev_calls_${day}`),
			db
				.prepare("INSERT INTO household_settings (key, value) VALUES (?, '3')")
				.bind(`jev_reserved_${day}_run-kept:1`),
		]);
		const fake = fakeSteps({ fails: ["group-1-reserve"] });
		const fetchImpl = vi.fn(async () => reply(0.9));
		await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			onlyIds: ids,
			runId: "run-kept",
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(await countText(day)).toBe("0");
		expect(await recordOf("run-kept:1")).toBeNull();
	});

	it("the save removes the group's record once it has given the calls back", async () => {
		const ids = await addWaiting(3);
		await sortGroups(
			withKey,
			fakeSteps().runStep,
			vi.fn(async () => reply(0.9)),
			{
				rulesApplied: true,
				onlyIds: ids,
				runId: "run-record-gone",
			},
		);
		expect(await recordOf("run-record-gone:1")).toBeNull();
		expect(await callsUsed()).toBe(3);
	});
});

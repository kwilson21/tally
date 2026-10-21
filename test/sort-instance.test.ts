import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { markStroke, readFirstTally } from "../src/db/first-tally";
import { resetDemo } from "../src/demo/reset";
import { recordNightSync } from "../src/first-tally/night";
import type { SyncAllResult } from "../src/plaid/sync-all";
import {
	INSTANCE_MAX_CALLS,
	instanceSortOptions,
	runSortInstance,
} from "../src/sort-instance";
import type { SortParams } from "../src/sort-start";
import { fakeSteps } from "./fake-sort-steps";

// What one sorting instance does (sort-instance.ts), run through its fake step runner: the sorting groups, then the
// night's steps for the 09:00 run's instance (decision 139).

const db = env.DB;
const TODAY = "2026-09-22";
const NIGHT = "2026-10-13";

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await db
		.prepare(
			"DELETE FROM household_settings WHERE key = 'sorting_turn' OR key GLOB 'jev_calls_*'",
		)
		.run();
	await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, details: false });
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** What Jev answers: nothing sure, so a call asked costs its queries and changes no category. */
const jevAnswer = () =>
	Response.json({
		answers: {
			category: { type: "choice", choice: "Eating Out", confidence: 0.5 },
			transfer: { type: "noul", noul: 0.01 },
			reimbursement: { type: "noul", noul: 0.01 },
			income: { type: "noul", noul: 0.01 },
		},
	});

/** A fake Workers AI: a category question gets `Subscriptions`, a bank text a place name. `order` hears each kind. */
const aiThatHears = (order: string[] = []) =>
	({
		run: vi.fn(async (_model: string, input: unknown) => {
			const user = (
				input as { messages: { role: string; content: string }[] }
			).messages.find((m) => m.role === "user")?.content;
			const kind = user?.startsWith("Places:") ? "categories" : "names";
			order.push(kind);
			return {
				response: kind === "categories" ? "Subscriptions" : "Some Place Name",
			};
		}),
	}) as unknown as Ai & { run: ReturnType<typeof vi.fn> };

/** Clears what the night would ask about, then adds one unsorted, unnamed charge per name (each from a store of its own). */
async function onlyCharges(names: string[]) {
	await db.batch([
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM merchants"),
		db.prepare("DELETE FROM merchant_name_failures"),
		db.prepare("DELETE FROM category_suggestions"),
	]);
	if (names.length === 0) return;
	await db.batch(
		names.map((raw) =>
			db
				.prepare(
					"INSERT INTO transactions(account_id,date,amount_cents,raw_name) VALUES(1,?,-500,?)",
				)
				.bind(TODAY, raw),
		),
	);
}

/** Three confident "none of these fit" transactions of one theme: enough for one new category suggestion. */
const addNoneFit = (theme: string) =>
	db
		.prepare(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3)
			 INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, plaid_category, category_confidence, jev_none_fit)
			 SELECT 1, '2026-09-20', 1500, 'STREAM ' || i || ?, 'Stream ' || char(64 + i) || ?, ?, 0.95, 1 FROM n`,
		)
		.bind(theme, theme, theme)
		.run();

/** Runs one instance in this process: fake steps, a fresh turn name, and the given Jev fetch and clock. */
async function runInstance(
	instanceEnv: Parameters<typeof runSortInstance>[0],
	params: SortParams,
	options: {
		fails?: string[];
		replayAfter?: string[];
		fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
		now?: () => number;
	} = {},
) {
	const steps = fakeSteps({
		fails: options.fails,
		replayAfter: options.replayAfter,
	});
	await runSortInstance(instanceEnv, steps.runStep, params, {
		runId: crypto.randomUUID(),
		fetchImpl: options.fetchImpl,
		now: options.now,
	});
	return steps;
}

const night = { bySync: false, rulesApplied: false, night: NIGHT };

describe("the night's instance, in production", () => {
	it("sorts first, then names, then new-category suggestions, then keeps the counts, each a step of its own", async () => {
		await onlyCharges(["SHOP A", "SHOP B"]);
		const order: string[] = [];
		const fetchImpl = vi.fn(async () => jevAnswer());
		const ai = aiThatHears(order);

		const steps = await runInstance(
			{ DB: db, JEV_API_KEY: "jev", DEMO: "false", AI: ai },
			night,
			{ fetchImpl },
		);

		const names = steps.names();
		expect(names[0]).toBe("rules");
		expect(names.slice(-3)).toEqual([
			"night-names",
			"night-suggestions",
			"night-counts",
		]);
		// The names are made after the group's write, so Jev's answers are saved first.
		expect(names.indexOf("group-1-write")).toBeLessThan(
			names.indexOf("night-names"),
		);
		expect(order[0]).toBe("names");
	});

	it("in the demo, makes the same steps without the counts", async () => {
		await onlyCharges(["SHOP A"]);
		const steps = await runInstance(
			{ DB: db, JEV_API_KEY: "jev", DEMO: "true", AI: aiThatHears() },
			night,
			{ fetchImpl: vi.fn(async () => jevAnswer()) },
		);
		expect(steps.names().slice(-2)).toEqual([
			"night-names",
			"night-suggestions",
		]);
		expect(steps.names()).not.toContain("night-counts");
	});

	it("a daytime instance has no night step and asks Workers AI nothing", async () => {
		await onlyCharges(["SHOP A"]);
		const ai = aiThatHears();
		const steps = await runInstance(
			{ DB: db, JEV_API_KEY: "jev", DEMO: "false", AI: ai },
			{ bySync: false, rulesApplied: false },
			{ fetchImpl: vi.fn(async () => jevAnswer()) },
		);
		expect(steps.names().filter((name) => name.startsWith("night-"))).toEqual(
			[],
		);
		expect(ai.run).not.toHaveBeenCalled();
	});

	it("gives the names and suggestions no retries and a 15-minute timeout, and the counts retries with a 10-second delay", async () => {
		await onlyCharges(["SHOP A"]);
		const steps = await runInstance(
			{ DB: db, DEMO: "false", AI: aiThatHears() },
			night,
		);
		const config = (name: string) =>
			steps.steps.find((step) => step.name === name)?.config;
		expect(config("night-names")).toEqual({
			retries: { limit: 0, delay: 0 },
			timeout: "15 minutes",
			sensitive: "output",
		});
		expect(config("night-suggestions")).toEqual({
			retries: { limit: 0, delay: 0 },
			timeout: "15 minutes",
			sensitive: "output",
		});
		expect(config("night-counts")).toEqual({
			retries: { limit: 4, delay: "10 seconds", backoff: "constant" },
			timeout: "1 minute",
			sensitive: "output",
		});
	});
});

describe("a failing step never stops the next", () => {
	it("a names step that fails logs its name, and the suggestions and counts still run", async () => {
		await onlyCharges(["SHOP A"]);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const steps = await runInstance(
			{ DB: db, DEMO: "false", AI: aiThatHears() },
			night,
			{ fails: ["night-names"] },
		);
		expect(errors.mock.calls.map((call) => call.join(" "))).toEqual([
			"workers-ai: names step failed Error",
		]);
		expect(steps.names()).toEqual(
			expect.arrayContaining(["night-suggestions", "night-counts"]),
		);
	});

	it("a suggestions step that fails logs its name, and the counts still run", async () => {
		await onlyCharges(["SHOP A"]);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const steps = await runInstance(
			{ DB: db, DEMO: "false", AI: aiThatHears() },
			night,
			{ fails: ["night-suggestions"] },
		);
		expect(errors.mock.calls.map((call) => call.join(" "))).toEqual([
			"workers-ai: category suggestions step failed Error",
		]);
		expect(steps.names().at(-1)).toBe("night-counts");
	});

	it("a sort that stops still lets all three night steps run, logging only its name", async () => {
		await onlyCharges(["SHOP A"]);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const steps = await runInstance(
			{ DB: db, JEV_API_KEY: "jev", DEMO: "false", AI: aiThatHears() },
			night,
			{ fails: ["group-1-read"], fetchImpl: vi.fn(async () => jevAnswer()) },
		);
		expect(errors.mock.calls.map((call) => call.join(" "))).toEqual([
			"sorting: stopped Error",
		]);
		expect(steps.names()).toEqual(
			expect.arrayContaining([
				"night-names",
				"night-suggestions",
				"night-counts",
			]),
		);
	});

	it("a save that fails every try logs its name only, and the night's steps still run", async () => {
		await onlyCharges(["SHOP A"]);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const steps = await runInstance(
			{ DB: db, JEV_API_KEY: "jev", DEMO: "false", AI: aiThatHears() },
			night,
			{
				fails: ["group-1-write"],
				fetchImpl: vi.fn(async () => jevAnswer()),
			},
		);
		expect(errors.mock.calls.map((call) => call.join(" "))).toEqual([
			"sorting: save step Error",
		]);
		expect(steps.names()).toEqual(
			expect.arrayContaining([
				"night-names",
				"night-suggestions",
				"night-counts",
			]),
		);
	});

	it("a counts step that fails logs its name and the instance resolves", async () => {
		await onlyCharges(["SHOP A"]);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			runInstance({ DB: db, DEMO: "false", AI: aiThatHears() }, night, {
				fails: ["night-counts"],
			}),
		).resolves.toBeDefined();
		expect(errors.mock.calls.map((call) => call.join(" "))).toEqual([
			"first night: counts step failed Error",
		]);
	});

	it("no log line holds a bank text", async () => {
		await onlyCharges(["SECRET SHOP TEXT"]);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		await runInstance({ DB: db, DEMO: "false", AI: aiThatHears() }, night, {
			fails: ["night-names", "group-1-read"],
		});
		expect(JSON.stringify(errors.mock.calls)).not.toContain("SECRET");
	});
});

describe("no step asks Workers AI twice when it runs again", () => {
	it("a names step that runs again asks each bank text once", async () => {
		await onlyCharges(["SHOP A", "SHOP B", "SHOP C"]);
		const ai = aiThatHears();
		await runInstance({ DB: db, DEMO: "false", AI: ai }, night, {
			replayAfter: ["night-names"],
		});
		expect(ai.run).toHaveBeenCalledTimes(3);
	});

	it("a suggestions step that runs again asks for each group once", async () => {
		await onlyCharges([]);
		await addNoneFit("ENTERTAINMENT");
		const order: string[] = [];
		await runInstance(
			{ DB: db, DEMO: "false", AI: aiThatHears(order) },
			night,
			{
				replayAfter: ["night-suggestions"],
			},
		);
		expect(order.filter((kind) => kind === "categories")).toHaveLength(1);
	});
});

describe("no Jev key", () => {
	it("the night's names, suggestions and counts still run, with no sort, no Jev call and no rules step", async () => {
		await onlyCharges(["SHOP A"]);
		const fetchImpl = vi.fn(async () => jevAnswer());
		const steps = await runInstance(
			{ DB: db, DEMO: "false", AI: aiThatHears() },
			night,
			{ fetchImpl },
		);
		expect(steps.names()).toEqual([
			"night-names",
			"night-suggestions",
			"night-counts",
		]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("each step's budget counts from its own start", () => {
	it("the names stop starting requests 13 minutes after their step began, and the suggestions get their own 13", async () => {
		await onlyCharges(["SHOP A", "SHOP B", "SHOP C", "SHOP D", "SHOP E"]);
		await addNoneFit("ENTERTAINMENT");
		// Each Workers AI request takes five minutes: names start at 0, 5 and 10, and a fourth would start at 15.
		let t = 0;
		const order: string[] = [];
		const ai = {
			run: vi.fn(async (_model: string, input: unknown) => {
				const user = (
					input as { messages: { role: string; content: string }[] }
				).messages.find((m) => m.role === "user")?.content;
				order.push(user?.startsWith("Places:") ? "categories" : "names");
				t += 5 * 60_000;
				return {
					response: user?.startsWith("Places:")
						? "Subscriptions"
						: "Some Place Name",
				};
			}),
		} as unknown as Ai & { run: ReturnType<typeof vi.fn> };

		await runInstance({ DB: db, DEMO: "false", AI: ai }, night, {
			now: () => t,
		});

		// The names' three, then the suggestions' one at 15 minutes, inside their own 28-minute deadline.
		expect(order).toEqual(["names", "names", "names", "categories"]);
	});
});

describe("one instance asks Jev at most INSTANCE_MAX_CALLS (decision 146)", () => {
	it("gives the instance's sort the 5,000 cap, so one instance stays under Workflows' 10,000 steps", () => {
		expect(INSTANCE_MAX_CALLS).toBe(5000);
		// The options sortGroups receives from every instance: the cap is among them, so removing it fails here.
		expect(
			instanceSortOptions(
				{ bySync: false, rulesApplied: false },
				{ runId: "run" },
			),
		).toMatchObject({ maxCalls: INSTANCE_MAX_CALLS, waitForTurn: true });
	});

	it("gives the night's instance the same cap", () => {
		expect(
			instanceSortOptions(
				{ bySync: false, rulesApplied: false, night: NIGHT },
				{ runId: "run" },
			).maxCalls,
		).toBe(INSTANCE_MAX_CALLS);
	});
});

describe("the counts step keeps the night named by params.night", () => {
	async function answeredNight() {
		await db
			.prepare("DELETE FROM household_settings WHERE key = 'first_tally'")
			.run();
		for (const stroke of ["bank", "pay", "bills", "budgets"] as const) {
			await markStroke(db, stroke, "2026-10-12");
		}
		await onlyCharges(["SHOP A", "SHOP B"]);
		await saveAiSwitches(db, {
			names: false,
			details: false,
			categories: false,
			income: false,
			sortOnArrival: false,
		});
		const synced = {
			added: 2,
			modified: 0,
			changedIds: [],
			synced: 1,
			skipped: 0,
			busy: 0,
			failed: 0,
			failedBanks: [],
		} as SyncAllResult;
		await recordNightSync(db, synced, NIGHT);
	}

	it("keeps the counts of the night its sync was for", async () => {
		await answeredNight();
		await runInstance({ DB: db, DEMO: "false" }, night);
		expect((await readFirstTally(db))?.night).toEqual({
			brought: 2,
			needYou: 2,
		});
	});

	it("keeps nothing for a night another day", async () => {
		await answeredNight();
		await runInstance(
			{ DB: db, DEMO: "false" },
			{ bySync: false, rulesApplied: false, night: "2026-10-14" },
		);
		expect((await readFirstTally(db))?.night).toBeUndefined();
	});

	it("keeps the night once when its counts step runs again", async () => {
		await answeredNight();
		await runInstance({ DB: db, DEMO: "false" }, night, {
			replayAfter: ["night-counts"],
		});
		expect((await readFirstTally(db))?.night).toEqual({
			brought: 2,
			needYou: 2,
		});
	});
});

describe("runSortInstance passes its sleep to the sorting groups (decision 145)", () => {
	it("a 429 waits through the sleep it was given, then the rows are sorted", async () => {
		await onlyCharges(["SHOP A", "SHOP B"]);
		const ids = (
			await db
				.prepare("SELECT id FROM transactions ORDER BY id")
				.all<{ id: number }>()
		).results.map((row) => row.id);
		let call = 0;
		const fetchImpl = vi.fn(async () => {
			call += 1;
			return call === 1
				? new Response("{}", { status: 429, headers: { "retry-after": "5" } })
				: jevAnswer();
		});
		const sleep = vi.fn(async (_name: string, _ms: number) => {});
		const steps = fakeSteps();
		await runSortInstance(
			{ DB: db, JEV_API_KEY: "jev", DEMO: "false" },
			steps.runStep,
			{ ids, bySync: false, rulesApplied: true },
			{ runId: crypto.randomUUID(), fetchImpl, sleep },
		);
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(sleep).toHaveBeenCalledWith("wait-1", 30_000);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});
});

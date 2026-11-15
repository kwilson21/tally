import { describe, expect, it, vi } from "vitest";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import {
	claimNext,
	LOOKUP_RUN_LIMIT,
	LOOKUP_STEPS,
	saveClaimed,
	searchClaimed,
} from "../src/lookup/run";
import {
	DAY,
	dayCount,
	db,
	eligibleStore,
	fakeAi,
	fakeSearch,
	gateEnv,
	httpStatus,
	LINE,
	lookupRow,
	lookupRunSetup,
	MINUTE,
	makePrivate,
	NOON_MS,
	PARAMS,
	runInstance,
	STORE_NAMES,
	setDayCount,
	storeName,
	textOf,
} from "./lookup-run-setup";

// The store lookup's run (spec §7): one store at a time, claimed, searched and saved by its own steps, through the sorting
// instance with fake steps. Every test names its rule or its brief number in its title.

const T = (i: number) => textOf(storeName(i));

lookupRunSetup();

describe("the run, through the sorting instance", () => {
	it("with no eligible store, nothing is searched and the first claim is empty", async () => {
		const search = fakeSearch([]);
		const ai = fakeAi([]);

		const steps = await runInstance({ search, ai: ai.ai });

		expect(search.queries).toEqual([]);
		expect(ai.stores).toEqual([]);
		expect(steps.names()).toContain("lookup-1-claim");
		expect(steps.names()).not.toContain("lookup-2-claim");
	});

	// 1. happyPath (rule 1).
	it("1. happyPath: one fetch and one line; the row is found, with its line and a count of 1", async () => {
		await eligibleStore(storeName(0));

		const search = fakeSearch([T(0)]);
		const ai = fakeAi([T(0)]);

		await runInstance({ search, ai: ai.ai });

		expect(search.queries).toEqual([T(0)]);
		expect(ai.stores).toEqual([T(0)]);

		const row = await lookupRow(T(0));

		expect(row).toMatchObject({
			status: "found",
			line: LINE,
			attempts: 0,
			claimedBy: null,
		});
		expect(row?.lookedUpAt).not.toBeNull();
		expect(await dayCount()).toBe(1);
	});

	// 2. A private store is never fetched (rule 1), two cases.
	it("2a. a private store with a cleared row is never fetched and becomes skipped", async () => {
		await eligibleStore(storeName(0));
		await makePrivate(storeName(0));

		const search = fakeSearch([]);
		const ai = fakeAi([]);

		await runInstance({ search, ai: ai.ai });

		expect(search.queries).toEqual([]);
		expect(await lookupRow(T(0))).toMatchObject({
			status: "skipped",
			line: null,
		});
	});

	it("2b. a found store that is then flagged becomes skipped, its line dropped, with no fetch", async () => {
		await eligibleStore(storeName(0));

		await runInstance({
			search: fakeSearch([T(0)]),
			ai: fakeAi([T(0)]).ai,
			runId: "run-1",
		});

		expect(await lookupRow(T(0))).toMatchObject({
			status: "found",
			line: LINE,
		});

		await makePrivate(storeName(0));

		const search = fakeSearch([]);

		await runInstance({ search, ai: fakeAi([]).ai, runId: "run-2" });

		expect(search.queries).toEqual([]);
		expect(await lookupRow(T(0))).toMatchObject({
			status: "skipped",
			line: null,
		});
	});

	// 3. onlyQualifiedSummarized (rule 2).
	it("3. a row flagged inside the search: no line is asked for; the claim is let go; the next run skips it", async () => {
		await eligibleStore(storeName(0));

		const search = fakeSearch([T(0)], async (query) => {
			if (query === T(0)) await makePrivate(storeName(0));

			return undefined;
		});

		const ai = fakeAi([]);

		await runInstance({ search, ai: ai.ai });

		// The line is never asked for. The same run's next claim read sees the store private and skips it (exit row 10),
		// so the store is not left waiting to be tried again.
		expect(ai.stores).toEqual([]);
		expect(search.queries).toEqual([T(0)]);
		expect(await lookupRow(T(0))).toMatchObject({
			status: "skipped",
			attempts: 0,
			claimedBy: null,
			line: null,
		});

		const again = fakeSearch([]);

		await runInstance({ search: again, ai: fakeAi([]).ai, runId: "run-2" });

		expect(again.queries).toEqual([]);
		expect(await lookupRow(T(0))).toMatchObject({ status: "skipped" });
	});

	// 4. switchOffBeforeSummary (BUG_NO_SUMMARY_CHECK).
	it.each([
		["Look up new stores on the web", "lookupStores"],
		["Guess categories", "categories"],
		["Spot paychecks", "income"],
	] as const)(
		"4. the switch %s turned off inside the search: no line; pending, let go, attempts 0",
		async (_label, key) => {
			await eligibleStore(storeName(0));

			const search = fakeSearch([T(0)], async () => {
				await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, [key]: false });

				return undefined;
			});

			const ai = fakeAi([]);

			await runInstance({ search, ai: ai.ai });

			expect(ai.stores).toEqual([]);
			expect(await lookupRow(T(0))).toMatchObject({
				status: "pending",
				attempts: 0,
				claimedBy: null,
			});
		},
	);

	// 5. arrivalAfterClaim (BUG_NO_FINAL_CHECK).
	it("5. a waiting row arriving after the claim: no search, attempts 0, let go, count 1", async () => {
		await eligibleStore(storeName(0));

		const search = fakeSearch([]);

		await runInstance({
			search,
			ai: fakeAi([]).ai,
			steps: {
				beforeAttempt: async (name) => {
					if (name !== "lookup-1-search") return;

					// A new row of the same store, not yet categorized: Jev has not been asked about it.
					await db
						.prepare(
							"INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, plaid_category) VALUES (1, ?, -900, ?, 'arrival-1', 'FOOD_AND_DRINK')",
						)
						.bind(DAY, storeName(0))
						.run();
				},
			},
		});

		expect(search.queries).toEqual([]);
		expect(await lookupRow(T(0))).toMatchObject({
			status: "pending",
			attempts: 0,
			claimedBy: null,
		});
		expect(await dayCount()).toBe(1);
	});

	// 6. capHolds (rule 3).
	it("6. the cap holds: at 298 two stores are fetched, the two oldest; the third has no row and no search", async () => {
		for (const name of STORE_NAMES.slice(0, 3)) await eligibleStore(name);

		await setDayCount(298);

		const search = fakeSearch([T(0), T(1), T(2)]);

		const steps = await runInstance({
			search,
			ai: fakeAi([T(0), T(1), T(2)]).ai,
		});

		expect(search.queries).toEqual([T(0), T(1)]);
		expect(await dayCount()).toBe(300);
		expect(await lookupRow(T(2))).toBeNull();
		expect(steps.names()).not.toContain("lookup-3-search");
	});

	// 7. capCountsEverySearch (BUG_CAP_FROM_ROWS).
	it("7. the cap counts every search, not the rows: a save that fails still spent its count", async () => {
		await eligibleStore(storeName(0));
		await setDayCount(298);

		const search = fakeSearch([T(0)]);
		const ai = fakeAi([T(0)]).ai;

		await runInstance({ search, ai, steps: { fails: ["lookup-1-save"] } });
		vi.setSystemTime(NOON_MS + 16 * MINUTE);
		await runInstance({
			search,
			ai,
			runId: "run-2",
			steps: { fails: ["lookup-1-save"] },
		});
		vi.setSystemTime(NOON_MS + 32 * MINUTE);

		const third = await runInstance({ search, ai, runId: "run-3" });

		expect(search.queries).toHaveLength(2);
		expect(third.names()).not.toContain("lookup-1-search");
		expect(await dayCount()).toBe(300);
	});

	// 8. oneOwner (rule 4).
	it("8. one owner: a second run, started inside the first run's search, takes no search", async () => {
		await eligibleStore(storeName(0));

		const search = fakeSearch([T(0)]);
		const ai = fakeAi([T(0)]).ai;
		const secondNames: string[] = [];

		await runInstance({
			search,
			ai,
			steps: {
				beforeAttempt: async (name, attempt) => {
					if (name === "lookup-1-search" && attempt === 1) {
						const second = await runInstance({ search, ai, runId: "run-B" });

						secondNames.push(...second.names());
					}
				},
			},
		});

		expect(search.queries).toEqual([T(0)]);
		expect(await dayCount()).toBe(1);
		expect(secondNames).toContain("lookup-1-claim");
		expect(secondNames).not.toContain("lookup-1-search");
	});

	// 9. lateSaveAfterReclaim (rule 5).
	it("9. a late save after a re-claim saves nothing: the row stays with the other run's claim, and the count is 2", async () => {
		await eligibleStore(storeName(0));

		const search = fakeSearch([T(0)]);
		const ai = fakeAi([T(0)]).ai;

		await runInstance({
			search,
			ai,
			steps: {
				beforeAttempt: async (name) => {
					if (name !== "lookup-1-save") return;

					vi.setSystemTime(NOON_MS + 16 * MINUTE);
					await claimNext(gateEnv(ai), { token: "B", bySync: false });
				},
			},
		});

		expect(await lookupRow(T(0))).toMatchObject({
			status: "pending",
			claimedBy: "B",
			line: null,
		});
		expect(await dayCount()).toBe(2);
	});

	// 10. BUG_NO_CLAIM.
	it.each([
		["another token holds it", { claimedBy: "other", claimedAgo: 1 }],
		["there is no row", null],
		["its own token, lease run out", { claimedBy: "tok", claimedAgo: 16 }],
	] as const)(
		"10. the search refuses a claim the row does not hold (%s): claim-lost, no fetch",
		async (_label, hold) => {
			await eligibleStore(storeName(0));

			if (hold) {
				await db
					.prepare(
						"INSERT INTO merchant_lookups (lookup_text, status, attempts, claimed_by, claimed_at) VALUES (?, 'pending', 0, ?, ?)",
					)
					.bind(
						T(0),
						hold.claimedBy,
						new Date(NOON_MS - hold.claimedAgo * MINUTE).toISOString(),
					)
					.run();
			}

			const search = fakeSearch([]);
			const ai = fakeAi([]);

			const outcome = await searchClaimed(
				gateEnv(ai.ai),
				{
					text: T(0),
					attempts: 0,
					token: "tok",
					day: DAY,
					timeZone: "America/New_York",
				},
				search.fetch,
				{ attempt: 1 },
			);

			expect(outcome).toEqual({ kind: "claim-lost" });
			expect(search.queries).toEqual([]);
		},
	);

	// The day changes (Limits).
	it("11. the day changes before the search: no fetch, the claim let go, no second claim, the old day's count is 1", async () => {
		await eligibleStore(storeName(0));
		await eligibleStore(storeName(1));

		const search = fakeSearch([T(0), T(1)]);

		const steps = await runInstance({
			search,
			ai: fakeAi([T(0), T(1)]).ai,
			steps: {
				beforeAttempt: async (name) => {
					if (name === "lookup-1-search")
						vi.setSystemTime(NOON_MS + 24 * 60 * MINUTE);
				},
			},
		});

		expect(search.queries).toEqual([]);
		expect(steps.names()).not.toContain("lookup-2-claim");
		expect(await lookupRow(T(0))).toMatchObject({
			status: "pending",
			claimedBy: null,
		});
		expect(await dayCount(DAY)).toBe(1);
		expect(await dayCount("2026-11-16")).toBe(0);
	});

	// 12. The run's three.
	it("12a. 500, 500, 500 with four stores: the run stops after the third; no fourth claim; stores 1-3 at attempts 1", async () => {
		for (const name of STORE_NAMES.slice(0, 4)) await eligibleStore(name);

		const steps = await runInstance({
			search: fakeSearch([], () => httpStatus(500)),
			ai: fakeAi([]).ai,
		});

		expect(steps.names()).not.toContain("lookup-4-claim");

		for (const i of [0, 1, 2]) {
			expect(await lookupRow(T(i))).toMatchObject({
				status: "pending",
				attempts: 1,
			});
		}

		expect(await lookupRow(T(3))).toBeNull();
	});

	it("12b. a 429 first: the run stops at once; no second claim", async () => {
		for (const name of STORE_NAMES.slice(0, 2)) await eligibleStore(name);

		const steps = await runInstance({
			search: fakeSearch([], (_q, call) =>
				call === 1 ? httpStatus(429) : undefined,
			),
			ai: fakeAi([]).ai,
		});

		expect(steps.names()).not.toContain("lookup-2-claim");
		expect(await lookupRow(T(0))).toMatchObject({
			status: "pending",
			attempts: 1,
		});
	});

	it("12c. 500, 500, found, 500, 500: all five are fetched, since a found store resets the failures", async () => {
		for (const name of STORE_NAMES.slice(0, 5)) await eligibleStore(name);

		const search = fakeSearch(
			STORE_NAMES.slice(0, 5).map(textOf),
			(_q, call) =>
				call === 1 || call === 2 || call === 4 || call === 5
					? httpStatus(500)
					: undefined,
		);

		await runInstance({
			search,
			ai: fakeAi(STORE_NAMES.slice(0, 5).map(textOf)).ai,
		});

		expect(search.queries).toHaveLength(5);
		expect(await lookupRow(T(2))).toMatchObject({ status: "found" });
	});

	// 13. The store's three.
	it("13a. a store at attempts 2 whose search fails becomes gave_up at 3 and is never fetched again", async () => {
		await eligibleStore(storeName(0));
		await db
			.prepare(
				"INSERT INTO merchant_lookups (lookup_text, status, attempts) VALUES (?, 'pending', 2)",
			)
			.bind(T(0))
			.run();

		const first = fakeSearch([], () => httpStatus(500));

		await runInstance({ search: first, ai: fakeAi([]).ai });

		expect(await lookupRow(T(0))).toMatchObject({
			status: "gave_up",
			attempts: 3,
		});

		const later = fakeSearch([]);

		await runInstance({ search: later, ai: fakeAi([]).ai, runId: "run-2" });

		expect(later.queries).toEqual([]);
	});

	it("13b. a store at attempts 1 whose search fails becomes pending at 2", async () => {
		await eligibleStore(storeName(0));
		await db
			.prepare(
				"INSERT INTO merchant_lookups (lookup_text, status, attempts) VALUES (?, 'pending', 1)",
			)
			.bind(T(0))
			.run();

		await runInstance({
			search: fakeSearch([], () => httpStatus(500)),
			ai: fakeAi([]).ai,
		});

		expect(await lookupRow(T(0))).toMatchObject({
			status: "pending",
			attempts: 2,
		});
	});

	// 14. Oldest first, 10 a run.
	it("14. oldest first, 10 a run: twelve stores; the first run takes the ten oldest in order, the next run the other two", async () => {
		const names = [...STORE_NAMES];

		for (const name of names) await eligibleStore(name);

		const all = names.map(textOf);
		const search = fakeSearch(all);
		const ai = fakeAi(all).ai;

		await runInstance({ search, ai });

		expect(search.queries).toEqual(all.slice(0, LOOKUP_RUN_LIMIT));

		await runInstance({ search, ai, runId: "run-2" });

		expect(search.queries).toEqual(all);
	});

	// 15. When it runs (every row of the table).
	it.each([
		[
			"sortGroups threw",
			{ env: { JEV_API_KEY: "jev" }, steps: { fails: ["rules"] }, ids: true },
			false,
		],
		["the lookup switch is off", { switchOff: "lookupStores" }, true],
		["no AI binding", { env: { AI: undefined } }, false],
		["no Tavily key", { env: { TAVILY_API_KEY: undefined } }, false],
		["the demo (cap 0)", { env: { DEMO: "true" } }, false],
		[
			"a sync with Sort right away off",
			{
				params: { bySync: true, rulesApplied: false, ids: [] },
				sortOnArrival: false,
			},
			true,
		],
		[
			"the privacy re-ask threw",
			{ env: { JEV_API_KEY: "jev" }, steps: { fails: ["lookup-reask-read"] } },
			true,
		],
	] as const)("15. when it runs: %s", async (_label, option, present) => {
		await eligibleStore(storeName(0));

		// SAFETY: option is one of the cases in the table above, and this type states each case's fields.
		const opt = option as {
			env?: {
				DEMO?: string;
				JEV_API_KEY?: string;
				TAVILY_API_KEY?: string;
				AI?: undefined;
			};
			steps?: { fails?: string[] };
			switchOff?: "lookupStores";
			params?: { bySync: boolean; rulesApplied: boolean; ids: number[] };
			sortOnArrival?: boolean;
			ids?: boolean;
		};

		if (opt.switchOff) {
			await saveAiSwitches(db, {
				...AI_SWITCHES_ALL_ON,
				[opt.switchOff]: false,
			});
		}

		if (opt.sortOnArrival === false) {
			await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, sortOnArrival: false });
		}

		const ai = opt.env && "AI" in opt.env ? undefined : fakeAi([T(0)]).ai;

		const ids = opt.ids
			? [
					Number(
						(
							await db
								.prepare("SELECT id FROM transactions ORDER BY id LIMIT 1")
								.first<{ id: number }>()
						)?.id,
					),
				]
			: [];

		const steps = await runInstance({
			search: fakeSearch([T(0)]),
			// SAFETY: a case that has no AI binding passes none, so the step list is the one with no lookup step.
			ai: ai as Ai,
			env: opt.env,
			steps: opt.steps,
			params: opt.params ?? { bySync: false, rulesApplied: false, ids },
		});

		const names = steps.names();

		expect(names.includes("lookup-run-texts")).toBe(present);
		expect(names.includes("lookup-1-claim")).toBe(present);
	});

	it("15b. a re-sort instance runs its lookup after reask-finish, and before the night's names", async () => {
		await eligibleStore(storeName(0));

		const steps = await runInstance({
			search: fakeSearch([T(0)]),
			ai: fakeAi([T(0)], undefined, { nightNames: true }).ai,
			params: {
				bySync: false,
				rulesApplied: false,
				ids: [],
				reask: { runId: "resort-1", ids: [], clusters: [] },
				night: DAY,
			},
		});

		const names = steps.names();

		expect(names.indexOf("reask-finish")).toBeLessThan(
			names.indexOf("lookup-run-texts"),
		);
		expect(names.indexOf("lookup-1-claim")).toBeGreaterThan(
			names.indexOf("reask-finish"),
		);
		expect(names.indexOf("night-names")).toBeGreaterThan(
			names.indexOf("lookup-1-save"),
		);
	});

	// 16. Steps.
	it("16a. step names: every lookup step is lookup-run-texts or lookup-<k>-claim|search|save, and none carries a text", async () => {
		await eligibleStore(storeName(0));

		const steps = await runInstance({
			search: fakeSearch([T(0)]),
			ai: fakeAi([T(0)]).ai,
		});

		const lookupSteps = steps
			.names()
			.filter((name) => name.startsWith("lookup-") && name !== "lookup-texts");

		expect(lookupSteps.length).toBeGreaterThan(0);

		for (const name of lookupSteps) {
			expect(name).toMatch(/^lookup-(run-texts|\d+-(claim|search|save))$/);
			expect(name.includes("alder")).toBe(false);
		}
	});

	it("16b. step configs equal LOOKUP_STEPS, and the run-texts step keeps the fill's D1 settings", async () => {
		await eligibleStore(storeName(0));

		const steps = await runInstance({
			search: fakeSearch([T(0)]),
			ai: fakeAi([T(0)]).ai,
		});

		const configOf = (name: string) =>
			steps.steps.find((step) => step.name === name)?.config;

		expect(configOf("lookup-1-claim")).toEqual(LOOKUP_STEPS.claim);
		expect(configOf("lookup-1-search")).toEqual(LOOKUP_STEPS.search);
		expect(configOf("lookup-1-save")).toEqual(LOOKUP_STEPS.save);
		expect(configOf("lookup-run-texts")).toEqual({
			retries: { limit: 4, delay: "10 seconds", backoff: "constant" },
			timeout: "1 minute",
			sensitive: "output",
		});
	});

	it("16c. lookup-run-texts comes after the last re-ask step and before lookup-1-claim", async () => {
		await eligibleStore(storeName(0));

		const steps = await runInstance({
			search: fakeSearch([T(0)]),
			ai: fakeAi([T(0)]).ai,
			env: { JEV_API_KEY: "jev" },
		});

		const names = steps.names();

		const lastReask = names.reduce(
			(last, name, i) => (name.startsWith("lookup-reask-") ? i : last),
			-1,
		);

		expect(lastReask).toBeGreaterThanOrEqual(0);
		expect(names.indexOf("lookup-run-texts")).toBeGreaterThan(lastReask);
		expect(names.indexOf("lookup-1-claim")).toBeGreaterThan(
			names.indexOf("lookup-run-texts"),
		);
	});

	it("16d. night-names comes after the last lookup step", async () => {
		await eligibleStore(storeName(0));

		const steps = await runInstance({
			search: fakeSearch([T(0)]),
			ai: fakeAi([T(0)], undefined, { nightNames: true }).ai,
			params: { ...PARAMS, night: DAY },
		});

		const names = steps.names();

		const lastLookup = names.reduce(
			(last, name, i) => (name.startsWith("lookup-") ? i : last),
			-1,
		);

		expect(names.indexOf("night-names")).toBeGreaterThan(lastLookup);
	});

	it("16e. during the search, the row is claimed by the run's token: <runId>:lookup:1", async () => {
		await eligibleStore(storeName(0));

		let during: string | null = null;

		await runInstance({
			search: fakeSearch([T(0)]),
			ai: fakeAi([T(0)]).ai,
			steps: {
				beforeAttempt: async (name) => {
					if (name === "lookup-1-search")
						during = (await lookupRow(T(0)))?.claimedBy ?? null;
				},
			},
		});

		expect(during).toBe("run-1:lookup:1");
	});

	// 17. Replay.
	it("17a. replayAfter the claim step: the count is 1", async () => {
		await eligibleStore(storeName(0));

		await runInstance({
			search: fakeSearch([T(0)]),
			ai: fakeAi([T(0)]).ai,
			steps: { replayAfter: ["lookup-1-claim"] },
		});

		expect(await dayCount()).toBe(1);
		expect(await lookupRow(T(0))).toMatchObject({ status: "found" });
	});

	it("17b. replayAfter the search step: one fetch", async () => {
		await eligibleStore(storeName(0));

		const search = fakeSearch([T(0)]);

		await runInstance({
			search,
			ai: fakeAi([T(0)]).ai,
			steps: { replayAfter: ["lookup-1-search"] },
		});

		expect(search.queries).toEqual([T(0)]);
	});

	const SEARCH_STEP_FAILURES: {
		label: string;
		steps: { throws?: Record<string, number>; fails?: string[] };
	}[] = [
		{ label: "throws", steps: { throws: { "lookup-1-search": 1 } } },
		{ label: "fails", steps: { fails: ["lookup-1-search"] } },
	];

	it.each(
		SEARCH_STEP_FAILURES.map(
			(failure) => [failure.label, failure.steps] as const,
		),
	)(
		"17c. the search step %s: no fetch, released, the run stops",
		async (_label, steps) => {
			await eligibleStore(storeName(0));
			await eligibleStore(storeName(1));

			const search = fakeSearch([T(0), T(1)]);

			const run = await runInstance({
				search,
				ai: fakeAi([T(0), T(1)]).ai,
				steps: { ...steps },
			});

			expect(search.queries).toEqual([]);
			expect(await lookupRow(T(0))).toMatchObject({
				status: "pending",
				attempts: 0,
				claimedBy: null,
			});
			expect(run.names()).not.toContain("lookup-2-claim");
		},
	);

	it("17d. replayAfter the save step: nothing changes", async () => {
		await eligibleStore(storeName(0));

		const search = fakeSearch([T(0)]);

		await runInstance({
			search,
			ai: fakeAi([T(0)]).ai,
			steps: { replayAfter: ["lookup-1-save"] },
		});

		expect(search.queries).toEqual([T(0)]);
		expect(await lookupRow(T(0))).toMatchObject({
			status: "found",
			line: LINE,
		});
		expect(await dayCount()).toBe(1);
	});

	it("17e. fails on the save step: the claim stays with token 1, and the night steps still run", async () => {
		await eligibleStore(storeName(0));

		const run = await runInstance({
			search: fakeSearch([T(0)]),
			ai: fakeAi([T(0)], undefined, { nightNames: true }).ai,
			params: { ...PARAMS, night: DAY },
			steps: { fails: ["lookup-1-save"] },
		});

		expect(await lookupRow(T(0))).toMatchObject({
			status: "pending",
			claimedBy: "run-1:lookup:1",
		});
		expect(run.names()).toContain("night-names");
	});

	// 18. Logging.
	it("18. nothing logged carries the text, the query, a result's title or content, or the line", async () => {
		const logged: string[] = [];

		// SAFETY: level is one of the three console methods named in this list, each of which vi.spyOn can replace.
		const spies = ["log", "warn", "error"].map((level) =>
			vi
				.spyOn(console, level as "log")
				.mockImplementation((...args: unknown[]) => {
					logged.push(args.map(String).join(" "));
				}),
		);

		try {
			for (const name of STORE_NAMES.slice(0, 3)) await eligibleStore(name);

			await runInstance({
				search: fakeSearch(STORE_NAMES.slice(0, 3).map(textOf), (query) => {
					if (query === T(1)) return httpStatus(500);

					return undefined;
				}),
				ai: fakeAi([T(0), T(2)], (store) =>
					store === T(2) ? new Error("boom") : undefined,
				).ai,
			});
		} finally {
			for (const spy of spies) spy.mockRestore();
		}

		const leaked = logged.filter((line) =>
			[
				T(0),
				T(1),
				T(2),
				storeName(0),
				"A title",
				"A short description",
				LINE,
			].some((secret) => line.includes(secret)),
		);

		expect(leaked).toEqual([]);
	});
});

describe("the claim and the day (rule 6 and the replayed claim)", () => {
	it("a replayed claim step after midnight returns the claim with yesterday's day, and its search returns date-changed with no fetch", async () => {
		await eligibleStore(storeName(0));

		const ai = fakeAi([]).ai;
		const env = gateEnv(ai);

		// 23:55 on DAY in New York: the claim is dated DAY.
		vi.setSystemTime(Date.parse("2026-11-16T04:55:00.000Z"));

		const first = await claimNext(env, {
			token: "run-1:lookup:1",
			bySync: false,
		});

		expect(first).toMatchObject({ text: T(0), day: DAY });

		// 00:05 the next day, the lease still running: the replay finds its own claim.
		vi.setSystemTime(Date.parse("2026-11-16T05:05:00.000Z"));

		const replay = await claimNext(env, {
			token: "run-1:lookup:1",
			bySync: false,
		});

		expect(replay).toMatchObject({ text: T(0), day: DAY });

		if (replay === null) throw new Error("the replayed claim returned nothing");

		const search = fakeSearch([]);

		const outcome = await searchClaimed(env, replay, search.fetch, {
			attempt: 1,
		});

		expect(outcome).toEqual({ kind: "date-changed" });
		expect(search.queries).toEqual([]);
	});
});

describe("the run's own functions", () => {
	it("LOOKUP_RUN_LIMIT is 10", () => {
		expect(LOOKUP_RUN_LIMIT).toBe(10);
	});

	it("saveClaimed of a lost outcome lets the claim go and saves nothing", async () => {
		await eligibleStore(storeName(0));

		const env = gateEnv(fakeAi([]).ai);

		const claim = await claimNext(env, {
			token: "run-1:lookup:1",
			bySync: false,
		});

		expect(claim).not.toBeNull();

		// SAFETY: the expectation above fails the test unless claim is a claim, so it is not null here.
		const saved = await saveClaimed(env, claim as NonNullable<typeof claim>, {
			kind: "lost",
		});

		expect(saved).toEqual({ saved: false });
		expect(await lookupRow(T(0))).toMatchObject({
			status: "pending",
			claimedBy: null,
		});
	});
});

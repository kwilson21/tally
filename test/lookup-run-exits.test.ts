import { describe, expect, it, vi } from "vitest";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { claimNext, saveClaimed, searchClaimed } from "../src/lookup/run";
import {
	type AiPlan,
	addRow,
	dayCount,
	db,
	eligibleStore,
	fakeAi,
	fakeSearch,
	httpStatus,
	LINE,
	lookupRow,
	lookupRunSetup,
	MINUTE,
	makePrivate,
	NOON_MS,
	noResults,
	runInstance,
	type SearchPlan,
	setDayCount,
	storeName,
	textOf,
} from "./lookup-run-setup";

// The exit table (the brief's table of every way one store's try ends), one row per exit. S1 is the oldest store and takes
// the planted exit; S2 is an ordinary store. Each row asserts S1's calls, the day's count, S1's row, and whether S2 was
// searched. Each row's title names the mutation it would catch.

const S1 = textOf(storeName(0));
const S2 = textOf(storeName(1));
const N1 = storeName(0);
const N2 = storeName(1);

lookupRunSetup();

/** Makes both stores eligible (S1 the oldest). */
async function bothEligible() {
	await eligibleStore(N1);
	await eligibleStore(N2);
}

/** Puts S1's lookup row in a state a crashed or another run left it in. */
async function holdS1(
	claimedBy: string | null,
	claimedAgo: number | null,
	attempts = 0,
) {
	await db
		.prepare(
			"INSERT INTO merchant_lookups (lookup_text, status, attempts, claimed_by, claimed_at) VALUES (?, 'pending', ?, ?, ?)",
		)
		.bind(
			S1,
			attempts,
			claimedBy,
			claimedAgo === null
				? null
				: new Date(NOON_MS - claimedAgo * MINUTE).toISOString(),
		)
		.run();
}

/** Writes S1's lookup row as another run left it, claimed now. */
async function claimS1For(token: string) {
	await db
		.prepare(
			"UPDATE merchant_lookups SET claimed_by = ?, claimed_at = ? WHERE lookup_text = ?",
		)
		.bind(token, new Date(NOON_MS).toISOString(), S1)
		.run();
}

type Expect = {
	s1Fetched: boolean;
	s1Ai: boolean;
	s2Fetched: boolean;
	count: number;
	status: string | null;
	attempts?: number;
	claimedBy: string | null;
	line: string | null;
};

/** A write the database runs before the batch that follows it, armed by a step. */
type HookArm = { after: number; fn: () => Promise<void> };

/** The hook a test arms: its write runs before a later batch. A class, so its field keeps its type. */
class HookState {
	armed: HookArm | null = null;
}

type Row = {
	title: string;
	setup?: () => Promise<void>;
	search?: SearchPlan;
	ai?: AiPlan;
	steps?: { fails?: string[]; replayAfter?: string[] };
	/** Runs `fn` before the `after`-th batch that follows the arming step (the claim, or the save). */
	hook?: { at: string; after: number; fn: () => Promise<void> };
	/** Anything else before each step's attempt. */
	before?: (name: string, attempt: number) => Promise<void>;
	/** Called directly, not through the run, when the fake steps cannot reach the exit. */
	direct?: () => Promise<{
		s1Fetched: boolean;
		s1Ai: boolean;
		s2Fetched: boolean;
	}>;
	expect: Expect;
};

const ROWS: Row[] = [
	{
		title:
			"row 1, another run holds the store (live lease): its claim untouched, the run goes on",
		setup: async () => {
			await bothEligible();
			await holdS1("other", 1);
		},
		expect: {
			s1Fetched: false,
			s1Ai: false,
			s2Fetched: true,
			count: 1,
			status: "pending",
			attempts: 0,
			claimedBy: "other",
			line: null,
		},
	},
	{
		title:
			"row 2, the lease ran out (a crashed run): claimed again, found, the run goes on",
		setup: async () => {
			await bothEligible();
			await holdS1("crashed", 16);
		},
		expect: {
			s1Fetched: true,
			s1Ai: true,
			s2Fetched: true,
			count: 2,
			status: "found",
			attempts: 0,
			claimedBy: null,
			line: LINE,
		},
	},
	{
		title:
			"row 3, another run claimed it between this read and this batch (the batch's own guard lost): the run ends, nothing counted, mutation: the claim's guard dropped",
		setup: bothEligible,
		hook: {
			at: "lookup-1-claim",
			after: 1,
			fn: async () => {
				await db
					.prepare(
						"INSERT INTO merchant_lookups (lookup_text, status, attempts, claimed_by, claimed_at) VALUES (?, 'pending', 0, 'other', ?)",
					)
					.bind(S1, new Date(NOON_MS - MINUTE).toISOString())
					.run();
			},
		},
		expect: {
			s1Fetched: false,
			s1Ai: false,
			s2Fetched: false,
			count: 0,
			status: "pending",
			attempts: 0,
			claimedBy: "other",
			line: null,
		},
	},
	{
		title:
			"row 4, private at the claim read: skipped, the skip is saved, the run goes on; mutation: the skip dropped",
		setup: async () => {
			await bothEligible();
			await makePrivate(N1);
		},
		expect: {
			s1Fetched: false,
			s1Ai: false,
			s2Fetched: true,
			count: 1,
			status: "skipped",
			attempts: 0,
			claimedBy: null,
			line: null,
		},
	},
	{
		title:
			"row 5, not may_search at the claim read: no move, no row, the run goes on",
		setup: async () => {
			await addRow({ raw_name: N1 });
			await eligibleStore(N2);
		},
		expect: {
			s1Fetched: false,
			s1Ai: false,
			s2Fetched: true,
			count: 1,
			status: null,
			claimedBy: null,
			line: null,
		},
	},
	{
		title: "row 6, the day's count is used up: no move, the run ends",
		setup: async () => {
			await bothEligible();
			await setDayCount(300);
		},
		expect: {
			s1Fetched: false,
			s1Ai: false,
			s2Fetched: false,
			count: 300,
			status: null,
			claimedBy: null,
			line: null,
		},
	},
	{
		title:
			"row 7, the lookup switch off at the claim read: no move and no skips, the run ends; mutation: the switch read dropped",
		setup: async () => {
			await bothEligible();
			await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, lookupStores: false });
		},
		expect: {
			s1Fetched: false,
			s1Ai: false,
			s2Fetched: false,
			count: 0,
			status: null,
			claimedBy: null,
			line: null,
		},
	},
	{
		title:
			"row 8, the day changed before the search: no fetch, let go, the run stops; mutation: the day check dropped",
		setup: bothEligible,
		before: async (name) => {
			if (name === "lookup-1-search") {
				vi.setSystemTime(NOON_MS + 24 * 60 * MINUTE);
			}
		},
		expect: {
			s1Fetched: false,
			s1Ai: false,
			s2Fetched: false,
			count: 1,
			status: "pending",
			attempts: 0,
			claimedBy: null,
			line: null,
		},
	},
	{
		title:
			"row 9, claim lost before the search (another token holds it): no fetch, the run stops; mutation: the claim check dropped",
		setup: bothEligible,
		before: async (name) => {
			if (name === "lookup-1-search") await claimS1For("other");
		},
		expect: {
			s1Fetched: false,
			s1Ai: false,
			s2Fetched: false,
			count: 1,
			status: "pending",
			attempts: 0,
			claimedBy: "other",
			line: null,
		},
	},
	{
		title:
			"row 10, check before the search refuses (a new private row): let go, the next claim read skips it; mutation: the check before the search dropped",
		setup: bothEligible,
		before: async (name) => {
			if (name === "lookup-1-search") await makePrivate(N1);
		},
		expect: {
			s1Fetched: false,
			s1Ai: false,
			s2Fetched: true,
			count: 2,
			status: "skipped",
			attempts: 0,
			claimedBy: null,
			line: null,
		},
	},
	{
		title:
			"row 11, the fetch throws: counted as a failure (attempts 1), the run goes on",
		setup: bothEligible,
		search: (query) => {
			if (query === S1) throw new Error("timeout");

			return undefined;
		},
		expect: {
			s1Fetched: true,
			s1Ai: false,
			s2Fetched: true,
			count: 2,
			status: "pending",
			attempts: 1,
			claimedBy: null,
			line: null,
		},
	},
	{
		title: "row 12, Tavily 429: counted as a failure and the run stops",
		setup: bothEligible,
		search: (_query, call) => (call === 1 ? httpStatus(429) : undefined),
		expect: {
			s1Fetched: true,
			s1Ai: false,
			s2Fetched: false,
			count: 1,
			status: "pending",
			attempts: 1,
			claimedBy: null,
			line: null,
		},
	},
	{
		title: "row 13, another non-2xx: counted as a failure, the run goes on",
		setup: bothEligible,
		search: (_query, call) => (call === 1 ? httpStatus(500) : undefined),
		expect: {
			s1Fetched: true,
			s1Ai: false,
			s2Fetched: true,
			count: 2,
			status: "pending",
			attempts: 1,
			claimedBy: null,
			line: null,
		},
	},
	{
		title:
			"row 14, no results: nothing_found with no Workers AI call, the run goes on",
		setup: bothEligible,
		search: (query) => (query === S1 ? noResults(query) : undefined),
		expect: {
			s1Fetched: true,
			s1Ai: false,
			s2Fetched: true,
			count: 2,
			status: "nothing_found",
			attempts: 0,
			claimedBy: null,
			line: null,
		},
	},
	{
		title:
			"row 15, check before Workers AI refuses (a private row arrived during the search): let go; mutation: the check before Workers AI dropped",
		setup: bothEligible,
		search: async (query) => {
			if (query === S1) await makePrivate(N1);

			return undefined;
		},
		expect: {
			s1Fetched: true,
			s1Ai: false,
			s2Fetched: true,
			count: 2,
			status: "skipped",
			attempts: 0,
			claimedBy: null,
			line: null,
		},
	},
	{
		title:
			"row 16, claim lost before Workers AI (re-claimed during the search): no line, the run stops; mutation: the claim check before the line dropped",
		setup: bothEligible,
		search: async (query) => {
			if (query === S1) await claimS1For("other");

			return undefined;
		},
		expect: {
			s1Fetched: true,
			s1Ai: false,
			s2Fetched: false,
			count: 1,
			status: "pending",
			attempts: 0,
			claimedBy: "other",
			line: null,
		},
	},
	{
		title: "row 17, Workers AI throws: counted as a failure, the run goes on",
		setup: bothEligible,
		ai: (store) => (store === S1 ? new Error("ai down") : undefined),
		expect: {
			s1Fetched: true,
			s1Ai: true,
			s2Fetched: true,
			count: 2,
			status: "pending",
			attempts: 1,
			claimedBy: null,
			line: null,
		},
	},
	{
		title:
			'row 18, the line is cleaned to nothing ("nothing found"): nothing_found, the run goes on',
		setup: bothEligible,
		ai: (store) => (store === S1 ? "nothing found." : undefined),
		expect: {
			s1Fetched: true,
			s1Ai: true,
			s2Fetched: true,
			count: 2,
			status: "nothing_found",
			attempts: 0,
			claimedBy: null,
			line: null,
		},
	},
	{
		title: "row 19, a line and the save's test passes: found, with its line",
		setup: bothEligible,
		expect: {
			s1Fetched: true,
			s1Ai: true,
			s2Fetched: true,
			count: 2,
			status: "found",
			attempts: 0,
			claimedBy: null,
			line: LINE,
		},
	},
	{
		title:
			"row 20, the save's test refuses (a private row arrived during the line): let go, the next claim read skips it; mutation: the TypeScript check at the save dropped",
		setup: bothEligible,
		ai: async (store) => {
			if (store === S1) await makePrivate(N1);

			return undefined;
		},
		expect: {
			s1Fetched: true,
			s1Ai: true,
			s2Fetched: true,
			count: 2,
			status: "skipped",
			attempts: 0,
			claimedBy: null,
			line: null,
		},
	},
	{
		title:
			"row 20a, the store turned private between the save's read and its write: the save's private guard refuses; mutation: the guard dropped",
		setup: bothEligible,
		hook: {
			at: "lookup-1-save",
			after: 1,
			fn: async () => {
				await db
					.prepare(
						"INSERT INTO merchant_lookup_texts (merchant_key, lookup_text, private) VALUES ('hook-key', ?, 1)",
					)
					.bind(S1)
					.run();
			},
		},
		expect: {
			s1Fetched: true,
			s1Ai: true,
			s2Fetched: true,
			count: 2,
			status: "pending",
			attempts: 0,
			claimedBy: null,
			line: null,
		},
	},
	{
		title:
			"row 21, claim lost before the save (re-claimed after the lease): the other run's claim stands, nothing saved; mutation: the save's claim guard dropped",
		setup: bothEligible,
		ai: async (store) => {
			if (store !== S1) return undefined;

			vi.setSystemTime(NOON_MS + 16 * MINUTE);

			// SAFETY: claimNext reads its env and makes no Workers AI call, so the binding is never used.
			const env = {
				DB: db,
				DEMO: "false",
				TAVILY_API_KEY: "tvly",
				AI: {} as Ai,
			};

			await claimNext(env, { token: "B", bySync: false });

			return undefined;
		},
		expect: {
			s1Fetched: true,
			s1Ai: true,
			s2Fetched: true,
			count: 3,
			status: "pending",
			attempts: 0,
			claimedBy: "B",
			line: null,
		},
	},
	{
		title:
			"row 22, the search step replayed after its result was lost (attempt 2): no fetch, let go, the run stops; called directly",
		direct: async () => {
			await bothEligible();

			// SAFETY: claimNext and searchClaimed make no Workers AI call on this path, so the binding is never used.
			const env = {
				DB: db,
				DEMO: "false",
				TAVILY_API_KEY: "tvly",
				AI: {} as Ai,
			};

			const search = fakeSearch([S1, S2]);

			const claim = await claimNext(env, {
				token: "run-1:lookup:1",
				bySync: false,
			});

			if (claim === null) throw new Error("no claim");

			const outcome = await searchClaimed(env, claim, search.fetch, {
				attempt: 2,
			});

			expect(outcome).toEqual({ kind: "lost" });
			await saveClaimed(env, claim, outcome);

			return {
				s1Fetched: search.queries.includes(S1),
				s1Ai: false,
				s2Fetched: search.queries.includes(S2),
			};
		},
		expect: {
			s1Fetched: false,
			s1Ai: false,
			s2Fetched: false,
			count: 1,
			status: "pending",
			attempts: 0,
			claimedBy: null,
			line: null,
		},
	},
	{
		title:
			"row 23, the search step rejected (its timeout, or the runtime): let go, the run stops",
		setup: bothEligible,
		steps: { fails: ["lookup-1-search"] },
		expect: {
			s1Fetched: false,
			s1Ai: false,
			s2Fetched: false,
			count: 1,
			status: "pending",
			attempts: 0,
			claimedBy: null,
			line: null,
		},
	},
	{
		title:
			"row 24, the claim step replayed after its batch committed: its own claim is picked, no second take; mutation: the mine pick dropped",
		setup: bothEligible,
		steps: { replayAfter: ["lookup-1-claim"] },
		expect: {
			s1Fetched: true,
			s1Ai: true,
			s2Fetched: true,
			count: 2,
			status: "found",
			attempts: 0,
			claimedBy: null,
			line: LINE,
		},
	},
	{
		title:
			"row 25, the save step replayed after its batch committed: no move, the guards find nothing of ours",
		setup: bothEligible,
		steps: { replayAfter: ["lookup-1-save"] },
		expect: {
			s1Fetched: true,
			s1Ai: true,
			s2Fetched: true,
			count: 2,
			status: "found",
			attempts: 0,
			claimedBy: null,
			line: LINE,
		},
	},
	{
		title:
			"row 26, the save step fails after its tries: the claim stays and lapses after 15 minutes; the run stops",
		setup: bothEligible,
		steps: { fails: ["lookup-1-save"] },
		expect: {
			s1Fetched: true,
			s1Ai: true,
			s2Fetched: false,
			count: 1,
			status: "pending",
			attempts: 0,
			claimedBy: "run-1:lookup:1",
			line: null,
		},
	},
];

/**
 * A stand-in for the database that runs the armed write before the batch that follows it, once `after` batches have
 * passed. Only the two members the run reads are present: prepare (for single reads) and batch.
 */
function hookedDatabase(hook: HookState): D1Database {
	const batch = async (statements: D1PreparedStatement[]) => {
		const armed = hook.armed;

		if (armed) {
			if (armed.after === 0) {
				hook.armed = null;
				await armed.fn();
			} else {
				armed.after -= 1;
			}
		}

		return db.batch(statements);
	};

	const hooked = {
		prepare: (sql: string) => db.prepare(sql),
		batch,
	};

	// SAFETY: the run and its readers call only prepare and batch on the database, the two members provided above.
	return hooked as D1Database;
}

describe("the exit table: every way one store's try ends (19)", () => {
	it.each(ROWS.map((row) => [row.title, row] as const))(
		"%s",
		async (_title, row) => {
			await row.setup?.();

			if (row.direct) {
				const direct = await row.direct();

				expect(direct).toEqual({
					s1Fetched: row.expect.s1Fetched,
					s1Ai: row.expect.s1Ai,
					s2Fetched: row.expect.s2Fetched,
				});
			} else {
				const hook = new HookState();
				const search = fakeSearch([S1, S2], row.search);
				const ai = fakeAi([S1, S2], row.ai);

				await runInstance({
					search,
					ai: ai.ai,
					env: row.hook ? { DB: hookedDatabase(hook) } : undefined,
					steps: {
						...row.steps,
						beforeAttempt: async (name, attempt) => {
							if (row.hook && name === row.hook.at && attempt === 1) {
								hook.armed = { after: row.hook.after, fn: row.hook.fn };
							}

							await row.before?.(name, attempt);
						},
					},
				});

				expect(search.queries.includes(S1)).toBe(row.expect.s1Fetched);
				expect(ai.stores.includes(S1)).toBe(row.expect.s1Ai);
				expect(search.queries.includes(S2)).toBe(row.expect.s2Fetched);
			}

			expect(await dayCount()).toBe(row.expect.count);

			const stored = await lookupRow(S1);

			expect(stored?.status ?? null).toBe(row.expect.status);
			expect(stored?.claimedBy ?? null).toBe(row.expect.claimedBy);
			expect(stored?.line ?? null).toBe(row.expect.line);

			if (row.expect.attempts !== undefined) {
				expect(stored?.attempts ?? 0).toBe(row.expect.attempts);
			}

			// Rule 11, attemptsAreSearches: a store's failures never outnumber its searches.
			const searches = row.expect.s1Fetched ? 1 : 0;

			expect(stored?.attempts ?? 0).toBeLessThanOrEqual(searches);
		},
	);
});

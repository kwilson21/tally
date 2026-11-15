// The store lookup's run (spec §7, "When it runs" through "Limits"): up to LOOKUP_RUN_LIMIT stores, one at a time. For each, a
// claim step takes the store and one search from the day's count, a search step makes the whole test again, one Tavily
// search and one Workers AI line, and a save step saves the line (or a failure) only as the claim's owner and lets the claim
// go. Plain TypeScript, no Effect: the steps are run through the sorting instance's runner (sort-instance.ts). Nothing here
// logs a text, a query, a result or a line.

import { lineOnce, searchOnce } from "../ai/lookup-store";
import { householdTimeZone, todayIn } from "../dates";
import { readAiSwitches } from "../db/ai-switches";
import {
	claimStatements,
	failStatement,
	holdsClaim,
	letGoStatement,
	readLookup,
	readLookups,
	saveResultStatement,
	skipStatements,
} from "../db/store-lookups";
import type { SortEnv, StepConfig, StepRunner } from "../sort-groups";
import {
	claimPick,
	qualifies,
	runStops,
	type SaveMove,
	type SearchOutcome,
	saveMove,
} from "./claims";
import {
	eligibility,
	readEligibility,
	readEligibilityRows,
} from "./eligibility";
import { lookupAsks, storeLookupDailyCap } from "./gate";

/** Stores one run looks up at most (spec §7, "Store lookup"): oldest first, at most 10 a run. */
export const LOOKUP_RUN_LIMIT = 10;

/** The steps' settings. The search is the paid call, so it is never retried; claim and save are D1 writes, safe to retry. */
export const LOOKUP_STEPS = {
	claim: {
		retries: { limit: 4, delay: "10 seconds", backoff: "constant" },
		timeout: "1 minute",
		sensitive: "output",
	},
	search: {
		retries: { limit: 0, delay: 0 },
		timeout: "2 minutes",
		sensitive: "output",
	},
	save: {
		retries: { limit: 4, delay: "10 seconds", backoff: "constant" },
		timeout: "1 minute",
		sensitive: "output",
	},
} satisfies Record<string, StepConfig>;

/** The token a run's k-th claim is made under: one per store, so a replay finds its own claim (spec §7, rule 4). */
export const claimToken = (runId: string, k: number) => `${runId}:lookup:${k}`;

/** The env a run reads: the household's database, the gate's Tavily key and the Workers AI binding. */
export type LookupEnv = SortEnv & { AI: Ai; TAVILY_API_KEY: string };

/** A store a run has claimed: what its search needs, and the day the claim was taken on. Plain values, so a step can keep it. */
export type Claim = {
	text: string;
	attempts: number;
	token: string;
	day: string;
	timeZone: string;
};

/**
 * The claim step: takes the next store the run may search, and one search from the day's count, in one batch. A claim this
 * token already holds (a replay) is returned with no second take. `exclude` lists the stores this run already tried, so a
 * failed store waits for a later run rather than being searched again at once (the spec's "tried again on a later run").
 */
export async function claimNext(
	env: LookupEnv,
	{
		token,
		bySync,
		exclude = [],
	}: { token: string; bySync: boolean; exclude?: readonly string[] },
): Promise<Claim | null> {
	const db = env.DB;
	const nowMs = Date.now();
	const switches = await readAiSwitches(db);

	if (!lookupAsks(env, switches) || (bySync && !switches.sortOnArrival)) {
		return null;
	}

	const timeZone = await householdTimeZone(db);
	const rows = await readEligibilityRows(db);
	const lookups = await readLookups(db);

	const pick = claimPick({
		rows,
		decided: eligibility(rows),
		lookups,
		token,
		now: new Date(nowMs),
		exclude: new Set(exclude),
	});

	// A replayed claim is dated the day it was taken, so a replay after midnight never spends a count from the new day.
	const mine = pick.pick?.mine === true;
	const claimedAt = mine ? lookups.get(pick.pick?.text ?? "")?.claimedAt : null;

	const day = todayIn(
		timeZone,
		claimedAt ? new Date(claimedAt) : new Date(nowMs),
	);

	const statements = skipStatements(db, pick.skip, nowMs);
	const claimPushed = pick.pick !== null && !mine;
	// The claim's result sits after the skips and the drop of older counts (claimStatements' order).
	const claimIndex = statements.length + 1;

	if (claimPushed && pick.pick) {
		statements.push(
			...claimStatements(db, {
				text: pick.pick.text,
				token,
				nowMs,
				day,
				cap: storeLookupDailyCap(env),
			}),
		);
	}

	const results = statements.length > 0 ? await db.batch(statements) : [];

	if (!pick.pick) return null;

	const { text, attempts } = pick.pick;

	if (mine || (results[claimIndex]?.meta.changes ?? 0) > 0) {
		return { text, attempts, token, day, timeZone };
	}

	// A race lost in the batch: another run holds the store, and the next run tries it.
	return null;
}

/** The check run before each outside call: the claim still holds, and the store still qualifies. */
async function check(
	env: LookupEnv,
	claim: Claim,
): Promise<SearchOutcome | null> {
	const db = env.DB;

	if (!holdsClaim(await readLookup(db, claim.text), claim.token, new Date())) {
		return { kind: "claim-lost" };
	}

	const verdict = (
		await readEligibility(db, { lookupTexts: [claim.text] })
	).get(claim.text);

	return qualifies(env, await readAiSwitches(db), verdict)
		? null
		: { kind: "check-refused" };
}

/**
 * The search step: the whole test, one Tavily search, the whole test again, and one Workers AI line. It never throws: a
 * read that throws is `lost`, logged by its error's name. A search step that is run again (attempt > 1) makes no call.
 */
export async function searchClaimed(
	env: LookupEnv,
	claim: Claim,
	searchFetch: typeof fetch | undefined,
	{ attempt }: { attempt: number },
): Promise<SearchOutcome> {
	if (attempt > 1) return { kind: "lost" };

	try {
		if (todayIn(claim.timeZone) !== claim.day) return { kind: "date-changed" };

		const before = await check(env, claim);

		if (before) return before;

		const search = await searchOnce(
			claim.text,
			env.TAVILY_API_KEY,
			searchFetch,
		);

		if (!search.ok) {
			console.error(
				`store lookup: search ${search.failure} ${search.status ?? ""}`.trim(),
			);

			return { kind: "failed", failure: search.failure };
		}

		if (search.results.length === 0) return { kind: "nothing_found" };

		const after = await check(env, claim);

		if (after) return after;

		const line = await lineOnce(env.AI, claim.text, search.results);

		if (!line.ok) {
			console.error("store lookup: line failed");

			return { kind: "failed", failure: "line" };
		}

		return line.line === null
			? { kind: "nothing_found" }
			: { kind: "found", line: line.line };
	} catch (error) {
		console.error(
			`store lookup: check ${error instanceof Error ? error.name : "unknown"}`,
		);

		return { kind: "lost" };
	}
}

/** The statement a save's move is, or null for no move. A refused status is a bug, so it throws. */
function moveStatement(
	env: LookupEnv,
	claim: Claim,
	move: SaveMove | null,
	nowMs: number,
): D1PreparedStatement | null {
	const db = env.DB;

	if (move === null) return null;

	if (move.kind === "result") {
		if (move.status !== "found" && move.status !== "nothing_found") {
			throw new Error("store lookup: refused move");
		}

		return saveResultStatement(db, {
			text: claim.text,
			token: claim.token,
			status: move.status,
			line: move.line,
			nowMs,
		});
	}

	if (move.status !== "pending" && move.status !== "gave_up") {
		throw new Error("store lookup: refused move");
	}

	return failStatement(db, {
		text: claim.text,
		token: claim.token,
		status: move.status,
		attemptsBefore: move.attemptsBefore,
		nowMs,
	});
}

/**
 * The save step: a line, nothing found or a failure is written only while the claim still holds (the move's own guards),
 * and the claim is let go whatever happened. `saved` says whether the move's statement changed a row.
 */
export async function saveClaimed(
	env: LookupEnv,
	claim: Claim,
	outcome: SearchOutcome,
): Promise<{ saved: boolean }> {
	const db = env.DB;
	const nowMs = Date.now();
	const answered = outcome.kind === "found" || outcome.kind === "nothing_found";

	const qualifiesNow = answered
		? qualifies(
				env,
				await readAiSwitches(db),
				(await readEligibility(db, { lookupTexts: [claim.text] })).get(
					claim.text,
				),
			)
		: false;

	const move = moveStatement(
		env,
		claim,
		saveMove(outcome, qualifiesNow, claim.attempts),
		nowMs,
	);

	const statements = [
		...(move ? [move] : []),
		letGoStatement(db, { text: claim.text, token: claim.token }),
	];

	const results = await db.batch(statements);

	return { saved: move !== null && (results[0]?.meta.changes ?? 0) > 0 };
}

/**
 * The run: up to LOOKUP_RUN_LIMIT claims, each with its search and its save, as saved steps. It stops when runStops says so,
 * when a claim finds no store, and at the first step that throws (which the caller logs). A store the run tried is not
 * claimed again in this run.
 */
export async function runStoreLookup(
	env: LookupEnv,
	runStep: StepRunner,
	{
		runId,
		bySync,
		searchFetch,
	}: { runId: string; bySync: boolean; searchFetch?: typeof fetch },
): Promise<void> {
	const outcomes: SearchOutcome[] = [];
	const tried: string[] = [];

	for (let k = 1; k <= LOOKUP_RUN_LIMIT; k++) {
		const claim = await runStep(`lookup-${k}-claim`, LOOKUP_STEPS.claim, () =>
			claimNext(env, { token: claimToken(runId, k), bySync, exclude: tried }),
		);

		if (!claim) return;

		tried.push(claim.text);

		let outcome: SearchOutcome;

		try {
			outcome = await runStep(
				`lookup-${k}-search`,
				LOOKUP_STEPS.search,
				(ctx) => searchClaimed(env, claim, searchFetch, ctx),
			);
		} catch (error) {
			console.error(
				`store lookup: search step ${error instanceof Error ? error.name : "unknown"}`,
			);

			outcome = { kind: "lost" };
		}

		await runStep(`lookup-${k}-save`, LOOKUP_STEPS.save, () =>
			saveClaimed(env, claim, outcome),
		);

		outcomes.push(outcome);

		if (runStops(outcomes)) return;
	}
}

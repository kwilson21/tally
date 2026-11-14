// The sorting loop (spec §8.6, decision 139). Jev is asked about waiting transactions in groups of 25: each group
// reads D1 once, reserves its calls in a step of its own, asks Jev about each row as a step of its own, and saves
// every answer in one D1 batch, all or none. A save that fails is tried again with the same answers, about once a
// minute for up to a day (decision 143).
// The loop is the same in-process (categorizePending: the tests, where a step just runs) and in the Workflow
// (runSortInstance in sort-instance.ts: each step is a saved Workflows step, so a retry skips the steps that finished).
// Rules: a group saves only while it holds the sorting turn; a Jev call is never made twice; no clock or
// randomness is read outside a step (the Workflow's loop itself reads none).

import { askJev, JEV_THRESHOLD } from "./ai/categorize";
import { meetsConfidenceThreshold } from "./ai/confidence";
import { decide, type JevAnswer } from "./ai/decide";
import { cleanBankText } from "./clean-bank-text";
import { householdTimeZone, todayIn } from "./dates";
import {
	type AiSwitches,
	asksJev,
	readAiSwitches,
	STILL_ON_SQL,
	stillOnKeys,
} from "./db/ai-switches";
import { applyBankTextRules } from "./db/bank-text-rules";
import { questionsAnswered, readFirstTally } from "./db/first-tally";
import {
	dropReservedJevCallsStatement,
	giveBackReservedJevCallsStatement,
	reservedKeyFor,
	reserveJevCalls,
} from "./db/jev-calls";
import { loadLearnedLines } from "./db/learned-lines";
import { currentClusterRows } from "./db/resort-candidates";
import {
	bumpDoneStatement,
	type ReaskMark,
	readRun,
	reaskClearStatement,
	reaskKeepStatement,
	reaskPicks,
	reaskRestoreStatement,
} from "./db/resort-run";
import {
	releaseSortingTurn,
	releaseSortingTurnStatement,
	takeSortingTurn,
	takeSortingTurnStatement,
} from "./db/sorting-turn";
import {
	applyMerchantRules,
	type JevSeen,
	markJevFailedStatement,
	markReaskFailedStatement,
	pendingForJev,
	saveJevDetailsStatement,
	saveJevResultStatements,
} from "./db/transactions";
import { lookupAsks } from "./lookup/gate";
import { clearsForLookup, inputMark } from "./lookup/input-mark";
import { buildClusters } from "./resort-clusters";
import { type Deadline, pastDeadline } from "./run-budget";
import type { ReaskParams } from "./sort-start";

/**
 * How many transactions Jev is asked about in a day (decisions 56 and 68). The demo's reset needs few. The count is
 * the household's whole day, midnight to midnight in its time zone, shared by every sorting group (db/jev-calls.ts).
 */
export const jevCallLimit = (env: { DEMO?: string }) =>
	env.DEMO === "false" ? 500 : 40;

/** The first week's allowance per connected bank, until the three questions are answered (decision 146). */
const FIRST_WEEK_CALLS_PER_BANK = 2000;

/**
 * How many of the day's calls the sorting may reserve (decision 146). In production, until pay, bills and budgets are
 * all drawn, it is 2,000 for each connected bank, so a family's first sort is not held to the usual 500 while its
 * questions wait on it. Otherwise it is the usual cap, which the demo keeps at 40.
 */
export async function dailyJevCap(
	db: D1Database,
	env: { DEMO?: string },
): Promise<number> {
	const usual = jevCallLimit(env);

	if (env.DEMO !== "false") return usual;

	// A set-up household has all four strokes drawn, so it has answered the three questions too.
	if (questionsAnswered(await readFirstTally(db))) return usual;

	const banks = await db
		.prepare(
			"SELECT COUNT(*) AS n FROM plaid_items WHERE disconnected_at IS NULL",
		)
		.first<{ n: number }>();

	return Math.max(usual, FIRST_WEEK_CALLS_PER_BANK * (banks?.n ?? 0));
}

/** Transactions per group: one read and one write each (decision 139). */
export const GROUP_SIZE = 25;

/** How long one group may keep asking Jev; what it doesn't reach waits for the next group (decision 139). */
const ASK_BUDGET_MS = 2 * 60_000;

/** Failures in a row that point at every call (say, a changed API) rather than one transaction. */
export const MAX_FAILURES_IN_A_ROW = 3;

export type SortEnv = {
	DB: D1Database;
	JEV_API_KEY?: string;
	DEMO?: string;
	/** The store lookup's search key (spec §7): with it unset the lookup's payee question is never asked. */
	TAVILY_API_KEY?: string;
};

type Duration = `${number} ${"second" | "seconds" | "minute" | "minutes"}`;

/** One step's settings, as Workflows' `step.do` takes them. */
export type StepConfig = {
	retries?: {
		limit: number;
		delay: Duration | number;
		backoff?: "constant" | "linear" | "exponential";
	};
	timeout?: Duration | number;
	sensitive?: "output";
};

/**
 * Runs one named step and returns its result: `fn({ attempt: 1 })` in-process, `step.do(name, config, fn)` in the
 * Workflow. A step that finished is returned from its cache, and its callback doesn't run again.
 */
export type StepRunner = <T extends Rpc.Serializable<T>>(
	name: string,
	config: StepConfig,
	fn: (ctx: { attempt: number }) => Promise<T>,
) => Promise<T>;

export type SortOptions = {
	/** The demo's one run may have applied the merchant rules already; otherwise this run applies them. */
	rulesApplied?: boolean;
	/** Ask only about these transaction rows (their ids), and only the ones still unsorted. Otherwise, all waiting. */
	onlyIds?: number[];
	/** The run was started by a sync, so it also stops when "sort as they arrive" is turned off. */
	bySync?: boolean;
	/** Ask about at most this many in the run (in-process: a test's cap). */
	maxCalls?: number;
	/** In-process only: start no new call once this deadline has passed (src/run-budget.ts). */
	time?: Deadline;
	/**
	 * The Workflow waits for a turn another group holds (its read step throws, and Workflows retries it). In-process,
	 * a busy turn just ends the run.
	 */
	waitForTurn?: boolean;
	/**
	 * The Workflow waits (step.sleep) before a group asks again after a busy Jev (decision 145). Unset in-process, where a
	 * busy Jev ends the run as before.
	 */
	sleep?: (name: string, ms: number) => Promise<void>;
	/** Names this run's turns, `${runId}:${group}`: the Workflow's instance id, or a random id in-process. */
	runId: string;
	/**
	 * A re-sort's re-ask (decision 160): sorts only these candidate rows, in this order, one Jev ask each, category only.
	 * It ignores `onlyIds` and `bySync`, and the run is finished by the caller once the groups are done.
	 */
	reask?: ReaskParams;
};

type SortRow = Awaited<ReturnType<typeof pendingForJev>>[number];

/**
 * What a re-ask group carries (decision 160): the marks it cleared, so each is put back unless it was answered; the
 * picked rows Jev's question didn't read, which later groups leave out; how many rows the read found, so a group that
 * the day's cap cut short stops the run; and the run's id.
 */
type ReaskPlan = {
	runId: string;
	cleared: ReaskMark[];
	dropped: number[];
	/** How many leaders the read found: the rows the group asks, which its calls are reserved for. */
	found: number;
	/**
	 * Each picked leader's cleared followers (decision 158), by leader id: cleared with the leader, never asked. A
	 * follower's answer is the leader's, applied only when the leader's answer is confident and not mixed.
	 */
	followers: Record<number, number[]>;
	/**
	 * Each read row's seen fields, as its question was built (leaders and followers): a row whose fields changed before
	 * its mark is put back is left cleared (#831 round 2). A dropped row has none, so its mark is put back as before.
	 */
	seen: Record<number, JevSeen>;
};

/** What one group reads once, before its calls are reserved. Plain JSON, for the read step's result. */
type ReadPlan = {
	turnId: string;
	day: string;
	timeZone: string;
	switches: AiSwitches;
	bySync: boolean;
	/** No ask starts after this (ms), the group's 2-minute budget. */
	askUntil: number;
	categories: { id: number; name: string }[];
	people: { id: number; name: string }[];
	/** Every waiting row the read found, at most GROUP_SIZE. */
	rows: SortRow[];
	/** Jev is asked the store lookup's payee question, and each answer's mark is saved (src/lookup/gate.ts). */
	payee?: boolean;
	/**
	 * The group's learned lines (decisions 156 and 162) as [cleaned bank text, line] pairs: only texts a row of this group
	 * has, and only lines that are not vague. Pairs, not an object, so a text named like an inherited key (`constructor`)
	 * finds only its own line. Absent in a plan a deploy read before learned lines, so no line is sent for it.
	 */
	learned?: LearnedPair[];
	/** Set for a re-ask group: every row of it is a re-ask row. */
	reask?: ReaskPlan;
};

/**
 * A group's plan once its calls are reserved, so it can be asked and saved without another read. Plain JSON, for the
 * write step. `rows` are the first `granted` of the read's rows: the ones this group asks.
 */
export type SortPlan = ReadPlan & {
	granted: number;
};

/**
 * Whether a row's answer asks the payee question for the store lookup (spec §7). The ask and the lookup's mark save
 * both read this one test, so a mark is never written for a question that was not asked.
 */
function payeeAsked(plan: SortPlan, row: SortRow): boolean {
	return plan.payee === true && !plan.reask && !row.categoryOnly;
}

/** A failed ask. Its fields carry the status and request id, never the key or any transaction detail. */
type FailedAsk = {
	id: number;
	outcome: "failed";
	status: number | null;
	requestId: string | null;
	serviceWide: boolean;
	/** The wait Jev asked for, when it sent a readable retry-after (decision 145). */
	retryAfterMs?: number;
};

/** What one row's ask came to. An ask step never throws: any failure is `failed`. */
export type AskResult =
	| { id: number; outcome: "answered"; answer: JevAnswer }
	| FailedAsk
	| {
			id: number;
			outcome: "lost" | "date-changed" | "out-of-time";
	  };

const STEP_SETTINGS = {
	read: {
		retries: { limit: 50, delay: "20 seconds", backoff: "constant" },
		timeout: "1 minute",
		sensitive: "output",
	},
	reserve: {
		retries: { limit: 0, delay: 0 },
		timeout: "1 minute",
		sensitive: "output",
	},
	ask: {
		retries: { limit: 0, delay: 0 },
		timeout: "1 minute",
		sensitive: "output",
	},
	rules: {
		retries: { limit: 4, delay: "10 seconds", backoff: "constant" },
		timeout: "1 minute",
		sensitive: "output",
	},
	// A save that fails is tried about once a minute for up to a day, taking the group's turn back each time it is free,
	// with the answers its group kept (decision 143). A D1 batch of about 55 statements finishes well inside 30 seconds,
	// so 960 tries of 30 seconds and a minute apart are at most 24 hours.
	write: {
		retries: { limit: 960, delay: "1 minute", backoff: "constant" },
		timeout: "30 seconds",
		sensitive: "output",
	},
} satisfies Record<string, StepConfig>;

/** Failures that would hit every call, not just this transaction's. */
function serviceWide(status: number | null): boolean {
	return (
		status === null ||
		status === 401 ||
		status === 403 ||
		status === 429 ||
		status >= 500
	);
}

/**
 * Failures in a row at the end of the run's calls, not counting a service-wide one (which ends the run at once, or waits
 * first in the Workflow, decision 145). An out-of-time row made no call, so it doesn't break the row. `before` is the
 * row the earlier groups ended with: it counts when none of this group's calls succeeded.
 */
function trailingFailures(results: AskResult[], before: number): number {
	let n = 0;

	for (let i = results.length - 1; i >= 0; i--) {
		const r = results[i];

		if (r?.outcome === "out-of-time") continue;

		if (r?.outcome !== "failed" || r.serviceWide) return n;
		n += 1;
	}

	return n + before;
}

/**
 * Whether the run's asking ends here: Jev down or a bad key, a date change, a lost ask, or three failures in a row. A
 * busy Jev doesn't end it in the Workflow: writeGroup leaves this out while the run waits (decision 145).
 */
function runStops(results: AskResult[], before: number): boolean {
	const last = results.at(-1);

	if (!last) return false;

	if (last.outcome === "date-changed" || last.outcome === "lost") return true;

	if (last.outcome === "failed" && last.serviceWide) return true;

	return trailingFailures(results, before) >= MAX_FAILURES_IN_A_ROW;
}

/**
 * Whether a group stops asking after these answers: the run stops (or, for a busy Jev in the Workflow, waits), or only
 * the group's 2-minute budget is spent.
 */
function askingStops(results: AskResult[], before: number): boolean {
	return results.at(-1)?.outcome === "out-of-time" || runStops(results, before);
}

/** The first wait after a busy Jev, in ms (decision 145). Each wait after the next doubles it. */
const FIRST_WAIT_MS = 30_000;

/** Waits in a row before a run gives up: 30 s, 1 min, 2 min, 4 min, 8 min, 16 min (decision 145). */
const MAX_WAITS_IN_A_ROW = 6;

/** The longest wait Jev may ask for (its retry-after) and still be waited for (decision 145). */
const MAX_RETRY_AFTER_MS = 30 * 60_000;

/** The most one run waits in all, over its groups (decision 145). */
const MAX_WAITED_MS = 60 * 60_000;

/**
 * Whether a result is a busy Jev that a run waits out (decision 145): a failure that would hit every call and may pass
 * with time, a 429, a 5xx or no response. A 401 or 403 is not one; it ends the run at once.
 */
function retryable(result: AskResult | undefined): boolean {
	return (
		result?.outcome === "failed" &&
		result.serviceWide &&
		(result.status === null || result.status === 429 || result.status >= 500)
	);
}

/**
 * The wait before the next ask, given the run's groups so far (each group's ask results, in order), or null to stop
 * waiting (decision 145). It is pure: it reads only the groups' cached answers, so a replayed run waits the same. It
 * returns null unless the last group's last result is retryable; otherwise the wait doubles for each group in a row that
 * ended on one, or is Jev's retry-after when that is longer. It stops after six waits in a row, when Jev asks for more
 * than 30 minutes, and when the run's waits would pass 60 minutes in all.
 */
export function nextWait(groups: AskResult[][]): number | null {
	// The waits the earlier groups already returned, by the same rule on each earlier prefix. The rule itself
	// (waitAfter) takes those waits as a number, so this doesn't recurse.
	let waited = 0;

	for (let i = 1; i < groups.length; i++)
		waited += waitAfter(groups.slice(0, i), waited) ?? 0;

	return waitAfter(groups, waited);
}

/** The wait after the last of these groups, given the waits the run already returned for the groups before it. */
function waitAfter(groups: AskResult[][], waitedBefore: number): number | null {
	const last = groups.at(-1)?.at(-1);

	if (!retryable(last)) return null;
	// The trailing groups that ended on a busy Jev, counting back to the first of them that answered some rows (it counts).
	let streak = 0;

	for (let i = groups.length - 1; i >= 0; i--) {
		const group = groups[i] ?? [];

		if (!retryable(group.at(-1))) break;
		streak += 1;

		if (group.some((result) => result.outcome === "answered")) break;
	}

	// The last result is a retryable failure, so it may carry the wait Jev asked for.
	const askedMs = last?.outcome === "failed" ? (last.retryAfterMs ?? 0) : 0;

	if (streak > MAX_WAITS_IN_A_ROW || askedMs > MAX_RETRY_AFTER_MS) return null;
	const wanted = Math.max(askedMs, FIRST_WAIT_MS * 2 ** (streak - 1));

	return waitedBefore + wanted > MAX_WAITED_MS ? null : wanted;
}

/**
 * A re-ask's clusters in the run's order (decision 158), each as its member ids (its leader first, then its followers),
 * restricted to `ids`. A candidate in no cluster is a cluster of its own.
 */
function reaskClusterMembers(
	ids: readonly number[],
	clusters: readonly number[][] | undefined,
): number[][] {
	const clusterOf = new Map<number, number[]>();

	for (const cluster of clusters ?? [])
		for (const id of cluster) clusterOf.set(id, cluster);
	const wanted = new Set(ids);
	const placed = new Set<number>();
	const out: number[][] = [];

	for (const id of ids) {
		if (placed.has(id)) continue;

		const members = (clusterOf.get(id) ?? [id]).filter(
			(member) => wanted.has(member) && !placed.has(member),
		);

		for (const member of members) placed.add(member);

		if (members.length > 0) out.push(members);
	}

	return out;
}

/** A row's grouping inputs as they are now (currentClusterRows). */
type CurrentRow = Awaited<ReturnType<typeof currentClusterRows>>[number];

/**
 * The followers still in their leader's cluster by the rows as they are now (decision 158): the leader first, then the
 * followers, grouped as buildClusters groups them. A follower that no longer groups with the leader (its text, note,
 * mixed reading or amount changed after the clusters were built) is left out, so its leader's answer is not applied to it.
 */
function stillInCluster(
	leaderId: number,
	followerIds: readonly number[],
	current: ReadonlyMap<number, CurrentRow>,
): number[] {
	const rows = [leaderId, ...followerIds].flatMap((id) => {
		const row = current.get(id);

		return row ? [row] : [];
	});

	const cluster = buildClusters(rows).find((c) => c[0] === leaderId) ?? [];

	return followerIds.filter((id) => cluster.includes(id));
}

/**
 * A learned line as a group's plan keeps it: the cleaned bank text it is for, and its category and count. A line that
 * is a person's rule (decision 163) says so, and Jev is told it as a rule, with no count.
 */
type LearnedPair = [string, { category: string; answers: number; rule?: true }];

/**
 * The learned lines Jev may be told for these rows (decisions 156 and 162), as pairs: one load, then the lines of the
 * rows' own texts that are not vague (a vague text's line is never sent).
 */
async function learnedLinesFor(
	db: D1Database,
	rows: SortRow[],
): Promise<LearnedPair[]> {
	const texts = new Set(rows.map((row) => cleanBankText(row.rawName)));

	return (await loadLearnedLines(db))
		.filter((line) => texts.has(line.cleanedText) && !line.vague)
		.map(
			(line): LearnedPair => [
				line.cleanedText,
				line.rule
					? { category: line.categoryName, answers: line.answers, rule: true }
					: { category: line.categoryName, answers: line.answers },
			],
		);
}

/** The group's line for a cleaned text. A Map, so only the text's own pair matches, never an inherited key. */
function learnedFor(
	pairs: LearnedPair[] | undefined,
	cleanedText: string,
): { category: string; answers: number; rule?: true } | undefined {
	return new Map(pairs ?? []).get(cleanedText);
}

/**
 * Takes the turn and reads what a group needs, with no Jev call and no reservation: the switches once, the categories,
 * the people (when details are on), the time zone, its rows and their learned lines. Gives the turn back when
 * there is nothing to ask. Any throw after the turn was taken gives it back first. The calls are reserved in their own
 * step (reserveCalls), so a read that runs again never reserves twice.
 */
async function readGroup(
	env: SortEnv,
	options: {
		onlyIds?: number[];
		exceptIds: number[];
		bySync: boolean;
		limit: number;
		turnId: string;
		reask?: ReaskParams;
	},
): Promise<
	{ kind: "busy" } | { kind: "none" } | { kind: "group"; plan: ReadPlan }
> {
	const db = env.DB;

	if (!(await takeSortingTurn(db, options.turnId))) return { kind: "busy" };

	const none = async () => {
		await releaseSortingTurn(db, options.turnId);

		return { kind: "none" as const };
	};

	// The marks a re-ask cleared in this read, put back by the group's save unless it answered the row (decision 160).
	let cleared: ReaskMark[] = [];

	try {
		const switches = await readAiSwitches(db);

		if (!asksJev(switches) || (options.bySync && !switches.sortOnArrival))
			return await none();

		const { results: categories } = await db
			.prepare(
				"SELECT id, name FROM categories WHERE archived = 0 ORDER BY sort_order",
			)
			.all<{ id: number; name: string }>();

		const people = switches.details
			? (
					await db
						.prepare("SELECT id, name FROM household_people ORDER BY id")
						.all<{ id: number; name: string }>()
				).results
			: [];

		const timeZone = await householdTimeZone(db);
		const day = todayIn(timeZone);
		let rows: SortRow[];
		let reask: ReaskPlan | undefined;

		if (options.reask) {
			// A re-ask reads its own run only, and only while the run is running (decision 160).
			const run = await readRun(db);

			if (!run || run.id !== options.reask.runId || run.status !== "running")
				return await none();
			// The still-waiting rows, in the run's order, under the turn: the clear and the read below both happen under it,
			// so no other sort sees a cleared mark (decision 160). A retried read clears the same rows again, harmlessly.
			const runIds = new Set(run.ids);
			// Only the leaders are asked (decision 158): each cluster is asked through its first row that still waits, so when
			// a leader was decided or asked before, the next waiting follower leads the rest of its cluster and the cluster is
			// still asked once. The followers of the picked leaders are cleared with them, under the same turn, never asked.
			const exceptSet = new Set(options.exceptIds);

			const members = reaskClusterMembers(
				options.reask.ids.filter((id) => runIds.has(id)),
				options.reask.clusters,
			).map((cluster) => cluster.filter((id) => !exceptSet.has(id)));

			const allMembers = members.flat();

			const waiting = await reaskPicks(db, {
				ids: allMembers,
				except: new Set(),
				limit: allMembers.length,
			});

			const waitingById = new Map(waiting.map((mark) => [mark.id, mark]));
			const leaderMarks: ReaskMark[] = [];
			const followerMarks: ReaskMark[] = [];
			const followersOf = new Map<number, number[]>();

			for (const cluster of members) {
				if (leaderMarks.length >= options.limit) break;
				const [leaderId, ...rest] = cluster.filter((id) => waitingById.has(id));

				const leader =
					leaderId === undefined ? undefined : waitingById.get(leaderId);

				if (!leader) continue;

				const followers = rest
					.map((id) => waitingById.get(id))
					.filter((mark): mark is ReaskMark => mark !== undefined);

				leaderMarks.push(leader);
				followerMarks.push(...followers);
				followersOf.set(
					leader.id,
					followers.map((mark) => mark.id),
				);
			}

			cleared = [...leaderMarks, ...followerMarks];

			if (cleared.length > 0)
				await db.batch([reaskClearStatement(db, cleared, options.turnId)]);

			// One read for the leaders and their followers. Only the leaders' rows are asked, so only they are in `rows`.
			const read = cleared.length
				? await pendingForJev(db, cleared.length, {
						categories: switches.categories,
						categoryAsked: categories.length > 0,
						income: switches.income,
						details: false,
						ids: cleared.map((mark) => mark.id),
					})
				: [];

			// pendingForJev's order is its own (newest first), so the rows are put in the run's order (decision 160).
			const position = new Map(cleared.map((mark, i) => [mark.id, i]));
			read.sort(
				(a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0),
			);

			// The clusters are checked against the rows as they are now (decision 158): a follower changed since the clusters
			// were built may no longer group with its leader. It is not filed; its mark goes back with the rest.
			const current = new Map(
				(
					await currentClusterRows(
						db,
						cleared.map((mark) => mark.id),
					)
				).map((row) => [row.id, row]),
			);

			const leaderIds = new Set(leaderMarks.map((mark) => mark.id));
			rows = read.filter((row) => leaderIds.has(row.id));
			const readIds = new Set(read.map((row) => row.id));
			reask = {
				runId: options.reask.runId,
				cleared,
				dropped: cleared
					.map((mark) => mark.id)
					.filter((id) => !readIds.has(id)),
				found: rows.length,
				followers: Object.fromEntries(
					leaderMarks.map((mark) => [
						mark.id,
						stillInCluster(mark.id, followersOf.get(mark.id) ?? [], current),
					]),
				),
				seen: Object.fromEntries(read.map((row) => [row.id, row.seen])),
			};
		} else {
			rows = await pendingForJev(db, options.limit, {
				categories: switches.categories,
				categoryAsked: categories.length > 0,
				income: switches.income,
				details: switches.details,
				ids: options.onlyIds,
				exceptIds: options.exceptIds,
			});
		}

		if (rows.length === 0) {
			// Nothing to ask: any mark this read cleared goes back before the turn is given up.
			if (cleared.length > 0)
				await db.batch(
					cleared.map((mark) =>
						reaskRestoreStatement(db, mark, options.turnId),
					),
				);

			return await none();
		}

		// Loaded once for the group, not per row: a line is context for the one text it is about, and a line that
		// changes before the save still applies its answer (a line is not part of JevSeen).
		const learned = switches.categories ? await learnedLinesFor(db, rows) : [];

		const plan: ReadPlan = {
			turnId: options.turnId,
			day,
			timeZone,
			switches,
			bySync: options.bySync,
			askUntil: Date.now() + ASK_BUDGET_MS,
			categories,
			people,
			rows,
			learned,
			payee: lookupAsks(env, switches),
		};

		if (reask) plan.reask = reask;

		return { kind: "group", plan };
	} catch (error) {
		// A cleared mark must not outlive the turn: put it back first. If that fails, the turn is kept, so a retried read
		// takes it back and restores or clears again, and the turn runs out on its own otherwise (decision 160).
		if (cleared.length > 0) {
			try {
				await db.batch(
					cleared.map((mark) =>
						reaskRestoreStatement(db, mark, options.turnId),
					),
				);
			} catch {
				throw error;
			}
		}

		await releaseSortingTurn(db, options.turnId);
		throw error;
	}
}

/**
 * Reserves the group's calls from the day's cap, for the day its read used (decision 139). A group's grant is kept under
 * its name (decision 143): a reserve that runs again gets that grant back, and reserves nothing more.
 */
async function reserveCalls(
	env: SortEnv,
	plan: ReadPlan,
): Promise<{ granted: number }> {
	const kept = await env.DB.prepare(
		"SELECT value FROM household_settings WHERE key = ?",
	)
		.bind(reservedKeyFor(plan.day, plan.turnId))
		.first<{ value: string }>();

	if (kept) return { granted: Number(kept.value) };

	const granted = await reserveJevCalls(
		env.DB,
		plan.day,
		await dailyJevCap(env.DB, env),
		plan.rows.length,
		plan.turnId,
	);

	return { granted };
}

/** One row's details save (saveJevDetailsStatement): the kind and person Jev chose, and its what-it-was answer. */
type DetailsEntry = {
	id: number;
	seen: JevSeen;
	kind: string | null;
	forPersonId: number | null;
	noteWorthWriting: number;
};

/**
 * The details entry for an answered row, or none when the row gets no details in this run. The details save and the
 * lookup's mark both read it, so the mark can predict the kind and the person the save fills.
 */
function detailsEntryFor(
	plan: SortPlan,
	row: SortRow,
	answer: JevAnswer,
): DetailsEntry | undefined {
	if (!plan.switches.details || row.detailsAsked || plan.reask)
		return undefined;

	const kind = answer.kind;

	const kindValue =
		kind && kind.confidence >= JEV_THRESHOLD && kind.label !== "None of these"
			? kind.label
			: null;

	const person = answer.forPerson;

	const personValue =
		person &&
		person.confidence >= JEV_THRESHOLD &&
		person.label.startsWith("person:")
			? Number(person.label.slice("person:".length)) || null
			: null;

	// Jev's yes is kept only when it's likely (the same threshold as the other answers); a missing or unclear answer is a no (decision 103).
	const worth = answer.noteWorthWriting;

	return {
		id: row.id,
		seen: row.seen,
		kind: kindValue,
		forPersonId: personValue,
		noteWorthWriting: worth !== undefined && worth >= JEV_THRESHOLD ? 1 : 0,
	};
}

/**
 * What a row reads as once its details save has run: the kind and the person it fills where empty and not cleared, as
 * saveJevDetailsStatement does. A row with no details entry reads as it did.
 */
function seenAfterDetails(
	row: SortRow,
	entry: DetailsEntry | undefined,
	people: { id: number; name: string }[],
): JevSeen {
	if (!entry) return row.seen;

	const seen = { ...row.seen };

	if (seen.kind === null && !row.kindCleared && entry.kind !== null)
		seen.kind = entry.kind;

	const person = people.find((p) => p.id === entry.forPersonId);

	if (seen.forPersonId === null && !row.forPersonCleared && person) {
		seen.forPersonId = person.id;
		seen.forPersonName = person.name;
	}

	return seen;
}

/**
 * The lookup's mark for one answered row (spec §5, lookup_cleared), saved right after the row's answer update so it lands
 * only when that update did (changes() > 0), and only while the lookup switch is still on.
 * `cleared` is the decision made when the row was read, and it is written as 1 only if the row, as the update just left
 * it, still stores Jev's category answer: a confidence is set, and the category source is none (a Maybe, with no category
 * filed) or 'jev' (a filed guess). A person's ('user'), a rule's ('merchant_rule') or a bill's ('bill') category, filed
 * while Jev was asked, means Jev's answer was never stored, so the row is never cleared.
 */
function lookupMarkStatement(
	db: D1Database,
	id: number,
	mark: { inputMark: string; cleared: boolean },
	stillOn: string,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO lookup_cleared (transaction_id, input_mark, cleared)
			SELECT ?, ?, CASE WHEN ? = 1 AND EXISTS (SELECT 1 FROM transactions t WHERE t.id = ?
				AND t.category_confidence IS NOT NULL AND (t.category_source IS NULL OR t.category_source = 'jev')) THEN 1 ELSE 0 END
			WHERE changes() > 0 AND ${STILL_ON_SQL}
			ON CONFLICT(transaction_id) DO UPDATE SET input_mark = excluded.input_mark, cleared = excluded.cleared`,
		)
		.bind(id, mark.inputMark, mark.cleared ? 1 : 0, id, stillOn);
}

/**
 * Asks Jev about one row (decision 139). It never throws: any failure is a `failed` answer that counts against the
 * day, and a busy one carries the wait Jev asked for, when it sent one (decision 145). A retried ask (attempt > 1) makes
 * no call, since the first attempt may have made it: it is `lost`.
 */
async function askOne(
	apiKey: string,
	plan: SortPlan,
	row: SortRow,
	fetchImpl:
		| ((url: string, init?: RequestInit) => Promise<Response>)
		| undefined,
	{ attempt }: { attempt: number },
): Promise<AskResult> {
	const id = row.id;

	try {
		if (attempt > 1) return { id, outcome: "lost" };

		if (todayIn(plan.timeZone) !== plan.day)
			return { id, outcome: "date-changed" };

		if (Date.now() > plan.askUntil) return { id, outcome: "out-of-time" };

		// A re-ask asks for its category only, never details (decision 160).
		const detailRequested =
			plan.switches.details && !row.detailsAsked && !plan.reask;

		const learned = plan.switches.categories
			? learnedFor(plan.learned, cleanBankText(row.rawName))
			: undefined;

		const result = await askJev(
			{ ...row, learnedCategory: learned },
			plan.categories.map((c) => c.name),
			apiKey,
			fetchImpl,
			{
				details: detailRequested,
				people: detailRequested ? plan.people : undefined,
				payee: payeeAsked(plan, row),
			},
		);

		if (!result.ok) {
			// Status and request id only: never the key or anything about the transaction.
			console.error(
				`jev: ${result.status ?? "no response"} ${result.requestId ?? ""}`.trim(),
			);

			const failure: FailedAsk = {
				id,
				outcome: "failed",
				status: result.status,
				requestId: result.requestId,
				serviceWide: serviceWide(result.status),
			};

			if (result.retryAfterMs !== undefined) {
				failure.retryAfterMs = result.retryAfterMs;
			}

			return failure;
		}

		return { id, outcome: "answered", answer: result.answer };
	} catch (error) {
		console.error(
			`jev: ask failed ${error instanceof Error ? error.name : "unknown"}`,
		);

		return {
			id,
			outcome: "failed",
			status: null,
			requestId: null,
			serviceWide: true,
		};
	}
}

/**
 * Saves a group's answers in one D1 batch, all or none (decision 139): each answer's update and log row, each failed
 * row's mark, the details, the calls given back, and the turn released last. Every statement is guarded by the turn,
 * so a save retried after it committed, or by a group that lost the turn, or after a demo reset, changes nothing.
 * Returns how many calls the group used (answered, failed and lost; not out-of-time or date-changed), how many
 * categories it applied, and whether the run stops here. `failuresBefore` is the failures in a row the earlier
 * groups ended with (see sortGroups).
 */
export async function writeGroup(
	env: SortEnv,
	plan: SortPlan,
	results: AskResult[],
	failuresBefore: number,
	/**
	 * The group's last ask was a busy Jev that the run waits out (decision 145): the short-group rule and runStops don't
	 * stop the run here. The other stops still do.
	 */
	waitsOnBusy: boolean,
): Promise<{ asked: number; applied: number; stop: boolean }> {
	const db = env.DB;
	const now = await readAiSwitches(db);
	const sw = plan.switches;
	const turn = plan.turnId;
	const reask = plan.reask;
	// Each re-ask row's mark, which carries the identity its save checks (#831).
	const markOf = new Map((reask?.cleared ?? []).map((mark) => [mark.id, mark]));
	// The log rows are dated with the household's day as the answers are saved (spec §8.6), in the zone the household has
	// now: a save retried after the zone changed dates them by it (decision 143). The reservation keeps the read's day.
	const saveDay = todayIn(await householdTimeZone(db));
	const byId = new Map(plan.rows.map((row) => [row.id, row]));
	const reservedKey = reservedKeyFor(plan.day, turn);
	const lookupStillOn = stillOnKeys({ lookupStores: true });

	// The turn is taken back first, while the group's record exists (decision 143): a save that already went through
	// finds no record and takes nothing.
	const statements: D1PreparedStatement[] = [
		takeSortingTurnStatement(db, turn, reservedKey),
	];

	const applies: { index: number; categoryId: number | null }[] = [];
	const details: Parameters<typeof saveJevDetailsStatement>[1] = [];
	let asked = 0;

	for (const result of results) {
		const row = byId.get(result.id);

		if (!row) continue;

		if (result.outcome === "answered") {
			asked += 1;

			const entry = detailsEntryFor(plan, row, result.answer);

			// A re-ask takes its category answer only, and never a flag, exclusion, income or details (decision 160).
			// A re-ask row with no mark (never read with one) is not written at all (#831).
			if (
				reask
					? sw.categories && markOf.has(row.id)
					: (sw.categories || sw.income) && (!row.categoryOnly || sw.categories)
			) {
				const decision = decide(result.answer, plan.categories, JEV_THRESHOLD, {
					categories: sw.categories,
				});

				applies.push({
					index: statements.length,
					categoryId: decision.categoryId,
				});

				const answer = saveJevResultStatements(db, row.id, decision, {
					categoryOnly: row.categoryOnly,
					// The save writes only to the row the run holds under this id: the identity its mark carries (#831).
					reask: reask
						? {
								runId: reask.runId,
								plaidTransactionId: markOf.get(row.id)?.plaid ?? null,
								amountCents: markOf.get(row.id)?.amount ?? 0,
							}
						: undefined,
					categoryAsked: plan.categories.length > 0,
					switches: {
						income: sw.income,
						categories: sw.categories,
						sortOnArrival: plan.bySync,
					},
					// The log counts only what this answer applies now (spec §8.6), dated with the household's day.
					log: {
						day: saveDay,
						category:
							decision.categoryId !== null && row.categorySource === null,
						income: row.incomeSource !== "jev",
					},
					turn,
					seen: row.seen,
				});

				statements.push(answer.update);

				// The mark follows the answer's own update and comes before its log, so changes() is that update's (the
				// batch reads back only the update indexes in `applies` and the last statement, so this shifts nothing).
				if (payeeAsked(plan, row))
					statements.push(
						lookupMarkStatement(
							db,
							row.id,
							{
								inputMark: await inputMark(
									seenAfterDetails(row, entry, plan.people),
								),
								cleared:
									clearsForLookup(result.answer) &&
									!row.categoryAnswered &&
									sw.categories &&
									sw.income,
							},
							lookupStillOn,
						),
					);

				if (answer.log) statements.push(answer.log);
				// A confident answer for a real category applies to each follower of this leader as a category only (decision
				// 158), unless Jev reads the trip as mixed: its followers may be other things. Each follower is saved on its own
				// mark and seen fields, so a row a person has answered or edited is left out (its mark is restored or kept).
				// The leader's category is filed only when the leader itself was valid (its seen fields are on the plan) and its
				// save is written (the follower's own save checks it, below). The mixed test is the app's (jevSaysMixedSql,
				// mixed-trip.ts): Jev's mixed reading at or above the threshold, naming another category.
				const leaderCategory = decision.categoryId;

				const mixedTrip =
					decision.mixedProbability !== null &&
					decision.mixedProbability !== undefined &&
					meetsConfidenceThreshold(decision.mixedProbability, JEV_THRESHOLD) &&
					decision.alsoCategoryId !== null &&
					decision.alsoCategoryId !== undefined &&
					decision.alsoCategoryId !== leaderCategory;

				if (
					reask &&
					leaderCategory !== null &&
					reask.seen[row.id] &&
					!mixedTrip
				)
					for (const followerId of reask.followers[row.id] ?? []) {
						const followerMark = markOf.get(followerId);
						const followerSeen = reask.seen[followerId];

						if (!followerMark || !followerSeen) continue;
						applies.push({
							index: statements.length,
							categoryId: leaderCategory,
						});

						// A follower's category is logged like the leader's: the What AI did row counts it once, and only when
						// the save files it (the log statement checks the row's source after the update).
						const followerSave = saveJevResultStatements(
							db,
							followerId,
							{
								...decision,
								noneFit: false,
								mixedProbability: null,
								alsoCategoryId: null,
							},
							{
								categoryOnly: true,
								reask: {
									runId: reask.runId,
									plaidTransactionId: followerMark.plaid,
									amountCents: followerMark.amount,
								},
								// The follower's save writes only where its leader's category was filed in this batch
								// (decision 158). The leader was waiting when the group read, and the batch is turn-guarded.
								leaderFiled: { id: row.id, categoryId: leaderCategory },
								categoryAsked: plan.categories.length > 0,
								switches: {
									income: sw.income,
									categories: sw.categories,
									sortOnArrival: plan.bySync,
								},
								log: { day: saveDay, category: true, income: false },
								turn,
								seen: followerSeen,
							},
						);

						statements.push(followerSave.update);

						if (followerSave.log) statements.push(followerSave.log);
					}
			}

			if (entry) details.push(entry);
		} else if (result.outcome === "failed") {
			asked += 1;

			if (!result.serviceWide) {
				if (reask) {
					// A re-ask's failure is stamped only on the transaction the run holds under this id (#831 round 2).
					const mark = markOf.get(row.id);

					if (mark)
						statements.push(
							markReaskFailedStatement(
								db,
								{
									id: row.id,
									plaidTransactionId: mark.plaid,
									amountCents: mark.amount,
								},
								turn,
							),
						);
				} else statements.push(markJevFailedStatement(db, row.id, turn));
			}
		} else if (result.outcome === "lost") {
			asked += 1;
		}
	}

	// Whether the run stops after this group. The stop rules are the same as ever, except a re-ask group: its rows are the
	// run's own, so it is short only when the day's calls ran out before them (plan.granted under plan.reask.found), and
	// it stops the run only then.
	const endedOutOfTime = results.at(-1)?.outcome === "out-of-time";
	const askedNothingOutOfTime = asked === 0 && endedOutOfTime;

	const shortGroup = reask
		? plan.granted < reask.found
		: plan.rows.length < GROUP_SIZE;

	const stop =
		!asksJev(now) ||
		(plan.bySync && !now.sortOnArrival) ||
		(!waitsOnBusy && shortGroup && !endedOutOfTime) ||
		askedNothingOutOfTime ||
		(!waitsOnBusy && runStops(results, failuresBefore));

	if (reask) {
		// The rows this group handled, for a re-sort's progress: each asked row once, except a busy one that the next group
		// asks again (decision 145). Out-of-time and date-changed rows were not handled.
		const handledLeaders = results.flatMap((result) =>
			(result.outcome === "answered" ||
				result.outcome === "failed" ||
				result.outcome === "lost") &&
			!(waitsOnBusy && !stop && retryable(result))
				? [result.id]
				: [],
		);

		// Each handled leader counts with its followers (applied or restored, decision 158). A leader the cap or the budget
		// left unhandled counts none of its followers, which are restored.
		const handled =
			handledLeaders.length +
			handledLeaders.reduce(
				(sum, id) => sum + (reask.followers[id]?.length ?? 0),
				0,
			);

		// Every row the re-ask cleared gets its mark back unless its answer was saved above: a row not reached, one the
		// cap or the budget cut, one whose ask failed, and one whose answer no longer applied (decision 160). A row that
		// was answered has its confidence written, so its restore changes nothing.
		// A row a person edited while it was asked keeps its mark cleared (its seen fields no longer match), so the queued
		// sort that the edit started can still ask Jev about it, and the finish leaves it alone (#831 round 2).
		for (const mark of reask.cleared) {
			const seen = reask.seen[mark.id];
			statements.push(reaskRestoreStatement(db, mark, turn, seen));

			if (seen)
				statements.push(reaskKeepStatement(db, reask.runId, mark, seen, turn));
		}

		statements.push(
			bumpDoneStatement(db, {
				runId: reask.runId,
				rows: handled,
				turnId: turn,
			}),
		);
	}

	const detailsStatement = saveJevDetailsStatement(db, details, {
		stillOn: stillOnKeys({ details: true, sortOnArrival: plan.bySync }),
		turnId: turn,
	});

	if (detailsStatement) statements.push(detailsStatement);
	// What the group reserved and didn't ask goes back, then its record goes, and the turn is released last (decision 143).
	statements.push(
		giveBackReservedJevCallsStatement(db, {
			day: plan.day,
			planned: plan.granted,
			asked,
			turnId: turn,
		}),
		dropReservedJevCallsStatement(db, plan.day, turn),
		releaseSortingTurnStatement(db, turn),
	);

	const saved = await db.batch(statements);

	// The release is the batch's last statement. Changing no row means the turn wasn't this group's when the batch ran.
	// Its record gone means the save already went through, so there is nothing to save. Its record still there means
	// another group holds the turn: the step throws, so it is tried again.
	if ((saved.at(-1)?.meta.changes ?? 0) === 0) {
		const record = await db
			.prepare("SELECT key FROM household_settings WHERE key = ?")
			.bind(reservedKey)
			.first();

		if (record) throw new Error("sorting turn taken");

		return { asked, applied: 0, stop: true };
	}

	let applied = 0;

	for (const apply of applies)
		if (
			apply.categoryId !== null &&
			(saved[apply.index]?.meta.changes ?? 0) > 0
		)
			applied += 1;

	return { asked, applied, stop };
}

/**
 * Sorts the waiting transactions in groups of 25 through `runStep` (see StepRunner). Merchant rules first (unless the
 * caller applied them), then for each group: read (turn taken), reserve (the calls from the day's cap), ask each row (a
 * step of its own), and write (one batch, the turn released). The run ends when a group reads nothing, when a write
 * says so, when a write fails for good (its tries ran out, logged by name), or when the calls or (in-process) the
 * deadline run out. In the Workflow, a busy Jev (a 429, a 5xx or no response) waits and asks again, until nextWait
 * says stop (decision 145). In-process, a throw releases the turn this run still holds.
 */
export async function sortGroups(
	env: SortEnv,
	runStep: StepRunner,
	fetchImpl:
		| ((url: string, init?: RequestInit) => Promise<Response>)
		| undefined,
	options: SortOptions,
): Promise<{ asked: number; applied: number }> {
	const done = { asked: 0, applied: 0 };
	// A re-ask asks only its own rows, and never by the sync switch (decision 160).
	const onlyIds = options.reask ? options.reask.ids : options.onlyIds;
	const bySync = options.reask ? false : (options.bySync ?? false);

	if (!env.JEV_API_KEY || onlyIds?.length === 0) return done;
	const apiKey = env.JEV_API_KEY;
	const maxCalls = options.maxCalls ?? Number.POSITIVE_INFINITY;
	const askedIds = new Set<number>();
	// Each group's ask results so far, from the cached steps: the input to nextWait (decision 145).
	const groups: AskResult[][] = [];
	// The failures in a row the groups so far ended with, from their cached answers, so a replayed run counts the same.
	let streak = 0;
	let held: string | undefined;

	try {
		// Merchant rules are the household's own, so they apply whatever the AI switches say.
		if (!options.rulesApplied)
			await runStep("rules", STEP_SETTINGS.rules, async () => {
				await applyMerchantRules(env.DB);
				// After the merchant rules, so a merchant rule wins (decision 163).
				await applyBankTextRules(env.DB);

				return true;
			});

		for (let n = 1; done.asked < maxCalls; n++) {
			const turnId = `${options.runId}:${n}`;

			// A busy turn throws inside the read step, so Workflows retries the read until the turn is free.
			const read = await runStep(
				`group-${n}-read`,
				STEP_SETTINGS.read,
				async () => {
					const result = await readGroup(env, {
						onlyIds,
						exceptIds: [...askedIds],
						bySync,
						limit: Math.min(GROUP_SIZE, maxCalls - done.asked),
						turnId,
						reask: options.reask,
					});

					if (result.kind === "busy" && options.waitForTurn)
						throw new Error("sorting turn taken");

					return result;
				},
			);

			if (read.kind === "busy" || read.kind === "none") break;
			const { plan: readPlan } = read;
			held = turnId;

			// A re-ask's picked rows that Jev's question didn't read are not asked again by a later group.
			for (const id of readPlan.reask?.dropped ?? []) askedIds.add(id);

			// A re-ask's followers are never asked on their own, so no later group picks one (decision 158).
			for (const followerIds of Object.values(readPlan.reask?.followers ?? {}))
				for (const id of followerIds) askedIds.add(id);
			// The calls are reserved in a step of their own, so a read that runs again never reserves twice. A reserve
			// that rejects grants nothing here; if its batch had committed, its record gives the calls back at the save.
			let granted = 0;

			try {
				granted = (
					await runStep(`group-${n}-reserve`, STEP_SETTINGS.reserve, () =>
						reserveCalls(env, readPlan),
					)
				).granted;
			} catch (error) {
				console.error(
					`sorting: reserve step ${error instanceof Error ? error.name : "unknown"}`,
				);
			}

			// With nothing granted there are no rows: the write gives the turn back, and as a short group it stops the run.
			const plan: SortPlan = {
				...readPlan,
				granted,
				rows: readPlan.rows.slice(0, granted),
			};

			const results: AskResult[] = [];
			const before = streak;
			let outOfTime = false;

			for (const row of plan.rows) {
				if (pastDeadline(options.time)) {
					console.log("jev: stopped at the time budget");
					outOfTime = true;
					break;
				}

				let answer: AskResult;

				try {
					answer = await runStep(
						`group-${n}-ask-${row.id}`,
						STEP_SETTINGS.ask,
						(ctx) => askOne(apiKey, plan, row, fetchImpl, ctx),
					);
				} catch (error) {
					// The step itself rejected (its timeout, or a runtime failure). Its call may have been made, so it
					// counts as asked, and it stops the group's asking; the write still saves the answers before it.
					console.error(
						`sorting: ask step ${error instanceof Error ? error.name : "unknown"}`,
					);
					answer = { id: row.id, outcome: "lost" };
				}

				results.push(answer);

				if (askingStops(results, before)) break;
			}

			// A busy Jev's group waits before its next ask, and doesn't stop the run here (decision 145). The wait comes from
			// the cached answers only, so a replayed run takes the same path.
			const wait = options.sleep ? nextWait([...groups, results]) : null;
			let written: Awaited<ReturnType<typeof writeGroup>>;

			try {
				written = await runStep(`group-${n}-write`, STEP_SETTINGS.write, () =>
					writeGroup(env, plan, results, before, wait !== null),
				);
			} catch (error) {
				// The save ran out of its tries (about a day). Its rows wait for the next run, and the calls it reserved stay
				// in its record until the cleanup two days on clears it (decision 143). `held` stays set, so the in-process
				// finally below releases the turn.
				console.error(
					`sorting: save step ${error instanceof Error ? error.name : "unknown"}`,
				);
				break;
			}

			// A save has returned, so the turn is no longer this run's to release. Until then `held` stays set, so the
			// in-process finally below releases the turn if a save throws.
			held = undefined;
			streak = trailingFailures(results, before);
			done.asked += written.asked;
			done.applied += written.applied;

			// The busy row isn't asked off: the next group reads it again, under its own step names (decision 145).
			const busyRow =
				wait !== null && !written.stop ? results.at(-1)?.id : undefined;

			for (const result of results)
				if (result.outcome !== "out-of-time" && result.id !== busyRow)
					askedIds.add(result.id);
			groups.push(results);

			if (written.stop || outOfTime) break;

			if (wait !== null && options.sleep)
				await options.sleep(`wait-${n}`, wait);
		}
	} finally {
		// In-process, a throw must not leave this run's turn held for the next run (the Workflow's turn expires).
		if (!options.waitForTurn && held !== undefined)
			await releaseSortingTurn(env.DB, held);
	}

	return done;
}

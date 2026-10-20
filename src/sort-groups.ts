// The sorting loop (spec §8.6, decision 136). Jev is asked about waiting transactions in groups of 25: each group
// reads D1 once, asks Jev about each row as a step of its own, and saves every answer in one D1 batch, all or none.
// The loop is the same in-process (categorizePending: the nightly runs and the tests, where a step just runs) and in
// the Workflow (SortWorkflow: each step is a saved Workflows step, so a retry skips the steps that finished).
// Rules: a group saves only while it holds the sorting turn; a Jev call is never made twice; no clock or
// randomness is read outside a step (the Workflow's loop itself reads none).

import { askJev, JEV_THRESHOLD } from "./ai/categorize";
import { decide, type JevAnswer } from "./ai/decide";
import { householdTimeZone, todayIn } from "./dates";
import {
	type AiSwitches,
	asksJev,
	readAiSwitches,
	stillOnKeys,
} from "./db/ai-switches";
import { giveBackJevCallsStatement, reserveJevCalls } from "./db/jev-calls";
import {
	releaseSortingTurn,
	releaseSortingTurnStatement,
	takeSortingTurn,
} from "./db/sorting-turn";
import {
	applyMerchantRules,
	markJevFailedStatement,
	merchantCategoryHistoryForJev,
	pendingForJev,
	saveJevDetailsStatement,
	saveJevResultStatements,
} from "./db/transactions";
import { type Deadline, pastDeadline } from "./run-budget";

/**
 * How many transactions Jev is asked about in a day (decisions 56 and 68). The demo's reset needs few. The count is
 * the household's whole day, midnight to midnight in its time zone, shared by every sorting group and the nightly
 * runs (db/jev-calls.ts).
 */
export const jevCallLimit = (env: { DEMO?: string }) =>
	env.DEMO === "false" ? 500 : 40;

/** Transactions per group: one read and one write each (decision 136). */
export const GROUP_SIZE = 25;

/** How long one group may keep asking Jev; what it doesn't reach waits for the next group (decision 136). */
const ASK_BUDGET_MS = 2 * 60_000;

/** Failures in a row that point at every call (say, a changed API) rather than one transaction. */
const MAX_FAILURES_IN_A_ROW = 3;

export type SortEnv = { DB: D1Database; JEV_API_KEY?: string; DEMO?: string };

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
	/** Ask about at most this many in the run (in-process: the nightly runs' cap). */
	maxCalls?: number;
	/** In-process only: start no new call once this deadline has passed (src/run-budget.ts). */
	time?: Deadline;
	/**
	 * The Workflow waits for a turn another group holds (its read step throws, and Workflows retries it). In-process,
	 * a busy turn just ends the run.
	 */
	waitForTurn?: boolean;
	/** Names this run's turns, `${runId}:${group}`: the Workflow's instance id, or a random id in-process. */
	runId: string;
};

type SortRow = Awaited<ReturnType<typeof pendingForJev>>[number];

/** What one group reads once, so it can be asked and saved without another read. Plain JSON, for a step's result. */
export type SortPlan = {
	turnId: string;
	day: string;
	timeZone: string;
	granted: number;
	switches: AiSwitches;
	bySync: boolean;
	/** No ask starts after this (ms), the group's 2-minute budget. */
	askUntil: number;
	categories: { id: number; name: string }[];
	people: { id: number; name: string }[];
	rows: SortRow[];
	/** Each merchant's recent categories, keyed by its merchant key. */
	histories: Record<string, string[][]>;
};

/** What one row's ask came to. An ask step never throws: any failure is `failed`. */
export type AskResult =
	| { id: number; outcome: "answered"; answer: JevAnswer }
	| {
			id: number;
			outcome: "failed";
			status: number | null;
			requestId: string | null;
			serviceWide: boolean;
	  }
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
	ask: {
		retries: { limit: 0, delay: 0 },
		timeout: "1 minute",
		sensitive: "output",
	},
	write: {
		retries: { limit: 4, delay: "10 seconds", backoff: "constant" },
		timeout: "1 minute",
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
 * Failures in a row at the end of the run's calls, not counting a service-wide one (which ends the run at once). An
 * out-of-time row made no call, so it doesn't break the row. `before` is the row the earlier groups ended with: it
 * counts when none of this group's calls succeeded.
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

/** Whether the run's asking ends here: Jev down or a bad key, a date change, a lost ask, or three failures in a row. */
function runStops(results: AskResult[], before: number): boolean {
	const last = results.at(-1);
	if (!last) return false;
	if (last.outcome === "date-changed" || last.outcome === "lost") return true;
	if (last.outcome === "failed" && last.serviceWide) return true;
	return trailingFailures(results, before) >= MAX_FAILURES_IN_A_ROW;
}

/** Whether a group stops asking after these answers: the run stops, or only the group's 2-minute budget is spent. */
function askingStops(results: AskResult[], before: number): boolean {
	return results.at(-1)?.outcome === "out-of-time" || runStops(results, before);
}

/**
 * Takes the turn and reads what a group needs, with no Jev call: the switches once, the categories, the people (when
 * details are on), the time zone, its rows and their merchant histories, and its calls from the day's cap (reserved
 * last). Gives the turn back when there is nothing to ask. Any throw after the turn was taken gives it back first.
 */
async function readGroup(
	env: SortEnv,
	options: {
		onlyIds?: number[];
		exceptIds: number[];
		bySync: boolean;
		limit: number;
		turnId: string;
	},
): Promise<
	{ kind: "busy" } | { kind: "none" } | { kind: "group"; plan: SortPlan }
> {
	const db = env.DB;
	if (!(await takeSortingTurn(db, options.turnId))) return { kind: "busy" };
	const none = async () => {
		await releaseSortingTurn(db, options.turnId);
		return { kind: "none" as const };
	};
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
		const rows = await pendingForJev(db, options.limit, {
			categories: switches.categories,
			categoryAsked: categories.length > 0,
			income: switches.income,
			details: switches.details,
			ids: options.onlyIds,
			exceptIds: options.exceptIds,
		});
		if (rows.length === 0) return await none();
		const histories = switches.categories
			? await merchantCategoryHistoryForJev(db, rows)
			: new Map<string, string[][]>();
		// Reserved last: nothing that can throw comes after it (the calls are not given back by a throw here).
		const granted = await reserveJevCalls(
			db,
			day,
			jevCallLimit(env),
			rows.length,
		);
		if (granted === 0) return await none();
		return {
			kind: "group",
			plan: {
				turnId: options.turnId,
				day,
				timeZone,
				granted,
				switches,
				bySync: options.bySync,
				askUntil: Date.now() + ASK_BUDGET_MS,
				categories,
				people,
				rows: rows.slice(0, granted),
				histories: Object.fromEntries(histories),
			},
		};
	} catch (error) {
		await releaseSortingTurn(db, options.turnId);
		throw error;
	}
}

/**
 * Asks Jev about one row (decision 136). It never throws: any failure is a `failed` answer that counts against the
 * day. A retried ask (attempt > 1) makes no call, since the first attempt may have made it: it is `lost`.
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
		const detailRequested = plan.switches.details && !row.detailsAsked;
		const result = await askJev(
			{
				...row,
				merchantCategoryHistory: plan.switches.categories
					? plan.histories[row.merchantKey]
					: undefined,
			},
			plan.categories.map((c) => c.name),
			apiKey,
			fetchImpl,
			{
				details: detailRequested,
				people: detailRequested ? plan.people : undefined,
			},
		);
		if (!result.ok) {
			// Status and request id only: never the key or anything about the transaction.
			console.error(
				`jev: ${result.status ?? "no response"} ${result.requestId ?? ""}`.trim(),
			);
			return {
				id,
				outcome: "failed",
				status: result.status,
				requestId: result.requestId,
				serviceWide: serviceWide(result.status),
			};
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
 * Saves a group's answers in one D1 batch, all or none (decision 136): each answer's update and log row, each failed
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
): Promise<{ asked: number; applied: number; stop: boolean }> {
	const db = env.DB;
	const now = await readAiSwitches(db);
	const sw = plan.switches;
	const turn = plan.turnId;
	// The log rows are dated with the household's day as the answers are saved (spec §8.6).
	const saveDay = todayIn(plan.timeZone);
	const byId = new Map(plan.rows.map((row) => [row.id, row]));
	const statements: D1PreparedStatement[] = [];
	const applies: { index: number; categoryId: number | null }[] = [];
	const details: Parameters<typeof saveJevDetailsStatement>[1] = [];
	let asked = 0;

	for (const result of results) {
		const row = byId.get(result.id);
		if (!row) continue;
		if (result.outcome === "answered") {
			asked += 1;
			if (
				(sw.categories || sw.income) &&
				(!row.categoryOnly || sw.categories)
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
				});
				statements.push(answer.update);
				if (answer.log) statements.push(answer.log);
			}
			if (sw.details && !row.detailsAsked) {
				const kind = result.answer.kind;
				const kindValue =
					kind &&
					kind.confidence >= JEV_THRESHOLD &&
					kind.label !== "None of these"
						? kind.label
						: null;
				const person = result.answer.forPerson;
				const personValue =
					person &&
					person.confidence >= JEV_THRESHOLD &&
					person.label.startsWith("person:")
						? Number(person.label.slice("person:".length)) || null
						: null;
				// Jev's yes is kept only when it's likely (the same threshold as the other answers); a missing or unclear answer is a no (decision 103).
				const worth = result.answer.noteWorthWriting;
				details.push({
					id: row.id,
					kind: kindValue,
					forPersonId: personValue,
					noteWorthWriting:
						worth !== undefined && worth >= JEV_THRESHOLD ? 1 : 0,
				});
			}
		} else if (result.outcome === "failed") {
			asked += 1;
			if (!result.serviceWide)
				statements.push(markJevFailedStatement(db, row.id, turn));
		} else if (result.outcome === "lost") {
			asked += 1;
		}
	}

	const detailsStatement = saveJevDetailsStatement(db, details, {
		stillOn: stillOnKeys({ details: true, sortOnArrival: plan.bySync }),
		turnId: turn,
	});
	if (detailsStatement) statements.push(detailsStatement);
	const giveBack = giveBackJevCallsStatement(
		db,
		plan.day,
		plan.granted - asked,
		turn,
	);
	if (giveBack) statements.push(giveBack);
	statements.push(releaseSortingTurnStatement(db, turn));

	const saved = await db.batch(statements);
	let applied = 0;
	for (const apply of applies)
		if (
			apply.categoryId !== null &&
			(saved[apply.index]?.meta.changes ?? 0) > 0
		)
			applied += 1;

	// A group that asked nothing because its budget was already spent stops the run: its rows would be read again.
	const askedNothingOutOfTime =
		asked === 0 && results.at(-1)?.outcome === "out-of-time";
	const stop =
		!asksJev(now) ||
		(plan.bySync && !now.sortOnArrival) ||
		plan.rows.length < GROUP_SIZE ||
		askedNothingOutOfTime ||
		runStops(results, failuresBefore);
	return { asked, applied, stop };
}

/**
 * Sorts the waiting transactions in groups of 25 through `runStep` (see StepRunner). Merchant rules first (unless the
 * caller applied them), then for each group: read (turn taken, calls reserved), ask each row (a step of its own), and
 * write (one batch, the turn released). The run ends when a group reads nothing, when a write says so, or when the
 * calls or (in-process) the deadline run out. In-process, a throw releases the turn this run still holds.
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
	if (!env.JEV_API_KEY || options.onlyIds?.length === 0) return done;
	const apiKey = env.JEV_API_KEY;
	const maxCalls = options.maxCalls ?? Number.POSITIVE_INFINITY;
	const askedIds = new Set<number>();
	// The failures in a row the groups so far ended with, from their cached answers, so a replayed run counts the same.
	let streak = 0;
	let held: string | undefined;
	try {
		// Merchant rules are the household's own, so they apply whatever the AI switches say.
		if (!options.rulesApplied)
			await runStep("rules", STEP_SETTINGS.write, async () => {
				await applyMerchantRules(env.DB);
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
						onlyIds: options.onlyIds,
						exceptIds: [...askedIds],
						bySync: options.bySync ?? false,
						limit: Math.min(GROUP_SIZE, maxCalls - done.asked),
						turnId,
					});
					if (result.kind === "busy" && options.waitForTurn)
						throw new Error("sorting turn taken");
					return result;
				},
			);
			if (read.kind === "busy" || read.kind === "none") break;
			const { plan } = read;
			held = turnId;
			const results: AskResult[] = [];
			const before = streak;
			let outOfTime = false;
			for (const row of plan.rows) {
				if (pastDeadline(options.time)) {
					console.log("jev: stopped at the time budget");
					outOfTime = true;
					break;
				}
				results.push(
					await runStep(`group-${n}-ask-${row.id}`, STEP_SETTINGS.ask, (ctx) =>
						askOne(apiKey, plan, row, fetchImpl, ctx),
					),
				);
				if (askingStops(results, before)) break;
			}
			const written = await runStep(
				`group-${n}-write`,
				STEP_SETTINGS.write,
				() => writeGroup(env, plan, results, before),
			);
			held = undefined;
			streak = trailingFailures(results, before);
			done.asked += written.asked;
			done.applied += written.applied;
			for (const result of results)
				if (result.outcome !== "out-of-time") askedIds.add(result.id);
			if (written.stop || outOfTime) break;
		}
	} finally {
		// In-process, a throw must not leave this run's turn held for the next run (the Workflow's turn expires).
		if (!options.waitForTurn && held !== undefined)
			await releaseSortingTurn(env.DB, held);
	}
	return done;
}

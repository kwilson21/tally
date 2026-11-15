// The store lookup's privacy re-ask (spec §7 "When it runs", #1113): one step after the sorting groups asks Jev again about
// rows it answered that hold a store back only for want of a current mark. It asks only the transfer, income, reimbursement
// and payee questions, told the facts its fingerprint is taken of, and saves only each row's lookup_cleared row. The
// selection and the mark's SQL are here; the steps run through the sorting instance's step runner (sort-instance.ts).

import { askJev } from "../ai/categorize";
import { householdTimeZone, todayIn } from "../dates";
import { readAiSwitches, STILL_ON_SQL, stillOnKeys } from "../db/ai-switches";
import {
	dropReservedJevCallsStatement,
	giveBackReservedJevCallsStatement,
	reservedKeyFor,
} from "../db/jev-calls";
import {
	releaseSortingTurn,
	releaseSortingTurnStatement,
	takeSortingTurn,
	takeSortingTurnStatement,
	turnHeldSql,
} from "../db/sorting-turn";
import { type JevSeen, jevInputOf, seenSaveGuard } from "../db/transactions";
import {
	ASK_BUDGET_MS,
	type AskResult,
	askBlocked,
	failedAsk,
	reserveCalls,
	type SortEnv,
	STEP_SETTINGS,
	type StepRunner,
} from "../sort-groups";
import {
	type Eligibility,
	eligibility,
	type ReadEligibilityRow,
	readEligibilityRows,
} from "./eligibility";
import { lookupAsks } from "./gate";
import { clearsForLookup, inputMark } from "./input-mark";

/** Rows asked in one run at most (#1113). */
export const REASK_LIMIT = 10;

/** One row to ask: its id, its lookup text, and the facts Jev is told (the seen its mark is judged by). */
export type ReaskRow = { id: number; text: string; seen: JevSeen };

/**
 * The rows the re-ask asks about this run, pure (the selection table in #1113). A text is passed over unless its eligibility
 * is "rows" or "no_cleared", and passed over too when any of its rows is asked (its mark is "asked"), is still waiting for
 * Jev, has given up, or is answered and owed with no account to read its facts from: re-asking cannot make such a text
 * searchable, and a row still waiting would be asked later, after this one's calls were spent. Otherwise its
 * answered rows whose mark is owed are picked. Texts with the fewest owed rows come first, then by text; ids ascend within
 * a text.
 */
export function reaskPicks(
	rows: ReadEligibilityRow[],
	decided: Map<string, Eligibility>,
	limit: number,
): ReaskRow[] {
	const byText = new Map<string, ReadEligibilityRow[]>();

	for (const row of rows) {
		const group = byText.get(row.lookupText);

		if (group) group.push(row);
		else byText.set(row.lookupText, [row]);
	}

	const candidates: { text: string; owed: ReaskRow[] }[] = [];

	for (const [text, group] of byText) {
		const verdict = decided.get(text);

		if (
			verdict?.kind !== "not_yet" ||
			(verdict.why !== "rows" && verdict.why !== "no_cleared")
		)
			continue;

		const blocked = group.some(
			(row) =>
				row.mark === "asked" ||
				row.jev === "waiting" ||
				row.jev === "gave_up" ||
				(row.jev === "answered" && row.mark === "owed" && row.seen === null),
		);

		if (blocked) continue;

		const owed = group
			.flatMap((row): ReaskRow[] =>
				row.jev === "answered" && row.mark === "owed" && row.seen !== null
					? [{ id: row.id, text, seen: row.seen }]
					: [],
			)
			.sort((a, b) => a.id - b.id);

		if (owed.length > 0) candidates.push({ text, owed });
	}

	candidates.sort(
		(a, b) =>
			a.owed.length - b.owed.length ||
			(a.text < b.text ? -1 : a.text > b.text ? 1 : 0),
	);

	return candidates.flatMap((candidate) => candidate.owed).slice(0, limit);
}

/** What the read step hands the rest of the re-ask: the turn it holds, the day, the ask budget and the rows with their marks. */
export type ReaskPlan = {
	turnId: string;
	day: string;
	timeZone: string;
	askUntil: number;
	rows: (ReaskRow & { inputMark: string })[];
};

/**
 * The read, under the sorting turn: the switches, the day, every row once and the picks. Takes the turn first, and gives it
 * back and returns null when there is nothing to ask (a switch is off, another run holds the turn, nothing is picked). A
 * read that throws gives the turn back first.
 */
export async function readReask(
	env: SortEnv,
	{ turnId, bySync }: { turnId: string; bySync: boolean },
): Promise<ReaskPlan | null> {
	const db = env.DB;

	if (!(await takeSortingTurn(db, turnId))) return null;

	try {
		const switches = await readAiSwitches(db);

		if (!lookupAsks(env, switches) || (bySync && !switches.sortOnArrival)) {
			await releaseSortingTurn(db, turnId);

			return null;
		}

		const timeZone = await householdTimeZone(db);
		const day = todayIn(timeZone);
		const rows = await readEligibilityRows(db);
		const picks = reaskPicks(rows, eligibility(rows), REASK_LIMIT);

		if (picks.length === 0) {
			await releaseSortingTurn(db, turnId);

			return null;
		}

		return {
			turnId,
			day,
			timeZone,
			askUntil: Date.now() + ASK_BUDGET_MS,
			rows: await Promise.all(
				picks.map(async (pick) => ({
					...pick,
					inputMark: await inputMark(pick.seen),
				})),
			),
		};
	} catch (error) {
		await releaseSortingTurn(db, turnId);

		throw error;
	}
}

/**
 * One row's ask: the guards first (askBlocked), then Jev with the four privacy questions and no learned line, no category
 * and no details. It never throws; a failed call is a `failed` answer.
 */
export async function askReaskRow(
	apiKey: string,
	plan: ReaskPlan,
	row: ReaskPlan["rows"][number],
	fetchImpl:
		| ((url: string, init?: RequestInit) => Promise<Response>)
		| undefined,
	{ attempt }: { attempt: number },
): Promise<AskResult> {
	const blocked = askBlocked(row.id, { attempt }, plan);

	if (blocked) return blocked;

	try {
		const result = await askJev(jevInputOf(row.seen), [], apiKey, fetchImpl, {
			payee: true,
		});

		if (!result.ok) return failedAsk(row.id, result);

		return { id: row.id, outcome: "answered", answer: result.answer };
	} catch (error) {
		console.error(
			`privacy re-ask: ask failed ${error instanceof Error ? error.name : "unknown"}`,
		);

		return {
			id: row.id,
			outcome: "failed",
			status: null,
			requestId: null,
			serviceWide: true,
		};
	}
}

/**
 * One row's lookup_cleared save (#1113). It lands only while the row still reads as Jev was told (seenSaveGuard), the
 * sorting turn is held, and the lookup, categories and income switches are on. Nothing else in the row changes.
 */
export function reaskMarkStatement(
	db: D1Database,
	row: { id: number; inputMark: string; seen: JevSeen },
	cleared: boolean,
	turnId: string,
): D1PreparedStatement {
	const guard = seenSaveGuard(row.seen);

	return db
		.prepare(
			`INSERT INTO lookup_cleared (transaction_id, input_mark, cleared)
			SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM transactions WHERE transactions.id = ? AND ${guard.sql})
				AND ${STILL_ON_SQL} AND ${turnHeldSql()}
			ON CONFLICT(transaction_id) DO UPDATE SET input_mark = excluded.input_mark, cleared = excluded.cleared`,
		)
		.bind(
			row.id,
			row.inputMark,
			cleared ? 1 : 0,
			row.id,
			...guard.binds,
			stillOnKeys({ lookupStores: true, categories: true, income: true }),
			turnId,
		);
}

/**
 * The save, one batch (#1113): the turn is taken back while the record exists, each asked row's mark is written, what was
 * reserved and not asked goes back, the record is dropped, and the turn is released last. As writeGroup does, a release that
 * changed nothing throws while the record still exists (another run holds the turn), and otherwise finishes.
 */
export async function writeReask(
	env: SortEnv,
	plan: ReaskPlan,
	outcomes: AskResult[],
	granted: number,
): Promise<{ asked: number }> {
	const db = env.DB;
	const reservedKey = reservedKeyFor(plan.day, plan.turnId);
	const byId = new Map(plan.rows.map((row) => [row.id, row]));

	const statements: D1PreparedStatement[] = [
		takeSortingTurnStatement(db, plan.turnId, reservedKey),
	];

	let asked = 0;

	for (const outcome of outcomes) {
		const row = byId.get(outcome.id);

		// A row not reached, or cut by the cap or the budget, keeps its mark owed. Only a call that was made is marked.
		if (
			!row ||
			outcome.outcome === "out-of-time" ||
			outcome.outcome === "date-changed"
		)
			continue;

		asked += 1;
		statements.push(
			reaskMarkStatement(
				db,
				row,
				outcome.outcome === "answered" && clearsForLookup(outcome.answer),
				plan.turnId,
			),
		);
	}

	statements.push(
		giveBackReservedJevCallsStatement(db, {
			day: plan.day,
			planned: granted,
			asked,
			turnId: plan.turnId,
		}),
		dropReservedJevCallsStatement(db, plan.day, plan.turnId),
		releaseSortingTurnStatement(db, plan.turnId),
	);

	const saved = await db.batch(statements);

	if ((saved.at(-1)?.meta.changes ?? 0) === 0) {
		const record = await db
			.prepare("SELECT key FROM household_settings WHERE key = ?")
			.bind(reservedKey)
			.first();

		if (record) throw new Error("sorting turn taken");
	}

	return { asked };
}

/** The read step's settings: the sorting groups' read, four retries ten seconds apart (#1113). */
const READ_STEP = {
	retries: { limit: 4, delay: "10 seconds", backoff: "constant" },
	timeout: "1 minute",
	sensitive: "output",
} as const;

/**
 * The re-ask, run through `runStep` (the sorting instance's step runner): the read, the reservation, one ask step for each
 * granted row until one is not answered, then the save. A row whose ask step rejects counts as lost, as a group's does.
 * A throw from any step ends the re-ask for this run; the caller logs it.
 */
export async function runPrivacyReask(
	env: SortEnv,
	runStep: StepRunner,
	{
		runId,
		bySync,
		fetchImpl,
	}: {
		runId: string;
		bySync: boolean;
		fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
	},
): Promise<void> {
	const turnId = `${runId}:lookup-reask`;
	const apiKey = env.JEV_API_KEY;

	if (!apiKey) return;

	const plan = await runStep("lookup-reask-read", READ_STEP, () =>
		readReask(env, { turnId, bySync }),
	);

	if (!plan) return;

	let granted = 0;

	try {
		granted = (
			await runStep("lookup-reask-reserve", STEP_SETTINGS.reserve, () =>
				reserveCalls(env, {
					day: plan.day,
					turnId: plan.turnId,
					wanted: plan.rows.length,
				}),
			)
		).granted;
	} catch (error) {
		console.error(
			`privacy re-ask: reserve step ${error instanceof Error ? error.name : "unknown"}`,
		);
	}

	const outcomes: AskResult[] = [];

	for (const row of plan.rows.slice(0, granted)) {
		let outcome: AskResult;

		try {
			outcome = await runStep(
				`lookup-reask-row-${row.id}`,
				STEP_SETTINGS.ask,
				(ctx) => askReaskRow(apiKey, plan, row, fetchImpl, ctx),
			);
		} catch (error) {
			console.error(
				`privacy re-ask: ask step ${error instanceof Error ? error.name : "unknown"}`,
			);
			outcome = { id: row.id, outcome: "lost" };
		}

		outcomes.push(outcome);

		if (outcome.outcome !== "answered") break;
	}

	await runStep("lookup-reask-write", STEP_SETTINGS.write, () =>
		writeReask(env, plan, outcomes, granted),
	);
}

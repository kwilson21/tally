// The second ask (spec §7 "The second ask", §5:127; decision 225): after the sorting groups, the privacy re-ask and the store
// lookup, one step asks Jev once more about each open guess at a store whose line still stands. It asks the category alone,
// with the line as a labelled fact, keeps the line-backed guess only when Jev is more sure, and records each answer in
// lookup_answers, so a row is never asked twice. The steps run through the sorting instance's step runner (sort-instance.ts);
// the read and the save are plain TypeScript (no Effect), and the save is one batch under the sorting turn.

import { askJevCategoryOnly, type JevCategoryResult } from "../ai/categorize";
import { NONE_FIT } from "../ai/decide";
import { cleanBankText } from "../clean-bank-text";
import { householdTimeZone, todayIn } from "../dates";
import { readAiSwitches, STILL_ON_SQL, stillOnKeys } from "../db/ai-switches";
import { jevAsksAboutSql } from "../db/counted-month";
import {
	dropReservedJevCallsStatement,
	giveBackReservedJevCallsStatement,
	reservedKeyFor,
} from "../db/jev-calls";
import { merchantKeySql } from "../db/merchant-key";
import {
	releaseSortingTurn,
	releaseSortingTurnStatement,
	takeSortingTurn,
	takeSortingTurnStatement,
	turnHeldSql,
} from "../db/sorting-turn";
import {
	countWaitingForJev,
	type JevSeen,
	type JevSeenColumns,
	jevInputOf,
	jevSeenColumnsSql,
	jevSeenOf,
	seenSaveGuard,
} from "../db/transactions";
import { gaveUpSql } from "../machines/jev-retry";
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
import { lookupAsks } from "./gate";
import {
	householdAnsweredSql,
	learnedTexts,
	lineGuard,
	lineStandsSql,
	readLineForAsk,
} from "./line";
import { lookupTextOf } from "./lookup-text";
import { READ_STEP } from "./privacy-reask";

/** Rows asked in one run at most (spec §7: the day's cap is the other limit). */
export const SECOND_ASK_LIMIT = 10;

/** The switches a second-ask call and its save read: the lookup, categories and income, plus "Sort right away" for a sync. */
const secondAskSwitchKeys = (bySync: boolean) =>
	stillOnKeys({
		lookupStores: true,
		categories: true,
		income: true,
		sortOnArrival: bySync,
	});

/** A row the read picked: its lookup text, what Jev is told of it, its first guess and the cleaned bank texts of its store. */
export type SecondAskRow = {
	id: number;
	plaidTransactionId: string | null;
	text: string;
	seen: JevSeen;
	confidence: number;
	guessedCategoryId: number | null;
	cleanedTexts: string[];
};

/** What the read hands the rest of the second ask: the turn it holds, the day, the budget, the categories and the rows. */
export type SecondAskPlan = {
	turnId: string;
	day: string;
	timeZone: string;
	askUntil: number;
	bySync: boolean;
	categories: { id: number; name: string }[];
	rows: SecondAskRow[];
};

/** One row's outcome: the category Jev answered, or a line-less row that made no call, or the ask's failure or loss. */
export type SecondAskResult =
	| {
			id: number;
			outcome: "answered";
			category: { label: string; confidence: number };
	  }
	| { id: number; outcome: "no-line" }
	| { id: number; outcome: "yield" }
	| Exclude<AskResult, { outcome: "answered" }>;

/**
 * A row whose guess is open (spec §5, §7; 987-plan 5.1 point 4), with Q-B1: a row a pending new-category card asks about is not
 * second-asked. A dismissed card no longer asks, so its row stays owed. One fragment, used by the read and by the save.
 */
// stays raw: a fragment inlined into raw statements (decision 179)
export const openGuessSql = (
	a: string,
) => `(${a}.category_id IS NULL AND ${a}.category_source IS NULL AND ${a}.category_confidence IS NOT NULL
	AND ${a}.parent_id IS NULL AND ${a}.is_split = 0 AND ${a}.flag_income = 0 AND ${a}.pending = 0
	AND NOT EXISTS (SELECT 1 FROM category_suggestions ocs WHERE ocs.id = ${a}.category_suggestion_id AND ocs.status = 'pending')
	AND ${jevAsksAboutSql(a)} AND (${a}.amount_cents >= 0 OR COALESCE(${a}.credit_reviewed, 0) = 1)
	AND NOT ${gaveUpSql(a)})`;

/** The planned guess must still be open, unanswered, and about exactly the same input facts. */
function unchangedGuessGuard(row: SecondAskRow) {
	const seen = seenSaveGuard(row.seen);

	return {
		sql: `${openGuessSql("transactions")} AND transactions.plaid_transaction_id IS ? AND transactions.category_confidence = ? AND transactions.jev_category_id IS ?
			AND ${seen.sql}
			AND NOT EXISTS (SELECT 1 FROM lookup_answers gla WHERE gla.transaction_id = transactions.id)`,
		binds: [
			row.plaidTransactionId,
			row.confidence,
			row.guessedCategoryId,
			...seen.binds,
		],
	};
}

/** The owed rows the read selects: the seen columns, the guess and the lookup text. */
type OwedRow = JevSeenColumns & {
	id: number;
	plaidTransactionId: string | null;
	confidence: number;
	guessedCategoryId: number | null;
	lookupText: string;
};

/** The cleaned bank texts a lookup text's raw names hold, sorted and distinct (rule 6c reads them). Pure. */
export function cleanedFor(
	rawNames: { lookupText: string; rawName: string }[],
	text: string,
): string[] {
	return [
		...new Set(
			rawNames.flatMap((named) =>
				named.lookupText === text ? [cleanBankText(named.rawName)] : [],
			),
		),
	].sort();
}

/**
 * The rows the second ask asks about this run, pure. Each row is skipped when its store text is stale (its merchant key no
 * longer maps to the text), when a bank-text rule covers one of its store's cleaned texts, or when a learned line covers its
 * own cleaned text (the household answered for it). Otherwise the first `limit`, newest first, are kept.
 */
export function secondAskPicks(
	owed: OwedRow[],
	rawNames: { lookupText: string; rawName: string }[],
	ruleTexts: string[],
	learned: string[],
	limit: number,
): SecondAskRow[] {
	const picks: SecondAskRow[] = [];

	for (const row of owed) {
		if (lookupTextOf(row.merchantKey) !== row.lookupText) continue;

		const cleaned = cleanedFor(rawNames, row.lookupText);

		if (cleaned.some((text) => ruleTexts.includes(text))) continue;

		if (learned.includes(cleanBankText(row.rawName))) continue;

		picks.push({
			id: row.id,
			plaidTransactionId: row.plaidTransactionId,
			text: row.lookupText,
			seen: jevSeenOf(row),
			confidence: row.confidence,
			guessedCategoryId: row.guessedCategoryId,
			cleanedTexts: cleaned,
		});

		if (picks.length === limit) break;
	}

	return picks;
}

/**
 * The read, under the sorting turn: the switches, the waiting count, the owed rows, their raw names, the rule texts, the learned
 * lines and the categories. Takes the turn first, and gives it back and returns null when there is nothing to ask. A read that
 * throws gives the turn back first.
 */
export async function readSecondAsk(
	env: SortEnv,
	{ turnId, bySync }: { turnId: string; bySync: boolean },
): Promise<SecondAskPlan | null> {
	const db = env.DB;

	if (!(await takeSortingTurn(db, turnId))) return null;

	try {
		const switches = await readAiSwitches(db);

		if (!lookupAsks(env, switches) || (bySync && !switches.sortOnArrival)) {
			await releaseSortingTurn(db, turnId);

			return null;
		}

		if ((await countWaitingForJev(db, switches)) > 0) {
			await releaseSortingTurn(db, turnId);

			return null;
		}

		const timeZone = await householdTimeZone(db);
		const day = todayIn(timeZone);

		// SAFETY: the batch below lists exactly four statements, in the order of these four result types, so each D1Result is the
		// type of the statement at its position.
		const [owed, raw, rules, categories] = (await db.batch([
			db.prepare(
				`SELECT t.id AS id, t.plaid_transaction_id AS plaidTransactionId, t.category_confidence AS confidence, t.jev_category_id AS guessedCategoryId,
					mlt.lookup_text AS lookupText, ${jevSeenColumnsSql()}
				FROM transactions t JOIN accounts a ON a.id = t.account_id
				LEFT JOIN household_people hp ON hp.id = t.for_person_id
				JOIN merchant_lookup_texts mlt ON mlt.merchant_key = ${merchantKeySql("t")}
				WHERE ${openGuessSql("t")}
					AND NOT EXISTS (SELECT 1 FROM lookup_answers la WHERE la.transaction_id = t.id)
					AND ${lineStandsSql("mlt.lookup_text")} AND NOT ${householdAnsweredSql("mlt.lookup_text", "'[]'")}
				ORDER BY t.date DESC, t.id DESC`,
			),
			db.prepare(
				`SELECT DISTINCT mlt.lookup_text AS lookupText, t.raw_name AS rawName
				FROM transactions t JOIN merchant_lookup_texts mlt ON mlt.merchant_key = ${merchantKeySql("t")}
				WHERE ${lineStandsSql("mlt.lookup_text")}`,
			),
			db.prepare(
				`SELECT r.cleaned_text AS cleanedText FROM bank_text_rules r
				JOIN categories c ON c.id = r.category_id WHERE c.archived = 0`,
			),
			db.prepare(
				"SELECT id, name FROM categories WHERE archived = 0 ORDER BY sort_order",
			),
		])) as [
			D1Result<OwedRow>,
			D1Result<{ lookupText: string; rawName: string }>,
			D1Result<{ cleanedText: string }>,
			D1Result<{ id: number; name: string }>,
		];

		const learned = await learnedTexts(db);

		const picks = secondAskPicks(
			owed.results,
			raw.results,
			rules.results.map((rule) => rule.cleanedText),
			learned,
			SECOND_ASK_LIMIT,
		);

		if (categories.results.length === 0 || picks.length === 0) {
			await releaseSortingTurn(db, turnId);

			return null;
		}

		return {
			turnId,
			day,
			timeZone,
			askUntil: Date.now() + ASK_BUDGET_MS,
			bySync,
			categories: categories.results,
			rows: picks,
		};
	} catch (error) {
		await releaseSortingTurn(db, turnId);

		throw error;
	}
}

/**
 * One row's ask: the guards first (askBlocked), then the household's learned lines, then the line read just before the call
 * (readLineForAsk). Only then Jev, with the category alone. It never throws: a failed call is a `failed` answer, and a read that
 * throws rejects the step (the caller counts it lost).
 */
export async function askSecondRow(
	apiKey: string,
	db: D1Database,
	plan: SecondAskPlan,
	row: SecondAskRow,
	fetchImpl:
		| ((url: string, init?: RequestInit) => Promise<Response>)
		| undefined,
	{ attempt }: { attempt: number },
): Promise<SecondAskResult> {
	const blocked = askBlocked(row.id, { attempt }, plan);

	if (blocked && blocked.outcome !== "answered") return blocked;

	// A new row that waits for Jev takes the day's calls first (spec §7): this step yields with no call, and its grant goes back.
	if ((await countWaitingForJev(db, { categories: true, income: true })) > 0) {
		return { id: row.id, outcome: "yield" };
	}

	const learned = await learnedTexts(db);

	if (learned.includes(cleanBankText(row.seen.rawName))) {
		return { id: row.id, outcome: "no-line" };
	}

	// The store's bank texts as they stand now: a raw name a sync added since the plan counts (rule 6c).
	const current = await db
		.prepare(
			`SELECT DISTINCT mlt.lookup_text AS lookupText, t.raw_name AS rawName
			FROM transactions t JOIN merchant_lookup_texts mlt ON mlt.merchant_key = ${merchantKeySql("t")}
			WHERE mlt.lookup_text = ?`,
		)
		.bind(row.text)
		.all<{ lookupText: string; rawName: string }>();

	const line = await readLineForAsk(db, {
		text: row.text,
		cleanedTexts: cleanedFor(current.results, row.text),
		switchKeys: secondAskSwitchKeys(plan.bySync),
	});

	if (line === null) return { id: row.id, outcome: "no-line" };

	// A later save cannot undo transmitting a note that was edited or removed after the plan.
	// Skip stale rows instead of rebuilding their input without a matching saved-plan guard.
	const guess = unchangedGuessGuard(row);

	const stillOwed = await db
		.prepare(
			`SELECT transactions.id FROM transactions WHERE transactions.id = ? AND ${guess.sql} AND ${turnHeldSql()}`,
		)
		.bind(row.id, ...guess.binds, plan.turnId)
		.first();

	if (!stillOwed) return { id: row.id, outcome: "no-line" };

	try {
		const result: JevCategoryResult = await askJevCategoryOnly(
			{ ...jevInputOf(row.seen), storeLookup: line },
			plan.categories.map((category) => category.name),
			apiKey,
			fetchImpl,
		);

		if (!result.ok) return failedAsk(row.id, result);

		return { id: row.id, outcome: "answered", category: result.category };
	} catch (error) {
		console.error(
			`second ask: ask failed ${error instanceof Error ? error.name : "unknown"}`,
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

/** What a row's save does: nothing, keep the line-backed guess, record that it was not kept, record only the call, or nothing (refused). */
type Move =
	| { kind: "none" }
	| { kind: "keep"; categoryId: number; confidence: number }
	| { kind: "not_kept" }
	| { kind: "asked" }
	| { kind: "refused" };

/**
 * The move for one row's outcome, pure (spec §5:127 and §7; 987-plan 5.3). A row the household has an answer for (a learned line on
 * its cleaned text) is refused. A None fit, a category not offered, and a tie or less sure answer are not kept. Only a more sure
 * category is kept, and it names a category that is still active.
 */
export function answerMove(
	row: SecondAskRow,
	outcome: SecondAskResult,
	categories: { id: number; name: string }[],
	learned: string[],
): Move {
	if (outcome.outcome !== "answered") {
		return outcome.outcome === "failed" || outcome.outcome === "lost"
			? { kind: "asked" }
			: { kind: "none" };
	}

	if (learned.includes(cleanBankText(row.seen.rawName)))
		return { kind: "refused" };

	const named = categories.find(
		(category) => category.name === outcome.category.label,
	);

	if (
		outcome.category.label === NONE_FIT ||
		!named ||
		outcome.category.confidence <= row.confidence
	)
		return { kind: "not_kept" };

	return {
		kind: "keep",
		categoryId: named.id,
		confidence: outcome.category.confidence,
	};
}

/**
 * The statements one row's move writes, in order. Every insert selects from `transactions`, so a row deleted since the read
 * writes nothing rather than failing the batch on the foreign key. The guard holds the guess, the seen facts, the line, the
 * switches and the turn, and no answer yet.
 */
function moveStatements(
	db: D1Database,
	row: SecondAskRow,
	move: Move,
	plan: SecondAskPlan,
): D1PreparedStatement[] {
	if (move.kind === "none" || move.kind === "refused") return [];

	if (move.kind === "asked") {
		return [
			db
				.prepare(
					`INSERT INTO lookup_answers (transaction_id, lookup_text, kept)
					SELECT transactions.id, ?, 0 FROM transactions WHERE transactions.id = ?
						AND transactions.plaid_transaction_id IS ? AND transactions.amount_cents = ?
						AND NOT EXISTS (SELECT 1 FROM lookup_answers fla WHERE fla.transaction_id = transactions.id) AND ${turnHeldSql()}`,
				)
				.bind(
					row.text,
					row.id,
					row.plaidTransactionId,
					row.seen.amountCents,
					plan.turnId,
				),
		];
	}

	const guess = unchangedGuessGuard(row);
	const line = lineGuard(row.text, row.cleanedTexts);

	const guard = {
		sql: `${guess.sql} AND ${line.sql} AND ${STILL_ON_SQL} AND ${turnHeldSql()}`,
		binds: [
			...guess.binds,
			...line.binds,
			secondAskSwitchKeys(plan.bySync),
			plan.turnId,
		],
	};

	if (move.kind === "not_kept") {
		return [
			db
				.prepare(
					`INSERT INTO lookup_answers (transaction_id, lookup_text, kept)
					SELECT transactions.id, ?, 0 FROM transactions WHERE transactions.id = ? AND ${guard.sql}`,
				)
				.bind(row.text, row.id, ...guard.binds),
		];
	}

	// keep: the guess moves to the line-backed one; the copies are taken from the row by SQL, after the update.
	return [
		db
			.prepare(
				`UPDATE transactions SET category_confidence = ?, jev_category_id = ?, jev_none_fit = 0, jev_mixed = NULL,
					jev_also_category_id = NULL, updated_at = datetime('now')
				WHERE transactions.id = ? AND ${guard.sql} AND EXISTS (SELECT 1 FROM categories sac WHERE sac.id = ? AND sac.archived = 0)`,
			)
			.bind(
				move.confidence,
				move.categoryId,
				row.id,
				...guard.binds,
				move.categoryId,
			),
		db
			.prepare(
				`INSERT INTO lookup_answers (transaction_id, lookup_text, kept, kept_category_id, kept_confidence)
				SELECT transactions.id, ?, 1, transactions.jev_category_id, transactions.category_confidence
				FROM transactions WHERE transactions.id = ? AND changes() > 0`,
			)
			.bind(row.text, row.id),
	];
}

/**
 * The save, one batch under the sorting turn (spec §7; 987-plan 5.3): the turn is taken back while its record exists, each row's
 * move is written, what was reserved and not called goes back, the record is dropped, and the turn is released last. A release that
 * changed nothing throws while the record still exists (another run holds the turn), as writeReask does.
 */
export async function writeSecondAsk(
	env: SortEnv,
	plan: SecondAskPlan,
	outcomes: SecondAskResult[],
	granted: number,
): Promise<{ asked: number }> {
	const db = env.DB;
	const reservedKey = reservedKeyFor(plan.day, plan.turnId);
	const learned = await learnedTexts(db);

	// One read for every text in the plan: the bank texts as they stand at the save (rule 6c, the save's own guard).
	const current = await db
		.prepare(
			`SELECT DISTINCT mlt.lookup_text AS lookupText, t.raw_name AS rawName
			FROM transactions t JOIN merchant_lookup_texts mlt ON mlt.merchant_key = ${merchantKeySql("t")}
			WHERE mlt.lookup_text IN (SELECT value FROM json_each(?))`,
		)
		.bind(JSON.stringify([...new Set(plan.rows.map((row) => row.text))]))
		.all<{ lookupText: string; rawName: string }>();

	const statements: D1PreparedStatement[] = [
		takeSortingTurnStatement(db, plan.turnId, reservedKey),
	];

	let asked = 0;

	for (const outcome of outcomes) {
		const planned = plan.rows.find((candidate) => candidate.id === outcome.id);

		if (!planned) continue;

		const row = {
			...planned,
			cleanedTexts: cleanedFor(current.results, planned.text),
		};

		// A call was made for an answer, a failure or a loss, so each is charged; a row never reached, or cut by the budget, is not.
		if (
			outcome.outcome === "answered" ||
			outcome.outcome === "failed" ||
			outcome.outcome === "lost"
		)
			asked += 1;

		statements.push(
			...moveStatements(
				db,
				row,
				answerMove(row, outcome, plan.categories, learned),
				plan,
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

/**
 * The second ask, run through `runStep` (the sorting instance's step runner): the read, the reservation, one ask step for each
 * granted row until one is not answered and not left without a line, then the save. A row whose ask step rejects counts as lost.
 * With no Jev key it returns at once. A throw from the read or the save ends the second ask for this run; the caller logs it.
 */
export async function runSecondAsk(
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
	const turnId = `${runId}:lookup-second`;
	const apiKey = env.JEV_API_KEY;

	if (!apiKey) return;

	const plan = await runStep("lookup-second-read", READ_STEP, () =>
		readSecondAsk(env, { turnId, bySync }),
	);

	if (!plan) return;

	let granted = 0;

	try {
		granted = (
			await runStep("lookup-second-reserve", STEP_SETTINGS.reserve, () =>
				reserveCalls(env, {
					day: plan.day,
					turnId: plan.turnId,
					wanted: plan.rows.length,
				}),
			)
		).granted;
	} catch (error) {
		console.error(
			`second ask: reserve step ${error instanceof Error ? error.name : "unknown"}`,
		);
	}

	const outcomes: SecondAskResult[] = [];

	// A row with no line makes no call and takes no grant, so the next owed row takes its place (review round 2).
	let made = 0;

	for (const row of plan.rows) {
		if (made >= granted) break;

		let outcome: SecondAskResult;

		try {
			outcome = await runStep(
				`lookup-second-row-${row.id}`,
				STEP_SETTINGS.ask,
				(ctx) => askSecondRow(apiKey, env.DB, plan, row, fetchImpl, ctx),
			);
		} catch (error) {
			console.error(
				`second ask: ask step ${error instanceof Error ? error.name : "unknown"}`,
			);
			outcome = { id: row.id, outcome: "lost" };
		}

		outcomes.push(outcome);

		if (
			outcome.outcome === "answered" ||
			outcome.outcome === "failed" ||
			outcome.outcome === "lost"
		)
			made += 1;

		if (outcome.outcome !== "answered" && outcome.outcome !== "no-line") break;
	}

	await runStep("lookup-second-write", STEP_SETTINGS.write, () =>
		writeSecondAsk(env, plan, outcomes, granted),
	);
}

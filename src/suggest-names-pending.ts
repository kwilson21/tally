// The nightly names step (spec §7, §9): Workers AI suggests names for the bank texts Plaid didn't name. In
// production it runs last in the 09:20 run, after that run's Jev pass, and the demo's one run names after
// Jev too (src/index.tsx); in both it stops starting requests once its deadline has passed
// (src/run-budget.ts). It only ever makes pending suggestions; a person chooses (decision 64).
import { suggestNames, suggestNote } from "./ai/suggest-name";
import { readAiSwitches } from "./db/ai-switches";
import { merchantsToAsk, saveAskedNames } from "./db/merchant-names";
import {
	saveNoteAttempts,
	transactionsNeedingNoteGuess,
} from "./db/transactions";
import { type Deadline, pastDeadline } from "./run-budget";

/**
 * How many bank texts one night asks about: 100, about three D1 queries each. In production they follow
 * the 09:20 run's Jev pass, so that run's 200 Jev calls and 100 names are about 900 of the 1,000 queries one
 * invocation may make (test/scheduled.test.ts). Each answer is saved as it arrives, so a run cut short keeps
 * its work and the rest wait for the next night.
 */
export const nameCallLimit = 100;
const SWITCH_CHECK_BATCH = 25;
// Details are the only work here whose raw text goes to a second model after Jev; cap switch lag at five calls.
const DETAIL_SWITCH_CHECK_BATCH = 5;

/** Failures in a row that point at every call (the service is down) rather than one bank text. */
const MAX_FAILURES_IN_A_ROW = 3;

type NamesEnv = {
	DB: D1Database;
	/** Workers AI. Production and the demo have it (wrangler.jsonc); local development and tests don't, so no name is asked for there. */
	AI?: Ai;
};

/** Writes notes for details Jev has already asked about, sharing the night's Workers AI call limit. */
export async function suggestTransactionNotes(
	env: NamesEnv,
	limit = nameCallLimit,
	time?: Deadline,
): Promise<{ asked: number; suggested: number }> {
	const done = { asked: 0, suggested: 0 };
	if (!env.AI || limit <= 0 || pastDeadline(time)) return done;
	if (!(await readAiSwitches(env.DB)).details) return done;
	const transactions = await transactionsNeedingNoteGuess(env.DB, limit);
	let failuresInARow = 0;
	for (let i = 0; i < transactions.length; i += DETAIL_SWITCH_CHECK_BATCH) {
		const attempted: number[] = [];
		const guesses: { id: number; note: string }[] = [];
		for (const transaction of transactions.slice(
			i,
			i + DETAIL_SWITCH_CHECK_BATCH,
		)) {
			if (pastDeadline(time)) break;
			done.asked += 1;
			attempted.push(transaction.id);
			const result = await suggestNote(env.AI, transaction.rawName);
			if (!result.ok) {
				failuresInARow += 1;
				if (failuresInARow >= MAX_FAILURES_IN_A_ROW) break;
				continue;
			}
			failuresInARow = 0;
			if (result.note !== null)
				guesses.push({ id: transaction.id, note: result.note });
		}
		// Keep or discard this small batch together if the details switch changed during an AI call.
		const detailsOn = (await readAiSwitches(env.DB)).details;
		await saveNoteAttempts(env.DB, attempted, detailsOn ? guesses : []);
		if (!detailsOn) break;
		done.suggested += guesses.length;
		if (failuresInARow >= MAX_FAILURES_IN_A_ROW || pastDeadline(time)) break;
	}
	console.log(
		`workers-ai: notes asked ${done.asked}, suggested ${done.suggested}`,
	);
	return done;
}

/**
 * Asks Workers AI for each bank text that needs it, most charges first, while the household's names
 * switch is on (spec §8.6). The switch is checked once after each batch of at most 25 calls: it can be
 * turned off during a call, in which case the answers from that batch are thrown away.
 * A failed call leaves its merchant to be asked tomorrow; three in a row stop the run. With a `time`, no new
 * request starts once its deadline has passed, so slow requests can't hold up the rest of the run; what was
 * answered by then is kept and the rest wait for the next night.
 */
export async function suggestMerchantNames(
	env: NamesEnv,
	limit = nameCallLimit,
	time?: Deadline,
): Promise<{ asked: number; suggested: number }> {
	const done = { asked: 0, suggested: 0 };
	const ai = env.AI;
	if (!ai) return done;
	if (pastDeadline(time)) return done;
	if (!(await readAiSwitches(env.DB)).names) return done;

	let failuresInARow = 0;
	const rawNames = await merchantsToAsk(env.DB, limit);
	for (let i = 0; i < rawNames.length; i += SWITCH_CHECK_BATCH) {
		const answers: { rawName: string; names: string[] }[] = [];
		for (const rawName of rawNames.slice(i, i + SWITCH_CHECK_BATCH)) {
			if (pastDeadline(time)) {
				console.log("workers-ai: names stopped at the time budget");
				break;
			}
			done.asked += 1;
			const result = await suggestNames(ai, rawName);
			if (!result.ok) {
				failuresInARow += 1;
				if (failuresInARow >= MAX_FAILURES_IN_A_ROW) break;
				continue;
			}
			failuresInARow = 0;
			answers.push({ rawName, names: result.names });
		}
		// The old per-answer read protected against a switch turned off mid-run. One read per batch
		// preserves that boundary without spending two D1 queries on every merchant.
		if (!(await readAiSwitches(env.DB)).names) break;
		done.suggested += await saveAskedNames(env.DB, answers);
		if (failuresInARow >= MAX_FAILURES_IN_A_ROW || pastDeadline(time)) break;
	}
	console.log(`workers-ai: asked ${done.asked}, suggested ${done.suggested}`);
	return done;
}

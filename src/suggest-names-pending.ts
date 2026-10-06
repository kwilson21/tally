// The nightly names step (spec §7, §9): Workers AI suggests names for the bank texts Plaid didn't name. In
// production it runs last in the 09:20 run, after that run's Jev pass, and the demo's one run names after
// Jev too (src/index.tsx); in both it stops starting requests once its deadline has passed
// (src/run-budget.ts). It only ever makes pending suggestions; a person chooses (decision 64).
import { suggestNames, suggestNote } from "./ai/suggest-name";
import { readAiSwitches } from "./db/ai-switches";
import { merchantsToAsk, saveAskedNames } from "./db/merchant-names";
import {
	saveNoteGuesses,
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
	const guesses: { id: number; note: string }[] = [];
	let failuresInARow = 0;
	for (const transaction of await transactionsNeedingNoteGuess(env.DB, limit)) {
		if (pastDeadline(time)) break;
		if (!(await readAiSwitches(env.DB)).details) break;
		done.asked += 1;
		const note = await suggestNote(env.AI, transaction.rawName);
		if (note === null) {
			failuresInARow += 1;
			if (failuresInARow >= MAX_FAILURES_IN_A_ROW) break;
			continue;
		}
		failuresInARow = 0;
		if ((await readAiSwitches(env.DB)).details)
			guesses.push({ id: transaction.id, note });
	}
	await saveNoteGuesses(env.DB, guesses);
	done.suggested = guesses.length;
	console.log(
		`workers-ai: notes asked ${done.asked}, suggested ${done.suggested}`,
	);
	return done;
}

/**
 * Asks Workers AI for each bank text that needs it, most charges first, while the household's names
 * switch is on (spec §8.6). The switch is read again before each call and before each answer is kept,
 * since it can be turned off while a run is going: an answer that comes back after that is thrown away.
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
	for (const rawName of await merchantsToAsk(env.DB, limit)) {
		if (pastDeadline(time)) {
			console.log("workers-ai: names stopped at the time budget");
			break;
		}
		if (!(await readAiSwitches(env.DB)).names) break;
		done.asked += 1;
		const result = await suggestNames(ai, rawName);
		if (!result.ok) {
			failuresInARow += 1;
			if (failuresInARow >= MAX_FAILURES_IN_A_ROW) break;
			continue;
		}
		failuresInARow = 0;
		// Read again, since the call took a while: an answer is kept only while the switch is still on.
		if (!(await readAiSwitches(env.DB)).names) break;
		if (await saveAskedNames(env.DB, rawName, result.names)) {
			if (result.names.length > 0) done.suggested += 1;
		}
	}
	console.log(`workers-ai: asked ${done.asked}, suggested ${done.suggested}`);
	return done;
}

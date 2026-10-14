// The nightly names step (spec §7, §9): Workers AI suggests names for the bank texts Plaid didn't name. In
// production it runs last in the 09:20 run, after that run's Jev pass, and the demo's one run names after
// Jev too (src/index.tsx); in both it stops starting requests once its deadline has passed
// (src/run-budget.ts). It only ever makes pending suggestions; a person chooses (decision 64).
import { restatesStore, suggestNames, suggestNote } from "./ai/suggest-name";
import { readAiSwitches } from "./db/ai-switches";
import { merchantsToAsk, saveAskedNames } from "./db/merchant-names";
import {
	noteNameRows,
	saveNoteAttempts,
	transactionsNeedingNoteGuess,
} from "./db/transactions";
import { type Deadline, pastDeadline } from "./run-budget";
import { usableSuggestedNames } from "./transactions/name-suggestions";

/**
 * How many bank texts one night asks about: 100, about three D1 queries each. In production they follow
 * the 09:20 run's Jev pass, so that run's 200 Jev calls and 100 names are about 900 of the 1,000 queries one
 * invocation may make (test/scheduled.test.ts). Each answer is saved as it arrives, so a run cut short keeps
 * its work and the rest wait for the next night.
 */
export const nameCallLimit = 100;
// While a name waits, notes take at most half the night's calls, so the names always get the other half (#458).
const noteCallLimitWhileNamesWait = Math.floor(nameCallLimit / 2);
// The switches are read after every five calls, so one turned off mid-run stops within five; a batch's
// answers are kept or dropped together.
const SWITCH_CHECK_BATCH = 5;

/** Failures in a row that point at every call (the service is down) rather than one bank text. */
const MAX_FAILURES_IN_A_ROW = 3;

type NamesEnv = {
	DB: D1Database;
	/** Workers AI. Production and the demo have it (wrangler.jsonc); local development and tests don't, so no name is asked for there. */
	AI?: Ai;
};

/**
 * Writes notes for details Jev has already asked about, sharing the night's Workers AI call limit. A note that
 * only restates a name the row shows is dropped, checked against the names as they are just before the batch is
 * saved, since a person may name the charge during its call (#412). The batch's names cost one read, and none when
 * it has no note.
 */
export async function suggestTransactionNotes(
	env: NamesEnv,
	limit = nameCallLimit,
	time?: Deadline,
): Promise<{ asked: number; suggested: number }> {
	const done = { asked: 0, suggested: 0 };
	if (!env.AI || limit <= 0 || pastDeadline(time)) return done;
	const switches = await readAiSwitches(env.DB);
	if (!switches.details) return done;
	const transactions = await transactionsNeedingNoteGuess(env.DB, limit);
	let failuresInARow = 0;
	for (let i = 0; i < transactions.length; i += SWITCH_CHECK_BATCH) {
		const answered: number[] = [];
		const failed: number[] = [];
		const guesses: { id: number; note: string }[] = [];
		for (const transaction of transactions.slice(i, i + SWITCH_CHECK_BATCH)) {
			if (pastDeadline(time)) break;
			done.asked += 1;
			const result = await suggestNote(env.AI, transaction.rawName);
			if (!result.ok) {
				failed.push(transaction.id);
				failuresInARow += 1;
				if (failuresInARow >= MAX_FAILURES_IN_A_ROW) break;
				continue;
			}
			failuresInARow = 0;
			answered.push(transaction.id);
			if (result.note !== null)
				guesses.push({ id: transaction.id, note: result.note });
		}
		// Keep or discard this small batch together if the details switch changed during an AI call.
		const current = await readAiSwitches(env.DB);
		if (!current.details) break;
		const kept = await notesNotRestatingShownNames(
			env.DB,
			guesses,
			current.names,
		);
		// Answered calls are remembered as tried, even when their note is dropped; a failed one stays untried and is asked again tomorrow, after the rest.
		await saveNoteAttempts(env.DB, answered, kept, failed);
		done.suggested += kept.length;
		if (failuresInARow >= MAX_FAILURES_IN_A_ROW || pastDeadline(time)) break;
	}
	console.log(
		`workers-ai: notes asked ${done.asked}, suggested ${done.suggested}`,
	);
	return done;
}

/**
 * The guesses that don't only restate the store by the bank text or a name the row shows as it is now: the
 * charge's own name, its merchant's name, and the merchant's usable suggestions (decision 103, #412). One read
 * for the guesses' rows, and none when there are no guesses.
 */
async function notesNotRestatingShownNames(
	db: D1Database,
	guesses: { id: number; note: string }[],
	namesOn: boolean,
): Promise<{ id: number; note: string }[]> {
	if (guesses.length === 0) return guesses;
	const rows = await noteNameRows(
		db,
		guesses.map((guess) => guess.id),
	);
	const byId = new Map(rows.map((row) => [row.id, row]));
	return guesses.filter(({ id, note }) => {
		const row = byId.get(id);
		return (
			row !== undefined &&
			!restatesStore(note, [
				row.rawName,
				row.merchantName,
				row.displayName,
				row.ownName,
				...usableSuggestedNames({
					stored: row.suggestedNames,
					status: row.suggestionStatus,
					key: row.merchantKey,
					namesOn,
				}),
			])
		);
	});
}

/**
 * Asks Workers AI for each bank text that needs it, most charges first, while the household's names
 * switch is on (spec §8.6). The switch is checked after each batch of at most five calls: it can be
 * turned off during a call, in which case the answers from that batch are thrown away.
 * A failed call is recorded and its merchant is asked again on a later night, after the merchants never tried
 * (#468); three in a row stop the run. With a `time`, no new
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
		const failed: string[] = [];
		for (const rawName of rawNames.slice(i, i + SWITCH_CHECK_BATCH)) {
			if (pastDeadline(time)) {
				console.log("workers-ai: names stopped at the time budget");
				break;
			}
			done.asked += 1;
			const result = await suggestNames(ai, rawName);
			if (!result.ok) {
				// Recorded before the stop below, so the failure that ends the run is in this batch's write too.
				failed.push(rawName);
				failuresInARow += 1;
				if (failuresInARow >= MAX_FAILURES_IN_A_ROW) break;
				continue;
			}
			failuresInARow = 0;
			answers.push({ rawName, names: result.names });
		}
		// One read per batch of five keeps the switch boundary (a switch turned off mid-run stops it)
		// without a D1 read for every merchant.
		if (!(await readAiSwitches(env.DB)).names) break;
		// A batch's answers and failed calls are saved in one D1 batch.
		done.suggested += await saveAskedNames(env.DB, answers, failed);
		if (failuresInARow >= MAX_FAILURES_IN_A_ROW || pastDeadline(time)) break;
	}
	console.log(`workers-ai: asked ${done.asked}, suggested ${done.suggested}`);
	return done;
}

/**
 * The night's notes, then its names (spec §7), sharing `nameCallLimit` Workers AI calls. While a name waits, notes
 * take at most `noteCallLimitWhileNamesWait` and the names get the rest, so untried notes can't leave them no calls
 * (#458). With none waiting, notes may use the whole limit, and the names get what the notes didn't ask.
 */
export async function suggestNightlyNames(
	env: NamesEnv,
	time?: Deadline,
): Promise<void> {
	const notesLimit = (await namesWaiting(env))
		? noteCallLimitWhileNamesWait
		: nameCallLimit;
	const notes = await suggestTransactionNotes(env, notesLimit, time);
	await suggestMerchantNames(env, nameCallLimit - notes.asked, time);
}

/**
 * Whether the names step has a merchant to ask about tonight: the names switch is on and one is waiting. It is the
 * names' own query for one row, plus the switch read (#458).
 */
async function namesWaiting(env: NamesEnv): Promise<boolean> {
	if (!env.AI) return false;
	if (!(await readAiSwitches(env.DB)).names) return false;
	return (await merchantsToAsk(env.DB, 1)).length > 0;
}

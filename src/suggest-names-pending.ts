// The nightly names step (spec §7, §9): Workers AI suggests names for the bank texts Plaid didn't name. In
// production it runs first in the 09:40 run, ahead of that run's Jev pass (src/index.tsx); the demo's one run
// names after Jev. It only ever makes pending suggestions; a person chooses (decision 64).
import { suggestNames } from "./ai/suggest-name";
import { readAiSwitches } from "./db/ai-switches";
import { merchantsToAsk, saveAskedNames } from "./db/merchant-names";

/**
 * How many bank texts one night asks about: 100, about three D1 queries each, which leaves the 09:40
 * run room for its Jev pass inside the 1,000 queries one invocation may make. Each answer is saved as it
 * arrives, so a run cut short keeps its work and the rest wait for the next night.
 */
export const nameCallLimit = 100;

/** Failures in a row that point at every call (the service is down) rather than one bank text. */
const MAX_FAILURES_IN_A_ROW = 3;

type NamesEnv = {
	DB: D1Database;
	/** Workers AI. Production and the demo have it (wrangler.jsonc); local development and tests don't, so no name is asked for there. */
	AI?: Ai;
};

/**
 * Asks Workers AI for each bank text that needs it, most charges first, while the household's names
 * switch is on (spec §8.6). The switch is read again before each call and before each answer is kept,
 * since it can be turned off while a run is going: an answer that comes back after that is thrown away.
 * A failed call leaves its merchant to be asked tomorrow; three in a row stop the run.
 */
export async function suggestMerchantNames(
	env: NamesEnv,
	limit = nameCallLimit,
): Promise<{ asked: number; suggested: number }> {
	const done = { asked: 0, suggested: 0 };
	const ai = env.AI;
	if (!ai) return done;
	if (!(await readAiSwitches(env.DB)).names) return done;

	let failuresInARow = 0;
	for (const rawName of await merchantsToAsk(env.DB, limit)) {
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

// When the store lookup may ask Jev its payee question (spec §7, "When it runs"). Both halves are closed today: no
// TAVILY_API_KEY is set, and the demo's cap is 0, so the demo and production behave as before this file existed.

import type { AiSwitches } from "../db/ai-switches";

/** How many stores the lookup may search in a day: 300 in production, none in the demo (spec §7). */
export const storeLookupDailyCap = (env: { DEMO?: string }) =>
	env.DEMO === "false" ? 300 : 0;

/**
 * True only while the lookup's switch is on (strictly: a plan cached before the switch existed has no such field),
 * Jev's category and income answers are kept, a Tavily key is set and the day's cap is above 0.
 */
export function lookupAsks(
	env: { DEMO?: string; TAVILY_API_KEY?: string },
	switches: Pick<AiSwitches, "categories" | "income"> & {
		lookupStores?: boolean;
	},
): boolean {
	return (
		switches.lookupStores === true &&
		switches.categories &&
		switches.income &&
		Boolean(env.TAVILY_API_KEY) &&
		storeLookupDailyCap(env) > 0
	);
}

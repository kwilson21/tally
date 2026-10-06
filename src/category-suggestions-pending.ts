import { suggestCategoryName } from "./ai/suggest-name";
import { groupNoneFit } from "./category-suggestions";
import { readAiSwitches } from "./db/ai-switches";
import {
	namesToAvoid,
	noneFitTransactions,
	saveSuggestion,
} from "./db/category-suggestions";

export const categoryCallLimit = 5;
export async function suggestNewCategories(
	env: { DB: D1Database; AI?: Ai },
	limit = categoryCallLimit,
	time?: { deadline?: number; now?: () => number },
): Promise<{ asked: number; suggested: number }> {
	if (!env.AI || !(await readAiSwitches(env.DB)).categories)
		return { asked: 0, suggested: 0 };
	const deadline = time?.deadline ?? Number.POSITIVE_INFINITY;
	const now = time?.now ?? Date.now;
	const groups = groupNoneFit(await noneFitTransactions(env.DB));
	let asked = 0;
	let suggested = 0;
	let failures = 0;
	for (const group of groups.slice(0, limit)) {
		if (now() >= deadline || failures >= 3) break;
		const avoid = await namesToAvoid(env.DB);
		const result = await suggestCategoryName(env.AI, group.merchants, avoid);
		asked++;
		if (!result.ok) {
			failures++;
			continue;
		}
		failures = 0;
		if (!(await readAiSwitches(env.DB)).categories) break;
		await saveSuggestion(env.DB, result.name, group.ids, avoid);
		const accepted = Boolean(
			result.name &&
				!avoid.some(
					(name) => name.toLowerCase() === result.name?.toLowerCase(),
				),
		);
		if (accepted) suggested++;
		console.log(
			`workers-ai: category suggestion asked=1 suggested=${accepted ? 1 : 0}`,
		);
	}
	return { asked, suggested };
}

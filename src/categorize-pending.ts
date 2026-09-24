// The nightly categorization step (spec §7): merchant rules first, then Jev for the rest.
import { askJev, JEV_THRESHOLD } from "./ai/categorize";
import { decide } from "./ai/decide";
import {
	applyMerchantRules,
	pendingForJev,
	saveJevResult,
} from "./db/transactions";

/** Enough for a day of family transactions; the rest wait for the next night. */
export const MAX_JEV_CALLS = 40;

type CategorizeEnv = { DB: D1Database; JEV_API_KEY?: string };

export async function categorizePending(
	env: CategorizeEnv,
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<{ asked: number; applied: number }> {
	const done = { asked: 0, applied: 0 };
	if (!env.JEV_API_KEY) return done;

	await applyMerchantRules(env.DB);

	const { results: categories } = await env.DB.prepare(
		"SELECT id, name FROM categories WHERE archived = 0 ORDER BY sort_order",
	).all<{ id: number; name: string }>();
	const names = categories.map((c) => c.name);

	for (const tx of await pendingForJev(env.DB, MAX_JEV_CALLS)) {
		done.asked += 1;
		const result = await askJev(tx, names, env.JEV_API_KEY, fetchImpl);
		if (!result.ok) {
			// Status and request id only: never the key or anything about the transaction.
			console.error(
				`jev: ${result.status ?? "no response"} ${result.requestId ?? ""}`.trim(),
			);
			return done;
		}
		const decision = decide(result.answer, categories, JEV_THRESHOLD);
		const written = await saveJevResult(env.DB, tx.id, decision);
		if (written && decision.categoryId !== null) done.applied += 1;
	}

	console.log(`jev: asked ${done.asked}, applied ${done.applied}`);
	return done;
}

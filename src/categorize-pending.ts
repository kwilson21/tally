// The nightly categorization step (spec §7): merchant rules first, then Jev for the rest.
import { askJev, JEV_THRESHOLD } from "./ai/categorize";
import { decide } from "./ai/decide";
import {
	applyMerchantRules,
	markJevFailed,
	pendingForJev,
	saveJevResult,
} from "./db/transactions";

/** Enough for a day of family transactions; the rest wait for the next night. */
export const MAX_JEV_CALLS = 40;

/** Failures in a row that point at every call (say, a changed API) rather than one transaction. */
const MAX_FAILURES_IN_A_ROW = 3;

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
	// With nothing to offer, Jev could only say "none fit", which would mark every row as looked at.
	if (categories.length === 0) return done;
	const names = categories.map((c) => c.name);

	let failuresInARow = 0;
	for (const tx of await pendingForJev(env.DB, MAX_JEV_CALLS)) {
		done.asked += 1;
		const result = await askJev(tx, names, env.JEV_API_KEY, fetchImpl);
		if (!result.ok) {
			// Status and request id only: never the key or anything about the transaction.
			console.error(
				`jev: ${result.status ?? "no response"} ${result.requestId ?? ""}`.trim(),
			);
			// Jev down, rate-limited, or a bad key would fail every call: stop, and retry next night.
			// Anything else is about this one transaction: skip it (it stays pending) and carry on,
			// unless it keeps happening, which means it isn't about one transaction after all.
			if (serviceWide(result.status)) return done;
			// Asked last from now on, so it can't hold up the others.
			await markJevFailed(env.DB, tx.id);
			failuresInARow += 1;
			if (failuresInARow >= MAX_FAILURES_IN_A_ROW) return done;
			continue;
		}
		failuresInARow = 0;
		const decision = decide(result.answer, categories, JEV_THRESHOLD);
		const written = await saveJevResult(env.DB, tx.id, decision);
		if (written && decision.categoryId !== null) done.applied += 1;
	}

	console.log(`jev: asked ${done.asked}, applied ${done.applied}`);
	return done;
}

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

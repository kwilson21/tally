// The nightly categorization step (spec §7): merchant rules first, then Jev for the rest.
import { askJev, JEV_THRESHOLD } from "./ai/categorize";
import { decide } from "./ai/decide";
import { asksJev, readAiSwitches } from "./db/ai-switches";
import {
	applyMerchantRules,
	markJevFailed,
	pendingForJev,
	saveJevResult,
} from "./db/transactions";

/**
 * How many transactions one night asks Jev about (decision 56). The demo's reset needs few.
 * Production sorts a new bank's backfill in a night; each answer is saved as it arrives,
 * so a run cut short keeps its work, and the rest wait for the next night.
 */
export const jevCallLimit = (env: { DEMO?: string }) =>
	env.DEMO === "false" ? 500 : 40;

/** Failures in a row that point at every call (say, a changed API) rather than one transaction. */
const MAX_FAILURES_IN_A_ROW = 3;

type CategorizeEnv = { DB: D1Database; JEV_API_KEY?: string; DEMO?: string };

/**
 * Merchant rules, then Jev for what they left, honoring the household's saved AI switches (spec
 * §8.6, decision 73), so the nightly run and a run after a sync agree: with categories and income
 * both off Jev isn't asked at all, with categories off its category and its transfer and
 * reimbursement flags are dropped, and with income off its income answer is. The switches can be
 * saved while a run is going, so each transaction reads them again before it's sent and before its
 * answer is saved; an answer that comes back after both went off is thrown away.
 */
export async function categorizePending(
	env: CategorizeEnv,
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
	// The nightly catch-up has just applied merchant rules after its syncs; without banks (the demo)
	// or when that step failed, this run applies them itself.
	{ rulesApplied = false }: { rulesApplied?: boolean } = {},
): Promise<{ asked: number; applied: number }> {
	const done = { asked: 0, applied: 0 };
	if (!env.JEV_API_KEY) return done;

	// Merchant rules are the household's own, so they apply whatever the AI switches say.
	if (!rulesApplied) await applyMerchantRules(env.DB);

	const start = await readAiSwitches(env.DB);
	if (!asksJev(start)) return done;

	const { results: categories } = await env.DB.prepare(
		"SELECT id, name FROM categories WHERE archived = 0 ORDER BY sort_order",
	).all<{ id: number; name: string }>();
	// With nothing to offer, Jev could only say "none fit", which would mark every row as looked at.
	if (categories.length === 0) return done;
	// Sent even when only income is on: the one call asks everything together (spec §7), and a row is
	// marked as asked by the category confidence the answer carries (decision 27).
	const names = categories.map((c) => c.name);

	let failuresInARow = 0;
	for (const tx of await pendingForJev(env.DB, jevCallLimit(env), {
		categories: start.categories,
	})) {
		// One small read per transaction: someone may have turned a switch off since the last one.
		const before = await readAiSwitches(env.DB);
		if (!asksJev(before)) return done;
		// A credit a person reviewed, or an excluded payment that pays a bill, is asked about only for its category.
		if (tx.categoryOnly && !before.categories) continue;
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
		// Read again, since the request took a while: an answer is used only as the switches stand now.
		const now = await readAiSwitches(env.DB);
		if (!asksJev(now)) return done;
		if (tx.categoryOnly && !now.categories) continue;
		const decision = decide(result.answer, categories, JEV_THRESHOLD, {
			categories: now.categories,
		});
		const written = await saveJevResult(env.DB, tx.id, decision, {
			categoryOnly: tx.categoryOnly,
			switches: { income: now.income },
		});
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

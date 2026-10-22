import { matchBillPayments } from "../bills/match";
import { applyMerchantRules } from "../db/transactions";

/**
 * What every finished sync does next, whether linking a bank, the webhook, the nightly catch-up, Sync now or a
 * repaired connection started it (spec §8.5, decision 67): merchant rules fill what nobody has categorized,
 * then bills match their payments.
 *
 * The order matters. Rules come after sync's copy of a merchant's settings on its first Plaid name
 * (made in the page's own batch), so that rule is already there. Decision 68's sorting of new
 * transactions by Jev belongs after the rules, so Jev isn't asked about what a rule just sorted.
 *
 * An Apple Card upload's added rows get these same steps (spec §8.10), so this list is the only place they are named.
 */
export async function afterSyncSteps(db: D1Database): Promise<{
	rulesFailed: boolean;
	billsFailed: boolean;
	error?: unknown;
}> {
	// Each step runs even if the other fails, so a rule error never leaves a bill unmatched; the first
	// failure is returned with the flags, so the caller can say which step failed.
	const failures: unknown[] = [];
	const failed = async (step: () => Promise<unknown>): Promise<boolean> => {
		try {
			await step();
			return false;
		} catch (error) {
			failures.push(error);
			return true;
		}
	};
	const rulesFailed = await failed(() => applyMerchantRules(db));
	const billsFailed = await failed(() => matchBillPayments(db));
	return failures.length > 0
		? { rulesFailed, billsFailed, error: failures[0] }
		: { rulesFailed, billsFailed };
}

/** afterSyncSteps for a sync's callers: throws the first failure, so a failed sync can say so. */
export async function afterSync(db: D1Database): Promise<void> {
	const { rulesFailed, billsFailed, error } = await afterSyncSteps(db);
	if (rulesFailed || billsFailed) throw error;
}

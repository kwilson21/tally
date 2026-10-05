import { matchBillPayments } from "../bills/match";
import { applyMerchantRules } from "../db/transactions";

/**
 * What every finished sync does next, whether the webhook, the nightly catch-up, Sync now or a
 * repaired connection started it (spec §8.5, decision 67): merchant rules fill what nobody has
 * categorized, then bills match their payments.
 *
 * The order matters. Rules come after sync's copy of a merchant's settings on its first Plaid name
 * (made in the page's own batch), so that rule is already there. Decision 68's sorting of new
 * transactions by Jev belongs after the rules, so Jev isn't asked about what a rule just sorted.
 */
export async function afterSync(db: D1Database): Promise<void> {
	// Each step runs even if the other fails, so a rule error never leaves a bill unmatched; the
	// first failure is still thrown afterwards, so the caller can say so.
	const failures: unknown[] = [];
	for (const step of [applyMerchantRules, matchBillPayments]) {
		try {
			await step(db);
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0) throw failures[0];
}

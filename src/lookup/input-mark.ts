// The store lookup's privacy mark (spec §5 lookup_cleared, §7 "When it runs"): a fingerprint of everything Jev is told
// about a row, and the rule that says whether Jev's answer clears the row for the lookup. Pure, except for Web Crypto.

import { JEV_THRESHOLD } from "../ai/categorize";
import { meetsConfidenceThreshold } from "../ai/confidence";
import type { JevAnswer } from "../ai/decide";
import { isUnsure } from "../ai/maybe";
import type { JevSeen } from "../db/transactions";

/** A version tag in the hashed text, so a change to what the fingerprint covers changes every mark at once. */
const MARK_VERSION = "lookup-input-v1";

/** SHA-256 of a text, as lower-case hex. */
export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);

	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * The fingerprint of every fact Jev is told about a row (JevSeen), as one JSON array in a fixed order, so no key order
 * can change it. No date: Jev is not told one.
 */
export function inputMark(seen: JevSeen): Promise<string> {
	return sha256Hex(
		JSON.stringify([
			MARK_VERSION,
			seen.rawName,
			seen.ownName,
			seen.merchantKey,
			seen.merchantName,
			seen.suggestedNames,
			seen.suggestionStatus,
			seen.amountCents,
			seen.accountId,
			seen.accountType,
			seen.plaidCategory,
			seen.note,
			seen.kind,
			seen.forPersonId,
			seen.forPersonName,
		]),
	);
}

/**
 * Whether Jev's answer clears the row for the lookup: the payee is a business at the threshold, and no transfer,
 * income or reimbursement answer is at the threshold or unsure. A reimbursement has no Maybe range of its own, so it is
 * read with the transfer range. A missing payee answer does not clear.
 */
export function clearsForLookup(answer: JevAnswer): boolean {
	const payee = answer.payee;
	const { transfer, reimbursement, income } = answer.flags;

	return (
		payee?.label === "business" &&
		meetsConfidenceThreshold(payee.confidence, JEV_THRESHOLD) &&
		!meetsConfidenceThreshold(transfer, JEV_THRESHOLD) &&
		!meetsConfidenceThreshold(reimbursement, JEV_THRESHOLD) &&
		!meetsConfidenceThreshold(income, JEV_THRESHOLD) &&
		!isUnsure(transfer, "transfer") &&
		!isUnsure(reimbursement, "transfer") &&
		!isUnsure(income, "income")
	);
}

/**
 * Where a row stands for the lookup: `cleared` when its stored answer cleared and its fingerprint is the current one,
 * `asked` when Jev was asked and did not clear (it is not asked again until a fact Jev is told changes), and `owed`
 * when there is no answer or the facts changed since it was given.
 */
export function markState(
	stored: { inputMark: string; cleared: number } | null,
	current: string,
): "cleared" | "asked" | "owed" {
	if (!stored || stored.inputMark !== current) return "owed";

	return stored.cleared === 1 ? "cleared" : "asked";
}

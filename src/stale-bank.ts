// A bank that stopped syncing means Safe to spend may be too high (spec §8.5, decision 72 P37 A).
// Pure date logic on YYYY-MM-DD strings: "today" is the household's, passed in (decision 67), and a
// sync time is `plaid_items.last_synced_at` ("YYYY-MM-DD HH:MM:SS", UTC), of which only the date counts.
import { daysBefore, shortDay } from "./dates";

/** A connected bank that hasn't synced for this many days is flagged. */
export const STALE_AFTER_DAYS = 3;

export type BankSync = {
	name: string;
	/** The bank's login needs fixing (`plaid_items.status = needs_attention`). */
	needsAttention: boolean;
	/** When it last completed a sync (null: never recorded). */
	lastSyncedAt: string | null;
	/** A disconnected bank can never sync again, so it is never flagged. */
	disconnected?: boolean;
};

export type FlaggedBank =
	| { name: string; reason: "sign-in" }
	| { name: string; reason: "stale"; since: string };

/**
 * The connected banks Home flags, in the order given. A bank that needs signing in says so, even
 * if it also hasn't synced. One with no readable sync time has nothing true to say, so only a bank
 * that needs attention is flagged then.
 */
export function flaggedBanks(banks: BankSync[], today: string): FlaggedBank[] {
	const staleSince = daysBefore(today, STALE_AFTER_DAYS);
	const flagged: FlaggedBank[] = [];
	for (const bank of banks) {
		if (bank.disconnected) continue;
		if (bank.needsAttention) {
			flagged.push({ name: bank.name, reason: "sign-in" });
			continue;
		}
		const since = bank.lastSyncedAt?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
		// Both are YYYY-MM-DD, so comparing them as strings compares the dates.
		if (since !== undefined && since <= staleSince)
			flagged.push({ name: bank.name, reason: "stale", since });
	}
	return flagged;
}

/**
 * The line's words, or null when no bank is flagged. It names the first flagged bank and counts the
 * rest: "Chase needs you to sign in again, and 1 other bank needs a look, so Safe to spend may be too high."
 */
export function staleBankWords(
	flagged: FlaggedBank[],
	today: string,
): string | null {
	const [first, ...rest] = flagged;
	if (!first) return null;
	const lead =
		first.reason === "sign-in"
			? `${first.name} needs you to sign in again`
			: `${first.name} hasn't synced since ${shortDay(first.since, today)}`;
	const others =
		rest.length === 0
			? ""
			: `, and ${rest.length} other ${rest.length === 1 ? "bank needs" : "banks need"} a look`;
	return `${lead}${others}, so Safe to spend may be too high.`;
}

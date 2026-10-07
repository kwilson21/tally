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
	| { name: string; reason: "sign-in"; since?: string }
	| { name: string; reason: "stale"; since: string };

/** Home's selected wording and the date attached to the Safe to spend amount. */
export function homeBankNotice(
	flagged: FlaggedBank[],
	today: string,
): { words: string; asOf?: string } | null {
	const oldest = flagged
		.filter(
			(bank): bank is FlaggedBank & { since: string } =>
				bank.since !== undefined,
		)
		.sort((a, b) => a.since.localeCompare(b.since))[0];
	const first = oldest ?? flagged[0];
	if (!first) return null;
	const signIn = flagged.find((bank) => bank.reason === "sign-in");
	const words =
		first.reason === "sign-in"
			? `${first.name} needs signing in`
			: `${first.name} stopped updating ${shortDay(first.since, today)}`;
	const others = flagged.length - 1;
	const more =
		others === 0
			? ""
			: first.reason !== "sign-in" && signIn
				? `, and ${others} more: ${signIn.name} needs signing in`
				: `, and ${others} more ${others === 1 ? "bank needs" : "banks need"} a fix`;
	return {
		words: `${words}${more}`,
		...(oldest && {
			asOf: shortDay(oldest.since, today),
		}),
	};
}

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
		const since = bank.lastSyncedAt?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
		if (bank.needsAttention) {
			flagged.push({
				name: bank.name,
				reason: "sign-in",
				...(since && { since }),
			});
			continue;
		}
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
	const first = flagged[0];
	if (!first) return null;
	const others = flagged.length - 1;
	const otherBanks =
		others === 0
			? ""
			: `, and ${others} other ${others === 1 ? "bank needs" : "banks need"} a look`;
	const lead =
		first.reason === "sign-in"
			? `${first.name} needs you to sign in again`
			: `${first.name} hasn't synced since ${shortDay(first.since, today)}`;
	return `${lead}${otherBanks}, so Safe to spend may be too high.`;
}

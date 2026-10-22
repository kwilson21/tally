// A bank that stopped syncing means Safe to spend may be too high (spec §8.5, decision 72 P37 A).
// Pure date logic on YYYY-MM-DD strings: "today" is the household's, passed in (decision 67), and a
// sync time is `plaid_items.last_synced_at` ("YYYY-MM-DD HH:MM:SS", UTC), of which only the date counts.
import { daysBefore, shortDay } from "./dates";

/** A connected bank that hasn't synced for this many days is flagged. */
export const STALE_AFTER_DAYS = 3;

export type BankSync = {
	/** The bank's `plaid_items` id. A flag belongs to its row by this id, never by the name (two banks can share one). */
	id: number;
	name: string;
	/** The bank's login needs fixing (`plaid_items.status = needs_attention`). */
	needsAttention: boolean;
	/** When it last completed a sync (null: never recorded). */
	lastSyncedAt: string | null;
	/** A disconnected bank can never sync again, so it is never flagged. */
	disconnected?: boolean;
};

/** A flagged bank's name, why it is flagged, and its sync date: what Home's bank line reads (homeBankNotice). */
export type FlagWords =
	| { name: string; reason: "sign-in"; since?: string }
	| { name: string; reason: "stale"; since: string };

/** A flagged bank: the id of its row, then its name, reason and date (bankFlag). */
export type FlaggedBank = { id: number } & FlagWords;

/** Home's selected wording and the date attached to the Safe to spend amount. */
export function homeBankNotice(
	flagged: FlagWords[],
	today: string,
): { words: string[]; asOf?: string } | null {
	if (flagged.length === 0) return null;
	const sorted = [...flagged].sort((a, b) => {
		if (a.since && b.since)
			return a.since.localeCompare(b.since) || a.name.localeCompare(b.name);
		if (a.since) return -1;
		if (b.since) return 1;
		return a.name.localeCompare(b.name);
	});
	const dated = sorted.find(
		(bank): bank is FlagWords & { since: string } => bank.since !== undefined,
	);
	const visible = sorted
		.slice(0, 3)
		.map((bank) =>
			bank.reason === "sign-in"
				? `${bank.name} needs signing in`
				: `${bank.name} stopped updating ${shortDay(bank.since, today)}`,
		);
	if (sorted.length > 3) {
		const more = sorted.length - 3;
		visible.push(
			`and ${more} more bank${more === 1 ? "" : "s"} need${more === 1 ? "s" : ""} a fix`,
		);
	}
	return {
		words: visible,
		...(dated && {
			asOf: shortDay(dated.since, today),
		}),
	};
}

/**
 * One bank's flag, or null when it is fine. A bank that needs signing in says so, even if it also hasn't synced. One with
 * no readable sync time has nothing true to say, so only a bank that needs attention is flagged then. A disconnected bank
 * is never flagged. Home's bank line (flaggedBanks) and the Your banks list (src/first-tally/your-banks.ts) both read it.
 */
export function bankFlag(bank: BankSync, today: string): FlaggedBank | null {
	if (bank.disconnected) return null;
	const since = bank.lastSyncedAt?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
	if (bank.needsAttention)
		return {
			id: bank.id,
			name: bank.name,
			reason: "sign-in",
			...(since && { since }),
		};
	// Both are YYYY-MM-DD, so comparing them as strings compares the dates.
	if (since !== undefined && since <= daysBefore(today, STALE_AFTER_DAYS))
		return { id: bank.id, name: bank.name, reason: "stale", since };
	return null;
}

/** The connected banks Home flags, in the order given (bankFlag). */
export function flaggedBanks(banks: BankSync[], today: string): FlaggedBank[] {
	return banks.flatMap((bank) => bankFlag(bank, today) ?? []);
}

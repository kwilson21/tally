// Home's Apple Card reminder (spec §8.10, decision 138). Pure date logic on YYYY-MM-DD strings: "today" is the
// household's, passed in (decision 67). The reminder counts from the last upload, never from the last charge.

import { daysBefore, shortDay } from "../dates";
import type { AppleCardAccount } from "../db/accounts";

/** Apple Card is behind once this many household days pass since its last upload (decision 138). */
export const APPLE_STALE_AFTER_DAYS = 7;

/**
 * Home's Apple Card line: its words and the day of its last upload, or null while the card is current, removed, or has
 * no upload yet. The line says what the bank line says, and Home's as-of tag can take this day too (asOfDate).
 */
export function appleCardNotice(
	card: AppleCardAccount | null,
	today: string,
): { words: string; since: string } | null {
	if (!card || card.removedAt !== null || card.uploadedOn === null) return null;
	// Both are YYYY-MM-DD, so comparing them as strings compares the dates.
	if (card.uploadedOn > daysBefore(today, APPLE_STALE_AFTER_DAYS)) return null;
	return {
		words: `Apple Card hasn't been updated since ${shortDay(card.uploadedOn, today)}`,
		since: card.uploadedOn,
	};
}

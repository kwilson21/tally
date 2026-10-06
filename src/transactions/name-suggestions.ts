// A merchant's suggested names (spec §5, §7, decision 64). `merchants.suggested_name` holds up to three,
// one per line (a name never has a newline: src/ai/suggest-name.ts keeps single lines). They show only while
// `suggestion_status` is `pending`: nothing is renamed until a person chooses, and a name a person
// chose, or turned down, is never suggested again.
import { tidyName } from "./tidy-name";

export const MAX_SUGGESTED_NAMES = 3;

const SEPARATOR = "\n";

/** The names a merchant row holds, in order. An empty value means a name was asked for and none was useful. */
export function parseSuggestedNames(
	stored: string | null | undefined,
): string[] {
	return (stored ?? "")
		.split(SEPARATOR)
		.map((name) => name.trim())
		.filter(Boolean)
		.slice(0, MAX_SUGGESTED_NAMES);
}

/** The value to keep in `suggested_name`: at most three names, one per line. */
export function storeSuggestedNames(names: string[]): string {
	return names.slice(0, MAX_SUGGESTED_NAMES).join(SEPARATOR);
}

/** Where a suggested name came from (spec §8.6, P87 B): the bank sent it, or Tally guessed it. */
export type NameSource = "bank" | "tally";

type Stored = {
	stored: string | null | undefined;
	status: string | null | undefined;
	/** The merchant's key (spec §6.1): Plaid's merchant name when it sent one, otherwise the bank's raw text. */
	key: string;
	/** The household's "Suggest store names" switch (spec §8.6). */
	namesOn: boolean;
};

/**
 * True when a suggested name is the bank's own: Plaid's name is its merchant's key, and sync stores it
 * as that merchant's suggestion, while Workers AI is only asked about bank texts Plaid didn't name
 * and never offers the bank's own text, so a name equal to the key can only be Plaid's.
 */
export const isBankName = (name: string, key: string): boolean => name === key;

/** Where a merchant's offered names came from: the bank when they are Plaid's name, otherwise Tally's guess. */
export const nameSource = (names: string[], key: string): NameSource =>
	names.length > 0 && names.every((name) => isBankName(name, key))
		? "bank"
		: "tally";

/**
 * The names to offer a person for a merchant: its pending suggestions. With the household's names
 * switch off, Tally's guesses (Workers AI) are not offered, but the bank's own name still is, since it
 * is a fact the bank sent (spec §8.6, decisions 79 and 80). Switching it back on shows the guesses
 * again, since they were kept.
 */
export function usableSuggestedNames({
	stored,
	status,
	key,
	namesOn,
}: Stored): string[] {
	if (status !== "pending") return [];
	const names = parseSuggestedNames(stored);
	return namesOn ? names : names.filter((name) => isBankName(name, key));
}

/**
 * What a transaction's name reads as: a person's chosen name, else the first pending suggestion that
 * says something the tidied bank text doesn't, marked `suggested` (shown dashed until chosen, P29 A)
 * and, when it is the bank's, `fromBank` (no sparkles icon, P87 B), else the tidied bank text
 * (decision 46).
 */
export function shownName({
	chosen,
	rawName,
	...merchant
}: Stored & { chosen: string | null; rawName: string }): {
	name: string;
	suggested: boolean;
	fromBank: boolean;
} {
	if (chosen) return { name: chosen, suggested: false, fromBank: false };
	const tidied = tidyName(rawName);
	const first = usableSuggestedNames(merchant).find((name) => name !== tidied);
	return first
		? {
				name: first,
				suggested: true,
				fromBank: isBankName(first, merchant.key),
			}
		: { name: tidied, suggested: false, fromBank: false };
}

/** The names the edit panel and the review offer: the usable ones that differ from the tidied bank text. */
export function offeredNames(merchant: Stored, rawName: string): string[] {
	const tidied = tidyName(rawName);
	return usableSuggestedNames(merchant).filter((name) => name !== tidied);
}

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

type Stored = {
	stored: string | null | undefined;
	status: string | null | undefined;
	/** The household's "Suggest store names" switch (spec §8.6). */
	namesOn: boolean;
};

/**
 * The names to offer a person for a merchant: its pending suggestions, and none while the household's
 * names switch is off (spec §8.6, decision 79). Switching it back on shows them again, since they
 * were kept.
 */
export function usableSuggestedNames({
	stored,
	status,
	namesOn,
}: Stored): string[] {
	if (status !== "pending" || !namesOn) return [];
	return parseSuggestedNames(stored);
}

/**
 * What a transaction's name reads as: a person's chosen name, else the first pending suggestion that
 * says something the tidied bank text doesn't, marked `suggested` (shown dashed until chosen, P29 A),
 * else the tidied bank text (decision 46).
 */
export function shownName({
	chosen,
	rawName,
	...merchant
}: Stored & { chosen: string | null; rawName: string }): {
	name: string;
	suggested: boolean;
} {
	if (chosen) return { name: chosen, suggested: false };
	const tidied = tidyName(rawName);
	const first = usableSuggestedNames(merchant).find((name) => name !== tidied);
	return first
		? { name: first, suggested: true }
		: { name: tidied, suggested: false };
}

/** The names the edit panel and the review offer: the usable ones that differ from the tidied bank text. */
export function offeredNames(merchant: Stored, rawName: string): string[] {
	const tidied = tidyName(rawName);
	return usableSuggestedNames(merchant).filter((name) => name !== tidied);
}

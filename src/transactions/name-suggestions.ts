// A merchant's suggested names (spec §5, §7, decision 64). They are rows of `merchant_suggested_names`, up to three
// per merchant, and read here as the JSON text merchantNamesJsonSql gives. They show only while `suggestion_status` is
// `pending`: nothing is renamed until a person chooses, and a name a person chose, or turned down, is never suggested again.
import { MERCHANT_SUGGESTION_WAITING } from "../machines/merchant-suggestion";
import { tidyName } from "./tidy-name";

export const MAX_SUGGESTED_NAMES = 3;

/**
 * The names a merchant holds, in position order, from the JSON text merchantNamesJsonSql gives (`[[position, name], …]`).
 * Total: null, text that isn't JSON, or any other shape gives no names. Blank names are dropped.
 */
export function parseSuggestedNames(
	stored: string | null | undefined,
): string[] {
	let rows: unknown;

	try {
		rows = JSON.parse(stored ?? "[]");
	} catch {
		return [];
	}

	if (!Array.isArray(rows)) return [];
	const named: [number, string][] = [];

	for (const row of rows) {
		if (isNamedRow(row)) named.push([row[0], row[1].trim()]);
	}

	return named
		.filter(([, name]) => name !== "")
		.sort((a, b) => a[0] - b[0])
		.map(([, name]) => name)
		.slice(0, MAX_SUGGESTED_NAMES);
}

// True for one stored `[position, name]` pair: an array whose first item is a number and second a string.
function isNamedRow(row: unknown): row is [number, string] {
	return (
		Array.isArray(row) &&
		typeof row[0] === "number" &&
		typeof row[1] === "string"
	);
}

/**
 * The names to store for one merchant (the write rule of merchant_suggested_names): each trimmed, blank ones dropped, the
 * first three kept. Not de-duplicated: the AI path already removes repeats (src/ai/suggest-name.ts).
 */
export function normaliseNames(names: readonly string[]): string[] {
	return names
		.flatMap((name) => {
			const trimmed = name.trim();

			return trimmed !== "" ? [trimmed] : [];
		})
		.slice(0, MAX_SUGGESTED_NAMES);
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
	if (status !== MERCHANT_SUGGESTION_WAITING) return [];
	const names = parseSuggestedNames(stored);

	return namesOn ? names : names.filter((name) => isBankName(name, key));
}

/** A name's letter runs, so "AT&T" gives "at" and "t", and "APPLE.COM/BILL" gives "apple", "com" and "bill". */
export const wordsOf = (text: string) =>
	text
		.toLowerCase()
		.split(/[^\p{L}]+/u)
		.filter(Boolean);

/** A name's whitespace-separated runs, so a run never joins the next word: "Trader Joe's" gives "trader" and "joe's". */
export const runsOf = (text: string) =>
	text.toLowerCase().split(/\s+/).filter(Boolean);

const stripped = (text: string, dropped: RegExp) => text.replace(dropped, "");

/** A run with its punctuation removed: "at&t" is "att", "joe's" is "joes", and "#552" is nothing. */
export const joinedOf = (run: string) => stripped(run, /[^\p{L}]/gu);

/** A name with its punctuation and spacing removed but its digits kept, so "7-eleven" is "7eleven" and "Motel 6" is "motel6". */
const spelledOf = (text: string) => stripped(text, /[^\p{L}\p{N}]/gu);

/**
 * True when a suggestion repeats the shown text: exactly, or a Tally guess that differs from it only in
 * capitals, punctuation or spacing, so "ATT" beside "AT&T" (decision 103, #412). Digits count, so "Motel 8"
 * beside "Motel 6" is still offered (#412, Codex review). The bank's own name is never dropped for that,
 * since the bank sent it (P87 B).
 */
const repeatsShown = (name: string, key: string, tidied: string) =>
	name === tidied ||
	(!isBankName(name, key) &&
		spelledOf(name.toLowerCase()) === spelledOf(tidied.toLowerCase()));

/**
 * What a transaction's name reads as: a person's chosen name, else the first pending suggestion that
 * says something the tidied bank text doesn't, marked `suggested` (shown dashed until chosen, P29 A)
 * and, when it is the bank's, `fromBank` (no sparkles icon, P87 B), else the tidied bank text
 * (decision 46).
 */
export type ShownName = {
	name: string;
	suggested: boolean;
	fromBank: boolean;
};

export function shownName({
	chosen,
	ownName,
	rawName,
	...merchant
}: Stored & {
	chosen: string | null;
	/** A name given to this one transaction (decision 101), which wins over the merchant's. */
	ownName?: string | null;
	rawName: string;
}): ShownName {
	if (ownName) return { name: ownName, suggested: false, fromBank: false };

	if (chosen) return { name: chosen, suggested: false, fromBank: false };
	const tidied = tidyName(rawName);

	const first = usableSuggestedNames(merchant).find(
		(name) => !repeatsShown(name, merchant.key, tidied),
	);

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

	return usableSuggestedNames(merchant).filter(
		(name) => !repeatsShown(name, merchant.key, tidied),
	);
}

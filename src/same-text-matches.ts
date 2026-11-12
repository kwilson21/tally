// Groups transactions that share a cleaned bank text (decision 157, step A: the card that shows "2 more look like
// this" before anything moves). Pure: the caller loads the rows and decides what to do with the groups.
//
// The rules, each a test in test/same-text-matches.test.ts:
// - rows group only by cleanBankText equality. The merchant key is carried on each row but never used to group,
//   since a store's name can cover different bank texts ("Amazon" for both Kindle and Audible);
// - a row on a trip Jev calls mixed (decision 90) never groups;
// - a vague line (VAGUE_TEXTS, such as APPLE.COM/BILL, which covers the App Store, iCloud and Music) groups only
//   with rows that have a non-empty "what it was" note, and only with rows whose note is the same. Notes are
//   compared trimmed, with runs of spaces collapsed and case ignored;
// - a row whose text cleans to nothing never groups;
// - a group of one is dropped.

import { cleanBankText } from "./clean-bank-text";

/**
 * Cleaned texts that cover more than one thing a person might have bought (lowercase, as cleanBankText returns them).
 * Apple's one bank line covers the App Store, iCloud, Music and Books, so one answer must not stand for all of them.
 */
export const VAGUE_TEXTS: readonly string[] = ["apple.com/bill"];

export type SameTextRow = {
	id: number;
	/** The bank's raw text. The only text that is cleaned and compared. */
	rawName: string;
	/** Carried through to the group, never used to group. */
	merchantKey: string;
	/** Jev calls this trip mixed (decision 90). Such a row never groups. */
	mixed: boolean;
	/** The person's "what it was" note, if they wrote one. */
	whatItWasNote: string | null;
};

export type SameTextGroup = {
	cleanedText: string;
	/** The shared note of a vague group; null for any other group. */
	note: string | null;
	/** In the order they were given. */
	rows: SameTextRow[];
};

export type SameTextOptions = {
	/** Lowercase cleaned texts that need a shared note to group. Defaults to VAGUE_TEXTS. */
	vagueTexts?: readonly string[];
};

/**
 * True for a vague text, or a cleaned text that is one followed by a space ("apple.com/bill cupertino" is vague,
 * "apple.com/billing inc" is not: there is no space after the vague text).
 */
export function isVague(
	cleanedText: string,
	vague: ReadonlySet<string>,
): boolean {
	for (const v of vague) {
		if (cleanedText === v || cleanedText.startsWith(`${v} `)) return true;
	}

	return false;
}

/** The note, trimmed, with runs of spaces collapsed and case ignored; "" when there is no note. */
function normalizedNote(note: string | null): string {
	return (note ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The groups of rows that share a cleaned bank text, in the order their first row appears. Each group has at least
 * two rows. Rows that are mixed, have empty cleaned text, or (for a vague text) have no note are left out.
 */
export function groupBySameCleanedText(
	rows: readonly SameTextRow[],
	opts: SameTextOptions = {},
): SameTextGroup[] {
	const vague = new Set(opts.vagueTexts ?? VAGUE_TEXTS);
	const groups = new Map<string, SameTextGroup>();

	for (const row of rows) {
		if (row.mixed) continue;
		const cleanedText = cleanBankText(row.rawName);

		if (cleanedText === "") continue;

		let note: string | null = null;
		let key = cleanedText;
		const vagueRow = isVague(cleanedText, vague);

		if (vagueRow) {
			note = normalizedNote(row.whatItWasNote);

			if (note === "") continue;
			key = `${cleanedText}\u0000${note}`;
		}

		const existing = groups.get(key);

		if (existing) {
			existing.rows.push(row);
		} else {
			groups.set(key, {
				cleanedText,
				note: vagueRow ? (row.whatItWasNote ?? "").trim() : null,
				rows: [row],
			});
		}
	}

	return [...groups.values()].filter((group) => group.rows.length > 1);
}

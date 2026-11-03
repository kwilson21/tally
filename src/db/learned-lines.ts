// "What Tally has learned" (decisions 156 and 162): one line per cleaned bank text, with the category the person chose.
// A line is derived, never stored, from confirmed answers only: transactions whose category_source is 'user' or
// 'merchant_rule'. Jev's own guesses never make a line. learnedLines is pure over rows; loadLearnedLines is the thin
// loader. Part 3b (Jev's use of the lines) reuses learnedLines as it is.

import { cleanBankText } from "../clean-bank-text";
import { isVague, VAGUE_TEXTS } from "../same-text-matches";
import { INCLUDED } from "./counted-month";

/** How many of a text's latest answers decide its line (decision 162). */
export const LEARNED_WINDOW = 5;
/** How long an Undo of a Forget works, on the server clock as on the toast (decision 162). */
export const FORGET_UNDO_SECONDS = 10;
/** Less than this much Undo left is no Undo at all: the toast says the Forget and offers nothing to press. */
export const FORGET_UNDO_MIN_MS = 1000;

/** One confirmed answer: a transaction a person (or a merchant rule) filed in a category. */
export type AnswerRow = {
	id: number;
	/** The bank's date, YYYY-MM-DD. */
	date: string;
	/** The bank's raw text. Only cleaned for grouping and tidied for display. */
	rawName: string;
	/** When the row last changed, "YYYY-MM-DD HH:MM:SS" (datetime('now') format). */
	updatedAt: string;
	categoryId: number;
	categoryName: string;
	icon: string;
	color: string;
};

/** A text a person forgot, and when (datetime('now') format). */
export type Forgotten = { cleanedText: string; forgottenAt: string };

export type LearnedLine = {
	/** The cleaned bank text (cleanBankText): the line's key. */
	cleanedText: string;
	/** The text tidied for people, such as "Netflix.com". */
	name: string;
	categoryId: number;
	categoryName: string;
	icon: string;
	color: string;
	/** How many of the last LEARNED_WINDOW answers chose this category ("From N of your answers"). */
	answers: number;
	/** A text that covers more than one kind of purchase (VAGUE_TEXTS, such as APPLE.COM/BILL). */
	vague: boolean;
};

// Small words stay lower case in a name, unless they open it.
const SMALL_WORDS = new Set([
	"of",
	"the",
	"and",
	"a",
	"an",
	"in",
	"at",
	"to",
	"for",
	"on",
]);

/**
 * A line's name for people: the cleaned text with each word capitalised, except small words (SMALL_WORDS), which stay
 * lower case unless they are the first word. "museum of the bible" is "Museum of the Bible".
 */
export function displayName(cleanedText: string): string {
	return cleanedText
		.split(" ")
		.map((word, index) => {
			if (word === "") return word;
			if (index > 0 && SMALL_WORDS.has(word)) return word;
			return word.charAt(0).toUpperCase() + word.slice(1);
		})
		.join(" ");
}

/**
 * The learned lines for the given answers, after the forgotten texts. Rows whose text was forgotten count only when
 * they changed after the Forget; the rest of the window is then taken from what is left. Each text's line is its
 * most common category among its last LEARNED_WINDOW answers, and a tie goes to the category answered latest.
 * Lines are in A to Z order of their cleaned text.
 */
export function learnedLines(
	rows: readonly AnswerRow[],
	forgotten: readonly Forgotten[] = [],
): LearnedLine[] {
	const forgottenAt = new Map(
		forgotten.map((f) => [f.cleanedText, f.forgottenAt]),
	);
	const byText = new Map<string, AnswerRow[]>();
	for (const row of rows) {
		const cleanedText = cleanBankText(row.rawName);
		if (cleanedText === "") continue;
		const since = forgottenAt.get(cleanedText);
		if (since !== undefined && row.updatedAt <= since) continue;
		const list = byText.get(cleanedText);
		if (list) list.push(row);
		else byText.set(cleanedText, [row]);
	}

	const vague = new Set(VAGUE_TEXTS);
	const lines: LearnedLine[] = [];
	for (const [cleanedText, answers] of byText) {
		// Newest first: by date, then by id, so a later row on the same day counts as later.
		const newestFirst = [...answers].sort(
			(a, b) => b.date.localeCompare(a.date) || b.id - a.id,
		);
		const latest = newestFirst.slice(0, LEARNED_WINDOW);
		// Insertion order is newest first, so the first category to reach a count is the latest answered: with `>`
		// a tie keeps it.
		const tally = new Map<number, { count: number; row: AnswerRow }>();
		for (const row of latest) {
			const seen = tally.get(row.categoryId);
			if (seen) seen.count += 1;
			else tally.set(row.categoryId, { count: 1, row });
		}
		let best: { count: number; row: AnswerRow } | undefined;
		for (const entry of tally.values()) {
			if (!best || entry.count > best.count) best = entry;
		}
		if (!best) continue;
		lines.push({
			cleanedText,
			name: displayName(cleanedText),
			categoryId: best.row.categoryId,
			categoryName: best.row.categoryName,
			icon: best.row.icon,
			color: best.row.color,
			answers: best.count,
			vague: isVague(cleanedText, vague),
		});
	}
	return lines.sort((a, b) => a.cleanedText.localeCompare(b.cleanedText));
}

/** The confirmed answers, newest first. Split parents, pending, archived and excluded rows never count. */
const ANSWERS_SQL = `SELECT t.id, t.date, t.raw_name AS rawName, t.updated_at AS updatedAt,
		t.category_id AS categoryId, c.name AS categoryName, c.icon, c.color
	FROM transactions t JOIN categories c ON c.id = t.category_id
	WHERE t.category_source IN ('user', 'merchant_rule')
		AND t.category_id IS NOT NULL AND c.archived = 0
		AND t.pending = 0 AND t.is_split = 0 AND ${INCLUDED}
	ORDER BY t.date DESC, t.id DESC`;

/** The learned lines as the database has them now. */
export async function loadLearnedLines(db: D1Database): Promise<LearnedLine[]> {
	const { results: rows } = await db.prepare(ANSWERS_SQL).all<AnswerRow>();
	const { results: forgotten } = await db
		.prepare(
			"SELECT cleaned_text AS cleanedText, forgotten_at AS forgottenAt FROM forgotten_texts",
		)
		.all<Forgotten>();
	return learnedLines(rows, forgotten);
}

/**
 * Forgets a text (its Forget). A text forgotten before keeps its one row: its time moves to now, and the time it had
 * goes to previous_forgotten_at, so the Undo of this Forget can put the line back as it was. Returns the row's id,
 * which the Undo names.
 */
export async function forgetText(
	db: D1Database,
	cleanedText: string,
): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO forgotten_texts (cleaned_text, forgotten_at) VALUES (?, datetime('now'))
			ON CONFLICT(cleaned_text) DO UPDATE SET
				previous_forgotten_at = forgotten_texts.forgotten_at,
				forgotten_at = excluded.forgotten_at
			RETURNING id`,
		)
		.bind(cleanedText)
		.first<{ id: number }>();
	return row?.id ?? 0;
}

/**
 * The Undo's time left for a Forget row, in milliseconds, counted by the database's clock from the row's stored time
 * (the same basis undoForget checks). 0 when it has run out or the row is gone.
 */
export async function undoRemainingMs(
	db: D1Database,
	id: number,
): Promise<number> {
	const row = await db
		.prepare(
			"SELECT CAST(MAX(0, MIN(?, (julianday(forgotten_at) + ? / 86400.0 - julianday('now')) * 86400000)) AS INTEGER) AS ms FROM forgotten_texts WHERE id = ?",
		)
		.bind(FORGET_UNDO_SECONDS * 1000, FORGET_UNDO_SECONDS, id)
		.first<{ ms: number }>();
	return row?.ms ?? 0;
}

/**
 * Undo of a Forget, only within the ten seconds, by the database's clock. A first Forget's row is deleted; a second
 * Forget's row gets back the time it replaced, so the line is as it was before that Forget. "gone" when the row is not
 * there (already undone, or never written).
 */
export async function undoForget(
	db: D1Database,
	id: number,
): Promise<"undone" | "expired" | "gone"> {
	const row = await db
		.prepare(
			`SELECT julianday('now') - julianday(forgotten_at) < ? / 86400.0 AS fresh,
				previous_forgotten_at AS previous
			FROM forgotten_texts WHERE id = ?`,
		)
		.bind(FORGET_UNDO_SECONDS, id)
		.first<{ fresh: number; previous: string | null }>();
	if (!row) return "gone";
	if (!row.fresh) return "expired";
	if (row.previous !== null) {
		await db
			.prepare(
				"UPDATE forgotten_texts SET forgotten_at = previous_forgotten_at, previous_forgotten_at = NULL WHERE id = ?",
			)
			.bind(id)
			.run();
	} else {
		await db.prepare("DELETE FROM forgotten_texts WHERE id = ?").bind(id).run();
	}
	return "undone";
}

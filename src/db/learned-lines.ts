// "What Tally has learned" (decisions 156 and 162): one line per cleaned bank text, with the category the person chose.
// A line is derived, never stored, from confirmed answers only: transactions whose category_source is 'user' or
// 'merchant_rule'. Jev's own guesses never make a line. learnedLines is pure over rows; loadLearnedLines is the thin
// loader. A person's Change (decision 163) is a rule on the text: withBankTextRules shows the rule's category on the
// line, or makes a line from the rule alone, and the loader does that overlay, so Jev is told the same line.

import { cleanBankText } from "../clean-bank-text";
import { isVague, VAGUE_TEXTS } from "../same-text-matches";
import { activeBankTextRules, type BankTextRule } from "./bank-text-rules";
import { jevSaysMixedSql } from "./mixed-trip";

/** How many of a text's latest answers decide its line (decision 162). */
export const LEARNED_WINDOW = 5;

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
	/**
	 * The line's category is a rule a person made with Change (decision 163), not only their answers. Absent for an
	 * answers-only line, so those lines compare as they always did.
	 */
	rule?: true;
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

/**
 * The confirmed answers, newest first. Split parents, pending, archived and excluded rows never count, nor a trip Jev
 * calls mixed (decision 156), whose parts follow their parent. `excluded = 0` is strict: a bill's link does not make an
 * excluded row count here, unlike the budget (INCLUDED).
 */
const ANSWERS_SQL = `SELECT t.id, t.date, t.raw_name AS rawName, t.updated_at AS updatedAt,
		t.category_id AS categoryId, c.name AS categoryName, c.icon, c.color
	FROM transactions t JOIN categories c ON c.id = t.category_id
	WHERE t.category_source IN ('user', 'merchant_rule')
		AND t.category_id IS NOT NULL AND c.archived = 0
		AND t.pending = 0 AND t.is_split = 0 AND t.excluded = 0
		AND NOT ${jevSaysMixedSql("t")}
		AND NOT EXISTS (SELECT 1 FROM transactions p WHERE p.id = t.parent_id AND ${jevSaysMixedSql("p")})
	ORDER BY t.date DESC, t.id DESC`;

/**
 * The lines with the rules a person made (decision 163) on top: a text with a rule shows the rule's category, marked
 * `rule`, and keeps its answers' count; a rule with no line makes one from the rule alone, with no answers. A vague text
 * never has a rule, so it never gets one here either. The rules passed in are already the active ones.
 */
export function withBankTextRules(
	lines: readonly LearnedLine[],
	rules: readonly BankTextRule[],
): LearnedLine[] {
	const ruleFor = new Map(rules.map((rule) => [rule.cleanedText, rule]));
	const shown = new Set<string>();

	const out: LearnedLine[] = lines.map((line) => {
		shown.add(line.cleanedText);
		const rule = line.vague ? undefined : ruleFor.get(line.cleanedText);

		if (!rule) return line;

		return {
			...line,
			categoryId: rule.categoryId,
			categoryName: rule.categoryName,
			icon: rule.icon,
			color: rule.color,
			rule: true,
		};
	});

	const vague = new Set(VAGUE_TEXTS);

	for (const rule of rules) {
		if (shown.has(rule.cleanedText) || isVague(rule.cleanedText, vague))
			continue;
		out.push({
			cleanedText: rule.cleanedText,
			name: displayName(rule.cleanedText),
			categoryId: rule.categoryId,
			categoryName: rule.categoryName,
			icon: rule.icon,
			color: rule.color,
			answers: 0,
			vague: false,
			rule: true,
		});
	}

	return out.sort((a, b) => a.cleanedText.localeCompare(b.cleanedText));
}

/** The learned lines as the database has them now, with the person's rules on top (decision 163). */
export async function loadLearnedLines(db: D1Database): Promise<LearnedLine[]> {
	const { results: rows } = await db.prepare(ANSWERS_SQL).all<AnswerRow>();

	const { results: forgotten } = await db
		.prepare(
			"SELECT cleaned_text AS cleanedText, forgotten_at AS forgottenAt FROM forgotten_texts",
		)
		.all<Forgotten>();

	return withBankTextRules(
		learnedLines(rows, forgotten),
		await activeBankTextRules(db),
	);
}

/** The active categories a Change can file a line in, A to Z by the household's own order (as the budget lists them). */
export async function learnedCategoryChoices(
	db: D1Database,
): Promise<{ id: number; name: string }[]> {
	const { results } = await db
		.prepare(
			"SELECT id, name FROM categories WHERE archived = 0 ORDER BY sort_order, name",
		)
		.all<{ id: number; name: string }>();

	return results;
}

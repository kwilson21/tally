// The budgets step's words and its shown values (P125 E, spec §6 and §8.8, decision 114, #590): what each question says,
// what the ledger line and the announcements say, and what a form carries so an answer covers only the suggestions the
// page showed. Every number comes from the family's own bank, through first-page.ts's reading.
import type {
	FirstBudgetSuggestion,
	MonthSpent,
} from "../budgets/first-suggestion";
import { monthName } from "../dates";
import { formatCents } from "../money";
import { dollarsWords } from "./pay";

/**
 * A category the budgets step asks about: its name, its full months of Spent (a month with no spending is $0), and
 * Tally's suggestion when it has one (firstBudgetSuggestion; null for no history, a mean of $0 or less, or a rounded
 * amount over the largest budget).
 */
export type BudgetAsk = {
	id: number;
	name: string;
	months: MonthSpent[];
	suggestion: FirstBudgetSuggestion | null;
};

/** The value a keep-all form's hidden `keep` carries for one suggestion: its category and amount, as the page showed them. */
export function shownBudgetValue(ask: BudgetAsk): string {
	return JSON.stringify({
		id: ask.id,
		cents: ask.suggestion?.amountCents ?? null,
	});
}

/**
 * The suggestions a keep-all form submitted that still match the current ones. A suggestion the page never showed, or
 * one whose amount moved since, is not kept, and a value that isn't one of these matches none.
 */
export function keepShownBudgets(
	current: BudgetAsk[],
	values: string[],
): BudgetAsk[] {
	const shown = new Set(values);
	return current.filter((ask) => shown.has(shownBudgetValue(ask)));
}

/**
 * The category ids a keep-all form submitted, each once, read from the values shownBudgetValue wrote (the snapshot the
 * page drew). A value that isn't one (malformed JSON, or no integer id) names no category the page showed, so it is dropped.
 */
export function shownBudgetIds(values: string[]): number[] {
	const ids = new Set<number>();
	for (const value of values) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		const { id } = parsed as { id?: unknown };
		if (Number.isInteger(id)) ids.add(id as number);
	}
	return [...ids];
}

/**
 * Why a drawn budgets step asked nothing: every active category already has a budget, or there is no active category to
 * budget. The step's muted line says which (nothingAskedLine).
 */
export type NothingAsked = "every-category-budgeted" | "no-categories";

/** The muted line above the ruled-off total when the budgets step asked nothing, for the reason given. */
export function nothingAskedLine(reason: NothingAsked): string {
	return reason === "every-category-budgeted"
		? "Every category already has a budget."
		: "No categories to budget yet.";
}

/** A sentence's list of items: "A and B", "A, B and C" (a single item is itself). */
function andList(items: string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The months as a sentence's list: "August and September", "July, August and September". */
export function monthList(months: MonthSpent[]): string {
	return andList(months.map((month) => monthName(month.month.slice(0, 7))));
}

/**
 * The muted line above one category's question: what the bank shows it spent. A category with no spending in the full
 * months (or none to count) has no history, and says so, and is asked with a blank amount.
 */
export function bankLine(ask: BudgetAsk): string {
	const spent = ask.months.some((month) => month.spentCents !== 0);
	if (!spent)
		return `${ask.name} has no spending yet. Set a monthly budget, or skip it.`;
	const parts = ask.months.map(
		(month) =>
			`${dollarsWords(month.spentCents)} in ${monthName(month.month.slice(0, 7))}`,
	);
	return `Your bank shows ${ask.name} spent ${andList(parts)}.`;
}

/** The question for one category: "Make $650 a month your Groceries budget?", or "Do you want a Groceries budget?" with no suggestion. */
export function askHeading(ask: BudgetAsk): string {
	return ask.suggestion
		? `Make ${dollarsWords(ask.suggestion.amountCents)} a month your ${ask.name} budget?`
		: `Do you want a ${ask.name} budget?`;
}

/** The primary button of a suggestion: "Yes, $650". */
export function yesLabel(amountCents: number): string {
	return `Yes, ${dollarsWords(amountCents)}`;
}

/** The keep-all question: "Keep all 12 budgets, $4,050 a month?", counted and totalled over the suggestions it keeps. */
export function keepAllHeading(count: number, totalCents: number): string {
	return `Keep all ${count} ${count === 1 ? "budget" : "budgets"}, ${dollarsWords(totalCents)} a month?`;
}

/** The keep-all question's muted line: which months the suggestions come from, and the rounding. */
export function keepAllLine(months: MonthSpent[]): string {
	return `Your bank shows what each category spent in ${monthList(months)}. Tally rounded each up to the next $10.`;
}

/** The muted note under a suggestion: where its amount came from, and from which month it takes effect. */
export function suggestionNote(currentMonth: string): string {
	return `Tally's suggestion: a typical month, rounded up to the next $10. From ${monthName(currentMonth)} on.`;
}

/** The ledger line the kept budgets write: "Budgets · 12 kept, $4,050 a month", in ink. */
export function budgetsLedgerLine(count: number, cents: number): string {
	return `Budgets · ${count} kept, ${dollarsWords(cents)} a month`;
}

/**
 * The reply to a keep all: "Kept 12 budgets.", and how many suggestions changed since the page drew, when any did (then
 * nothing kept is "Nothing saved." and the suggestions are asked again below).
 */
export function keptBudgetsWords(kept: number, changed: number): string {
	if (kept === 0) {
		if (changed === 0) return "Nothing kept.";
		return changed === 1
			? "Nothing saved. 1 suggestion changed since the page drew, so it's asked again below."
			: `Nothing saved. ${changed} suggestions changed since the page drew, so they're asked again below.`;
	}
	const keptWords = kept === 1 ? "Kept 1 budget." : `Kept ${kept} budgets.`;
	if (changed === 0) return keptWords;
	const asked =
		changed === 1
			? "1 changed since the page drew, so it's asked again below."
			: `${changed} changed since the page drew, so they're asked again below.`;
	return `${keptWords} ${asked}`;
}

/** The reply to a yes or another amount: "Groceries: $650 a month.", the same words the ledger and the toast use. */
export function savedBudgetWords(name: string, cents: number): string {
	return `${name}: ${dollarsWords(cents)} a month.`;
}

/** The reply to a skip: "Groceries: no budget yet." */
export function skippedBudgetWords(name: string): string {
	return `${name}: no budget yet.`;
}

/** The reply when a suggestion moved since the page drew: nothing saved, and the question is asked again. */
export function budgetChangedWords(name: string): string {
	return `Nothing saved. ${name}'s suggestion changed since the page drew, so it's asked again below.`;
}

/**
 * The reply to an answer for a category that isn't the first one asked: the page moved on, so nothing is saved and the
 * first question is asked again. It is not budgetChangedWords, since no suggestion changed.
 */
export function budgetsMovedOnWords(): string {
	return "Nothing saved. The categories changed since the page drew, so the next one is asked below.";
}

/** The reply to an answer from a form drawn in another household month: nothing saved, and the question is asked again for this month. */
export function budgetsMonthChangedWords(): string {
	return "Nothing saved. The month changed since the page drew, so the question is asked again below.";
}

/**
 * The Needs a category line's words after its link: " · 86 transactions · about $320 a month", the monthly mean left out
 * when it is none. The link reads "Needs a category" and these follow it.
 */
export function needsTail(count: number, meanCents: number | null): string {
	const noun = count === 1 ? "transaction" : "transactions";
	const about =
		meanCents !== null && meanCents > 0
			? ` · about ${formatCents(meanCents, { wholeDollars: true })} a month`
			: "";
	return ` · ${count} ${noun}${about}`;
}

/** The ruled-off total's status line, once the budgets stroke is drawn (the fourth stroke, spec §8.8). */
export const RULED_STATUS =
	"Four. Tomorrow Tally keeps count on its own, and that's the fifth.";

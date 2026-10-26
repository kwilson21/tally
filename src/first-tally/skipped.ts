// The setup steps that asked nothing (P142 A, #773): a step with nothing to ask says so on the next screen, in today's words,
// and counts as done (P125 E). Each note names its step, the words, and what waits in Possible bills.
import { type NothingAsked, nothingAskedLine } from "./budgets";
import type { FirstPageModel } from "./first-page";

/** One step that asked nothing: its name, what it says, and how many charges wait in Possible bills. */
export type SkippedNote = { step: string; text: string; waiting: number };

/** Pay with nothing spotted: "Tally didn't spot a paycheck." (today's words, with the way to mark one later). */
export const skippedPay = (): SkippedNote => ({
	step: "Your pay",
	text: "Tally didn't spot a paycheck. You can mark one from any transaction later.",
	waiting: 0,
});

/** Bills with nothing to keep in one tap, with the charges that wait in Possible bills. */
export const skippedBills = (waiting: number): SkippedNote => ({
	step: "Your bills",
	text: "Nothing here to keep in one tap.",
	waiting,
});

/** Budgets with nothing to ask, for the reason the step gives (nothingAskedLine). */
export const skippedBudgets = (reason: NothingAsked): SkippedNote => ({
	step: "Your budgets",
	text: nothingAskedLine(reason),
	waiting: 0,
});

/** Pay asked nothing: no merchant is left to ask, and no answer was recorded. */
const payAskedNothing = (model: FirstPageModel): boolean =>
	!model.payAnswered && model.pay.length === 0;

/** Bills asked nothing: no charge to keep, and no bills line was kept (the ledger's `bills` line). */
const billsAskedNothing = (model: FirstPageModel): boolean =>
	model.keep.length === 0 && !model.ledger.some((line) => line.id === "bills");

/**
 * The steps that asked nothing, run back from `last` (bills, or budgets for the savings screen), in the order they draw. Each is
 * included while it asked nothing; the run stops at the first step that asked something, so a step with a question above it
 * gets no note from below. Budgets asked nothing when its step is not done and gave a reason (nothingAsked).
 */
function runBack(
	model: FirstPageModel,
	last: "bills" | "budgets",
): SkippedNote[] {
	const notes: SkippedNote[] = [];
	if (last === "budgets") {
		const budgets = model.budgets;
		if (!budgets || budgets.done || budgets.nothingAsked === null) return [];
		notes.unshift(skippedBudgets(budgets.nothingAsked));
	}
	if (!billsAskedNothing(model)) return notes;
	notes.unshift(skippedBills(model.waiting.length));
	if (!payAskedNothing(model)) return notes;
	notes.unshift(skippedPay());
	return notes;
}

/**
 * The notes a setup screen draws under its step bar (P142 A, #773). The pay screen draws none. The bills screen draws the pay
 * note when pay asked nothing. A budgets screen (keep all, or one at a time) draws the run ending at bills, but only while no
 * budget is answered, so the notes show on the step's first screen and not on each later category. The savings screen draws
 * the run ending at budgets. The ruled-off total draws none.
 */
export function skippedNotes(model: FirstPageModel): SkippedNote[] {
	if (model.pay.length > 0) return [];
	if (model.keep.length > 0)
		return payAskedNothing(model) ? [skippedPay()] : [];
	const budgets = model.budgets;
	if (!budgets || budgets.done) return [];
	if (budgets.asks.length > 0)
		return model.budgetsAnswered ? [] : runBack(model, "bills");
	return runBack(model, "budgets");
}

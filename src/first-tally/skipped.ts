// The setup steps that asked nothing (P142 A, #773): a step with nothing to ask says so on the next screen, in today's words,
// and counts as done (P125 E). Each note names its step, the words, and what waits in Possible bills.
import { type NothingAsked, nothingAskedLine } from "./budgets";

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

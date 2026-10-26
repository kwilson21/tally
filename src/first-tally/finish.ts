// The setup finish's words (P142 A, decision 148, spec §8.8, #774): the lines under "You're set up." Every money amount is
// worded by dollarsWords, the finish's one money rule (whole dollars, cents kept when there are some), and the pay line
// by the pay step's own amount and cadence (pay.ts), so each number reads as the step that set it did.
import { monthName } from "../dates";
import { amountWords, cadenceOf, dollarsWords, type PayDeposit } from "./pay";

/** The finish's serif heading. */
export const FINISH_HEADING = "You're set up.";

/** The finish's line above the month's number: "Safe to spend in October" ("2026-10" in). */
export const safeToSpendIn = (month: string) =>
	`Safe to spend in ${monthName(month)}`;

/** The muted line under the month's number: what the number is left after. */
export const finishLead = (month: string) =>
	`What's left of ${monthName(month)}'s budgets after what you've spent, the bills still to pay and your savings.`;

/**
 * The Pay row's value: the merchant the family said yes to, its amount and its cadence, as payLedgerLine words them, with a
 * dot between the name and the amount: "ACME Corp · $2,450 every other Friday", or the range with no cadence.
 */
export function finishPayLine({
	name,
	deposits,
}: {
	name: string;
	deposits: PayDeposit[];
}): string {
	const cadence = cadenceOf(deposits.map((deposit) => deposit.date));
	return `${name} · ${amountWords(deposits)}${cadence ? ` ${cadence}` : ""}`;
}

/** The Bills row's value: how many bills were kept and their monthly total, "8 bills · $1,240 a month" (1 bill in the singular). */
export const finishBillsLine = (kept: number, cents: number) =>
	`${kept === 1 ? "1 bill" : `${kept} bills`} · ${dollarsWords(cents)} a month`;

/** The Budgets row's value: how many budgets were set and their monthly total, "12 budgets · $4,050 a month" (1 in the singular). */
export const finishBudgetsLine = (count: number, cents: number) =>
	`${count === 1 ? "1 budget" : `${count} budgets`} · ${dollarsWords(cents)} a month`;

/** The Savings row's value: the monthly goal, "$150 a month". */
export const finishSavingsLine = (cents: number) =>
	`${dollarsWords(cents)} a month`;

/** The foot's line under Go to Home, shown only while Sort right away is on (spec §8.8, §8.6). */
export const SORTS_LINE =
	"From now on Tally sorts new transactions as your bank sends them.";

// Numbers an Apple Card upload's rows and words what happened to them (spec §8.10, decisions 138 and 144). Pure: no
// database here. import.ts stores the plan.

import { shortDay } from "../dates";
import { type AppleRow, cleanText } from "./csv";

export const PAYMENT_TYPE = "Payment";

/**
 * The key that makes a row Tally's, so a row is never added twice (spec §8.10). Its Transaction Date, Clearing Date,
 * Description, Type and Amount, with the text NFC-normalized and trimmed. Changing this re-keys every held row and
 * doubles it on the next upload, so the golden test in apple-card-plan.test.ts pins its exact text.
 */
export function rowKey(row: AppleRow): string {
	return JSON.stringify([
		row.transactionDate,
		row.clearingDate,
		cleanText(row.description),
		cleanText(row.type),
		row.amountCents,
	]);
}

/**
 * Whether a row is left out at upload and stored as the bank's exclusion (decision 144): a Payment, which is the card
 * being paid, and an Other row that says REVERSAL and money went out on, which is a payment that bounced. Only money
 * out, so a money-in row that says REVERSAL (a refund) counts by its sign. A person can count a left-out row back in.
 */
export function leftOut(row: AppleRow): boolean {
	if (row.type === PAYMENT_TYPE) return true;
	return (
		row.type === "Other" &&
		row.amountCents > 0 &&
		/REVERSAL/i.test(row.description)
	);
}

export type ImportPlan = {
	/** Every row to try, in file order. An excluded row is still added, so it counts as held. */
	add: { row: AppleRow; key: string; twin: number; excluded: boolean }[];
	/** Rows with no Clearing Date yet: left out, and a later upload brings them in. */
	notCleared: number;
	/** Rows cleared before Tally's history starts: left out. */
	beforeHistory: number;
};

/**
 * Plans an upload: a row with no Clearing Date is counted as not cleared, one cleared before `historyStart` as before
 * history, and every other row is numbered among its identical rows (its twin), from 1, in file order. The store skips
 * the twins Tally already holds.
 */
export function planImport(rows: AppleRow[], historyStart: string): ImportPlan {
	const add: ImportPlan["add"] = [];
	const twins = new Map<string, number>();
	let notCleared = 0;
	let beforeHistory = 0;
	for (const row of rows) {
		if (row.clearingDate === null) {
			notCleared++;
			continue;
		}
		if (row.clearingDate < historyStart) {
			beforeHistory++;
			continue;
		}
		const key = rowKey(row);
		const twin = (twins.get(key) ?? 0) + 1;
		twins.set(key, twin);
		add.push({ row, key, twin, excluded: leftOut(row) });
	}
	return { add, notCleared, beforeHistory };
}

/**
 * The words the toast and announcer say after an upload (spec §8.10): what was added, what was already there, what
 * hasn't cleared, and what was before Tally's history. `today` names the year only when it isn't this year's.
 */
export function importWords(
	counts: {
		added: number;
		already: number;
		notCleared: number;
		beforeHistory: number;
	},
	historyStart: string,
	today: string,
): string {
	const { added, already, notCleared, beforeHistory } = counts;
	const sentences: string[] = [];
	if (added > 0) {
		sentences.push(`Added ${added} from Apple Card.`);
		if (already > 0)
			sentences.push(
				`${already} ${already === 1 ? "was" : "were"} already in Tally.`,
			);
	} else if (already > 0) {
		sentences.push(
			"Nothing new.",
			already === 1
				? "1 was already in Tally."
				: `All ${already} were already in Tally.`,
		);
	} else sentences.push("Nothing new.");
	if (notCleared > 0)
		sentences.push(
			notCleared === 1
				? "1 hasn't cleared yet."
				: `${notCleared} haven't cleared yet.`,
		);
	if (beforeHistory > 0)
		sentences.push(
			`${beforeHistory} ${beforeHistory === 1 ? "was" : "were"} from before ${shortDay(historyStart, today)}, when Tally's history starts.`,
		);
	return sentences.join(" ");
}

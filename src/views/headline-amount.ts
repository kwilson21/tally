// One rule for every headline amount (decision 110): Home's Safe to spend, a finished month's result,
// Accounts' Net worth and Trends' Spent so far. An amount 9 or more characters long ("−$999,999",
// "$1,000,000") is one size smaller on a phone under 640px; shorter ones and every desktop size keep
// the view's own classes.
//
// A second rule is Home's notebook drawing only (P127 A, decision 116). The drawing sits beside the
// amount, so it follows the amount's length rather than the size rule above: up to 7 characters it
// shows from 390px, and 8 or more it waits for 640px. The widest 8-character amount plus its gap and
// the drawing needs 396px of row, and no phone up to 430px leaves it 8px to spare.

/** The extra class for a headline amount, given the text the view shows (minus sign, $ and commas included). */
export function headlineAmountClass(text: string): "" | "max-sm:text-5xl" {
	return text.length >= 9 ? "max-sm:text-5xl" : "";
}

/** Home's notebook drawing class beside Safe to spend, given the text the view shows (decision 116). */
export function homeDrawingClass(
	text: string,
): "min-[390px]:block" | "sm:block" {
	return text.length >= 8 ? "sm:block" : "min-[390px]:block";
}

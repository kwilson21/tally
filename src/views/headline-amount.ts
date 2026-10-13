// One rule for every headline amount (decision 110): Home's Safe to spend, a finished month's result,
// Accounts' Net worth and Trends' Spent so far. An amount 9 or more characters long ("−$999,999",
// "$1,000,000") is one size smaller on a phone under 640px; shorter ones and every desktop size keep
// the view's own classes.

/** The extra class for a headline amount, given the text the view shows (minus sign, $ and commas included). */
export function headlineAmountClass(text: string): "" | "max-sm:text-5xl" {
	return text.length >= 9 ? "max-sm:text-5xl" : "";
}

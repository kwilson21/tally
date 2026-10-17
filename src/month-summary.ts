// A month's summary as Home draws it (spec §6, §8.4): the month's loaded numbers, the bills still to pay this month and
// the plans set aside, and what they add up to. Home and the first page's ruled-off total both read it here, so the
// Safe to spend they show is the same number (P125 E, decision 114).
import { loadBillRows } from "./bills/rows";
import { billTotalsForRows } from "./bills/totals";
import { summarizeMonth } from "./budget";
import { loadMonth } from "./db/month";
import { plansSetAsideCents } from "./db/planned-expenses";

/**
 * The month's summary, with what it was built from. Only the current month sets bills and plans aside (Safe to spend
 * is the current month's number); any other month reads its budgets and spending alone.
 */
export async function readMonthSummary(
	db: D1Database,
	today: string,
	month: string,
) {
	const current = month === today.slice(0, 7);
	const data = await loadMonth(db, month);
	const billData = current ? await loadBillRows(db, today) : null;
	const activeBills = billData?.rows.filter((bill) => bill.active) ?? [];
	const billTotals = current ? billTotalsForRows(month, activeBills) : null;
	const unpaidPlansCents = current ? await plansSetAsideCents(db, month) : 0;
	const summary = summarizeMonth({
		month,
		...data,
		unpaidDueBillsCents: billTotals?.setAsideCents ?? 0,
		savingsGoalCents: data.savingsGoalCents,
		unpaidPlansCents,
	});
	return { data, billData, activeBills, billTotals, summary };
}

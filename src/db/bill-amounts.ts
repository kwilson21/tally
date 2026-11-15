// A bill's amount rows as the Bills screens, the matcher and the payment offers read them (spec §5
// `bill_amounts`, decision 101). The rules for picking a month's amount are in src/bills/amount.ts.
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { AmountRow } from "../bills/amount";
import { billAmounts } from "./schema";

/**
 * Every bill's amount rows, grouped by bill id and in month order, from one statement. With `billId`, only
 * that bill's rows (the map then holds at most that one bill).
 */
export async function amountRowsByBill(
	db: D1Database,
	billId?: number,
): Promise<Map<number, AmountRow[]>> {
	const results = await drizzle(db)
		.select({
			billId: billAmounts.billId,
			effectiveMonth: billAmounts.effectiveMonth,
			amountCents: billAmounts.amountCents,
		})
		.from(billAmounts)
		.where(billId === undefined ? undefined : eq(billAmounts.billId, billId))
		.orderBy(asc(billAmounts.billId), asc(billAmounts.effectiveMonth))
		.all();

	const byBill = new Map<number, AmountRow[]>();

	for (const row of results) {
		const list = byBill.get(row.billId) ?? [];
		list.push({
			effectiveMonth: row.effectiveMonth,
			amountCents: row.amountCents,
		});
		byBill.set(row.billId, list);
	}

	return byBill;
}

// Stays raw SQL: a string helper placed inside other raw statements (src/bills/unpaid.ts, src/bills/price-change.ts).
/**
 * The amount a bill occurrence is judged at, as SQL, the rule src/bills/amount.ts's `amountForMonth` reads: the
 * latest row on or before `month`, else the earliest row, else the bill's own amount. `billId` and `month` are
 * SQL expressions (numbered parameters or columns), so a statement names the bill and month it checks.
 */
export const occurrenceAmountSql = (billId: string, month: string) => `COALESCE(
	(SELECT amount_cents FROM bill_amounts WHERE bill_id = ${billId} AND effective_month <= ${month} ORDER BY effective_month DESC LIMIT 1),
	(SELECT amount_cents FROM bill_amounts WHERE bill_id = ${billId} ORDER BY effective_month LIMIT 1),
	(SELECT amount_cents FROM bills WHERE id = ${billId}))`;

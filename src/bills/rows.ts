// Bills' rows as of a date: each bill's shown occurrence with its status, its amount and what is paid on it. Bills,
// Home's month summary and How Tally works all read the rows here, so they agree on the same numbers.

import { daysBefore } from "../dates";
import { amountRowsByBill } from "../db/bill-amounts";
import { billPeriodMonth, type CountedBill } from "../db/counted-month";
import type { BillRowData } from "../views/bill-row";
import { type AmountRow, amountForMonth } from "./amount";
import {
	type BillStatus,
	billOccurrence,
	billOccurrencesForMonth,
	handledBeforeAdded,
	occurrencePaid,
} from "./status";
import type { BillTotalFrequency } from "./totals";

export type DbBill = {
	id: number;
	name: string;
	amount_cents: number;
	due_day: number;
	frequency: "monthly" | "yearly" | "weekly" | "biweekly" | "quarterly";
	anchor_month: number | null;
	anchor_date: string | null;
	category_id: number | null;
	merchant_raw_name: string;
	merchant_raw_text: number;
	active: number;
	added_on: string | null;
	icon: string | null;
	color: string | null;
	payment_period?: string | null;
	payment_date?: string | null;
	payment_amount_cents?: number | null;
};

function previousMonth(today: string) {
	const year = Number(today.slice(0, 4));
	const month = Number(today.slice(5, 7));
	return month === 1
		? `${year - 1}-12`
		: `${year}-${String(month - 1).padStart(2, "0")}`;
}

/** Every bill with its status, as of `today`: the household's date, read once by the request. */
export async function loadBillRows(db: D1Database, today: string) {
	const rows = await db
		.prepare(
			`SELECT b.*, c.icon, c.color, bp.period AS payment_period, t.date AS payment_date, t.amount_cents AS payment_amount_cents
			 FROM bills b
			 LEFT JOIN categories c ON c.id=b.category_id
			 LEFT JOIN bill_payments bp ON bp.bill_id=b.id AND bp.status='linked'
			   AND (bp.period >= ? OR (length(bp.period)=4 AND bp.period >= ?) OR (b.frequency='quarterly' AND bp.period >= ?))
			 LEFT JOIN transactions t ON t.id=bp.transaction_id
			 ORDER BY b.id`,
		)
		// Only the periods billOccurrence can pick: last month on, or last year on.
		.bind(
			previousMonth(today),
			String(Number(today.slice(0, 4)) - 1),
			`${Number(today.slice(0, 4)) - 1}-Q1`,
		)
		.all<DbBill>();
	const result: (BillRowData & {
		active: boolean;
		/** The bill's own current amount (`bills.amount_cents`), which its monthly share reads. */
		currentAmountCents: number;
		frequency: BillTotalFrequency;
		paidCents: number;
		/** Whether any payment is linked to the shown occurrence, a credit-corrected one too (a price offer reads it). */
		linked: boolean;
		totalOccurrences: {
			dueDate: string;
			status: BillStatus;
			amountCents: number;
			paidCents: number;
		}[];
		nextOccurrence?: {
			dueDate: string;
			status: BillStatus;
			amountCents: number;
			paidCents: number;
		};
		/** The occurrence the row shows, as bill_payments keys it, and the merchant it's matched on. */
		period: string;
		merchantRawName: string;
		merchantRawText: number;
	})[] = [];
	const byBill = new Map<number, DbBill[]>();
	for (const row of rows.results) {
		const list = byBill.get(row.id);
		if (list) list.push(row);
		else byBill.set(row.id, [row]);
	}
	const amounts = await amountRowsByBill(db);
	// An occurrence's status in the month's totals: paid once its payments reach 90%, else overdue, due within seven
	// days, or upcoming. A part-paid occurrence keeps the status its date gives it (decision 101).
	const occurrenceStatus = (dueDate: string, paid: boolean): BillStatus =>
		paid
			? "paid"
			: dueDate < today
				? "overdue"
				: dueDate <= daysBefore(today, -7)
					? "due"
					: "upcoming";
	for (const billRows of byBill.values()) {
		const b = billRows[0] as DbBill;
		// An occurrence's amount is the one of its own month (decision 101); see src/bills/amount.ts.
		const amountHistory = amounts.get(b.id) ?? [];
		const amountOf = (dueDate: string) =>
			amountForMonth(amountHistory, dueDate.slice(0, 7), b.amount_cents);
		// The latest payment's date, which a Paid occurrence's row shows.
		const payments = new Map<string, string>();
		for (const row of billRows) {
			if (!row.payment_period || !row.payment_date) continue;
			if ((payments.get(row.payment_period) ?? "") < row.payment_date)
				payments.set(row.payment_period, row.payment_date);
		}
		const paymentsByPeriod = paidByPeriodOf(
			billRows.map((row) => ({
				period: row.payment_period,
				amount_cents: row.payment_amount_cents,
			})),
		);
		const paidPeriods = paidPeriodsOf(b, amountHistory, paymentsByPeriod);
		const occurrence = billOccurrence(
			{
				frequency: b.frequency,
				dueDay: b.due_day,
				anchorMonth: b.anchor_month,
				anchorDate: b.anchor_date,
				addedOn: b.added_on,
			},
			today,
			paidPeriods,
			new Set(payments.keys()),
		);
		const totalOccurrences = [
			{
				dueDate: occurrence.dueDate,
				status: occurrence.status,
				amountCents: amountOf(occurrence.dueDate),
				paidCents: paymentsByPeriod.get(occurrence.period) ?? 0,
			},
		];
		const monthOccurrences = billOccurrencesForMonth(
			{
				frequency: b.frequency,
				dueDay: b.due_day,
				anchorMonth: b.anchor_month,
				anchorDate: b.anchor_date,
			},
			Number(today.slice(0, 4)),
			Number(today.slice(5, 7)),
		);
		for (const current of monthOccurrences)
			if (
				!handledBeforeAdded(
					b.added_on,
					current.dueDate,
					payments.has(current.period),
				) &&
				!totalOccurrences.some((item) => item.dueDate === current.dueDate)
			) {
				totalOccurrences.push({
					dueDate: current.dueDate,
					status: occurrenceStatus(
						current.dueDate,
						paidPeriods.has(current.period),
					),
					amountCents: amountOf(current.dueDate),
					paidCents: paymentsByPeriod.get(current.period) ?? 0,
				});
			}
		// A weekly or every-two-weeks bill's next occurrence is due soon once it falls due, even when it is in next
		// month (an unpaid Friday on Oct 30 with Nov 6 due in a week). Safe to spend sets it aside only in its own
		// month (decision 123). Only that one is needed beyond the month.
		const stepDays =
			b.frequency === "weekly" ? 7 : b.frequency === "biweekly" ? 14 : 0;
		const nextDue = stepDays ? daysBefore(occurrence.dueDate, -stepDays) : "";
		const nextOccurrence =
			nextDue && !nextDue.startsWith(today.slice(0, 7))
				? {
						dueDate: nextDue,
						status: occurrenceStatus(nextDue, paidPeriods.has(nextDue)),
						amountCents: amountOf(nextDue),
						paidCents: paymentsByPeriod.get(nextDue) ?? 0,
					}
				: undefined;
		result.push({
			id: b.id,
			name: b.name,
			// The shown occurrence's amount: the Bills row, its status and its set-aside totals read this. The
			// monthly share reads currentAmountCents instead.
			amountCents: amountOf(occurrence.dueDate),
			currentAmountCents: b.amount_cents,
			status: occurrence.status,
			dueDate: occurrence.dueDate,
			paidDate: payments.get(occurrence.period),
			icon: b.icon ?? "bills",
			color: b.color ?? "",
			active: !!b.active,
			period: occurrence.period,
			merchantRawName: b.merchant_raw_name,
			merchantRawText: b.merchant_raw_text,
			frequency: b.frequency,
			dueDay: b.due_day,
			anchorMonth: b.anchor_month,
			paidCents: paymentsByPeriod.get(occurrence.period) ?? 0,
			linked: paymentsByPeriod.has(occurrence.period),
			totalOccurrences,
			nextOccurrence,
		});
	}
	return { today, rows: result };
}

/** The bill as the counting rule reads it, so the month a payment counts in is worked out one way (src/db/counted-month.ts). */
export const countedBill = (bill: DbBill): CountedBill => ({
	frequency: bill.frequency,
	anchorMonth: bill.anchor_month,
});

/** The cents each period's linked payments add up to: a linked payment a bank later turned into a credit counts as $0. */
export function paidByPeriodOf(
	payments: { period?: string | null; amount_cents?: number | null }[],
) {
	const paid = new Map<string, number>();
	for (const payment of payments) {
		if (!payment.period) continue;
		paid.set(
			payment.period,
			(paid.get(payment.period) ?? 0) + Math.max(0, payment.amount_cents ?? 0),
		);
	}
	return paid;
}
/**
 * The periods that are Paid (decision 101): those whose linked cents, `paidByPeriod`, reach 90% of the amount of
 * their own month (occurrencePaid, src/bills/amount.ts). A period with a part payment is left out.
 */
export function paidPeriodsOf(
	bill: DbBill,
	history: AmountRow[],
	paidByPeriod: ReadonlyMap<string, number>,
) {
	return new Set(
		[...paidByPeriod]
			.filter(([period, cents]) =>
				occurrencePaid(
					cents,
					amountForMonth(
						history,
						billPeriodMonth(countedBill(bill), period),
						bill.amount_cents,
					),
				),
			)
			.map(([period]) => period),
	);
}

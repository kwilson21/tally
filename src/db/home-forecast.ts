import { monthsBefore } from "../dates";
import {
	COUNTED_JOINS,
	COUNTED_SPENDING,
	countedMonthSql,
} from "./counted-month";

export type HomeForecastDay = {
	day: number;
	spentCents: number;
	billPaymentsCents: number;
	refundsCents: number;
};

/** Reads only this month's dates through today; the date range uses transactions_date. */
export async function homeForecastDays(
	db: D1Database,
	month: string,
	today: string,
): Promise<HomeForecastDay[]> {
	const nextMonth = `${monthsBefore(month, -1)}-01`;
	const { results } = await db
		.prepare(
			`WITH classified AS (
				SELECT CAST(substr(t.date, 9, 2) AS INTEGER) AS day, t.amount_cents,
					CASE WHEN bp.id IS NOT NULL THEN 'bill'
						WHEN t.amount_cents < 0 THEN 'refund' ELSE 'spending' END AS role
				FROM transactions t ${COUNTED_JOINS}
				WHERE t.date >= ? AND t.date < ? AND t.date <= ?
					AND ${countedMonthSql()} = ? AND ${COUNTED_SPENDING}
			)
			SELECT day, SUM(amount_cents) AS spentCents,
				SUM(CASE WHEN role = 'bill' THEN amount_cents ELSE 0 END) AS billPaymentsCents,
				SUM(CASE WHEN role = 'refund' THEN -amount_cents ELSE 0 END) AS refundsCents
			FROM classified GROUP BY day ORDER BY day`,
		)
		.bind(`${month}-01`, nextMonth, today, month)
		.all<HomeForecastDay>();
	return results;
}

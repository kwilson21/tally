// Reads `balance_history` (spec §5) for the net-worth chart on Accounts.
import { chartStart, type NetWorthPoint, netWorthSeries } from "../net-worth";

type Row = {
	account_id: number;
	date: string;
	balance_cents: number;
	is_liability: number;
};

/**
 * Net worth on each recorded day of the chart's six months, ending today. Like the headline it
 * counts only accounts of banks still connected, never the Cash account (it has no bank). Each
 * account's last balance from before the six months is read too, so an account that wasn't
 * recorded since still counts.
 */
export async function netWorthHistory(
	db: D1Database,
	today: string,
): Promise<NetWorthPoint[]> {
	const from = chartStart(today);
	const { results } = await db
		.prepare(
			`SELECT h.account_id, h.date, h.balance_cents, a.is_liability
			FROM balance_history h
			JOIN accounts a ON a.id = h.account_id
			JOIN plaid_items p ON p.id = a.plaid_item_id
			WHERE p.disconnected_at IS NULL AND h.date <= ?
				AND (h.date >= ? OR h.date = (
					SELECT MAX(date) FROM balance_history WHERE account_id = h.account_id AND date < ?
				))`,
		)
		.bind(today, from, from)
		.all<Row>();
	return netWorthSeries(
		results.map((r) => ({
			accountId: r.account_id,
			date: r.date,
			balanceCents: r.balance_cents,
			isLiability: r.is_liability === 1,
		})),
		from,
	);
}

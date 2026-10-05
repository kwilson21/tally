// Reads `balance_history` (spec §5) for the net-worth chart on Accounts.

import {
	accountsWaiting,
	type BalanceRow,
	chartStart,
	type NetWorthPoint,
	netWorthSeries,
} from "../net-worth";
import {
	type Bank,
	type BankRow,
	banksFromRows,
	banksStatement,
} from "./accounts";

type HistoryRow = {
	account_id: number;
	date: string;
	balance_cents: number;
	is_liability: number;
};

/**
 * The chart's balance rows: those of the six months, through today, and each account's last one from
 * before them, so an account that wasn't recorded since still counts. Only accounts of banks still
 * connected, never Cash (it has no bank), as the headline counts.
 */
function balanceRowsStatement(db: D1Database, today: string) {
	const from = chartStart(today);
	return db
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
		.bind(today, from, from);
}

/**
 * Accounts' data in one read: the banks and their accounts (the headline's numbers) and net worth on
 * each recorded day of the chart's six months. D1 runs a batch as one transaction, so a sync landing
 * during the page can't make the line contradict the headline.
 *
 * The line counts the accounts the headline counts. It has no points until every one of them has a
 * balance, and `waiting` says how many are still without one (spec §8.3).
 */
export async function accountsWithHistory(
	db: D1Database,
	today: string,
): Promise<{ banks: Bank[]; points: NetWorthPoint[]; waiting: number }> {
	const [bankResult, balanceResult] = await db.batch([
		banksStatement(db),
		balanceRowsStatement(db, today),
	]);
	const banks = banksFromRows((bankResult?.results ?? []) as BankRow[]);
	const accountIds = banks
		.flatMap((bank) => bank.accounts)
		.filter((account) => account.connected !== false)
		.map((account) => account.id);
	const rows: BalanceRow[] = (
		(balanceResult?.results ?? []) as HistoryRow[]
	).map((r) => ({
		accountId: r.account_id,
		date: r.date,
		balanceCents: r.balance_cents,
		isLiability: r.is_liability === 1,
	}));
	return {
		banks,
		points: netWorthSeries(rows, chartStart(today), accountIds),
		waiting: accountsWaiting(rows, accountIds),
	};
}

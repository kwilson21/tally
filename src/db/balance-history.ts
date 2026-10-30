// Reads `balance_history` (spec §5) for the net-worth chart on Accounts.

import {
	type AccountAdded,
	type AccountSource,
	accountsAdded,
	type BalanceRow,
	chartStart,
	type NetWorthPoint,
	netWorthSeries,
} from "../net-worth";
import {
	type AppleCardAccount,
	type AppleCardRow,
	appleCardFromRow,
	appleCardStatement,
	type Bank,
	type BankRow,
	banksFromRows,
	banksStatement,
	countedAccounts,
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
 * connected and the Apple Card once it counts (spec §8.10), never Cash (it has no bank), as the headline counts.
 * The Apple Card's rows count only from its counted day on, so an older balance never carries through a gap.
 */
function balanceRowsStatement(db: D1Database, today: string) {
	const from = chartStart(today);
	return db
		.prepare(
			`SELECT h.account_id, h.date, h.balance_cents, a.is_liability
			FROM balance_history h
			JOIN accounts a ON a.id = h.account_id
			LEFT JOIN plaid_items p ON p.id = a.plaid_item_id
			WHERE ((p.id IS NOT NULL AND p.disconnected_at IS NULL)
					OR (a.subtype = 'apple_card' AND a.removed_at IS NULL AND a.balance_on IS NOT NULL AND h.date >= a.counted_from))
				AND h.date <= ?
				AND (h.date >= ? OR h.date = (
					SELECT MAX(date) FROM balance_history WHERE account_id = h.account_id AND date < ?
				))`,
		)
		.bind(today, from, from);
}

/**
 * The banks and the Apple Card the line can name when they're added (decision 154): each connected bank as
 * "linked", and the Apple Card as "added" once its balance counts (the same test countedAccounts applies to it).
 */
function accountSources(
	banks: Bank[],
	appleCard: AppleCardAccount | null,
): AccountSource[] {
	const sources: AccountSource[] = banks
		.filter((bank) => !bank.disconnected)
		.map(
			(bank): AccountSource => ({
				name: bank.name,
				verb: "linked",
				accountIds: bank.accounts
					.filter((account) => account.connected !== false)
					.map((account) => account.id),
			}),
		);
	if (appleCard && appleCard.balanceOn !== null && appleCard.removedAt === null)
		sources.push({
			name: "Apple Card",
			verb: "added",
			accountIds: [appleCard.id],
		});
	return sources;
}

/**
 * Accounts' data in one read: the banks and their accounts (the headline's numbers), the Apple Card, and net worth on
 * each recorded day of the chart's six months. D1 runs a batch as one transaction, so a sync landing
 * during the page can't make the line contradict the headline.
 *
 * The line counts the accounts the headline counts, each from its first balance, so it keeps its past months when an
 * account is added. `added` names the banks and the card whose first balance came after the line's first day, which
 * the line's sentence names after its change (decision 154, spec §8.3).
 */
export async function accountsWithHistory(
	db: D1Database,
	today: string,
): Promise<{
	banks: Bank[];
	points: NetWorthPoint[];
	added: AccountAdded[];
	appleCard: AppleCardAccount | null;
}> {
	const [bankResult, balanceResult, cardResult] = await db.batch([
		banksStatement(db),
		balanceRowsStatement(db, today),
		appleCardStatement(db),
	]);
	const banks = banksFromRows((bankResult?.results ?? []) as BankRow[]);
	const appleCard = appleCardFromRow(
		((cardResult?.results ?? []) as AppleCardRow[])[0],
	);
	const accountIds = countedAccounts(banks, appleCard)
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
	const points = netWorthSeries(rows, chartStart(today), accountIds);
	return {
		banks,
		points,
		added: accountsAdded(
			rows,
			accountSources(banks, appleCard),
			points[0]?.date ?? "",
		),
		appleCard,
	};
}

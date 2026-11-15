// Reads `balance_history` (spec §5) for the net-worth chart on Accounts.

import { and, eq, gte, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { alias } from "drizzle-orm/sqlite-core";
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
	appleCardFromRow,
	appleCardStatement,
	type Bank,
	banksFromRows,
	banksStatement,
	countedAccounts,
} from "./accounts";
import { accounts, balanceHistory, plaidItems } from "./schema";

/**
 * The chart's balance rows: those of the six months, through today, and each account's last one from
 * before them, so an account that wasn't recorded since still counts. Only accounts of banks still
 * connected and the Apple Card once it counts (spec §8.10), never Cash (it has no bank), as the headline counts.
 * The Apple Card's rows count only from its counted day on, so an older balance never carries through a gap.
 */
function balanceRowsStatement(db: D1Database, today: string) {
	const from = chartStart(today);
	const h = alias(balanceHistory, "h");
	// The last balance before the six months, read from a second alias so its columns don't shadow the outer row's.
	const prior = alias(balanceHistory, "prior");

	return drizzle(db)
		.select({
			account_id: h.accountId,
			date: h.date,
			balance_cents: h.balanceCents,
			is_liability: accounts.isLiability,
		})
		.from(h)
		.innerJoin(accounts, eq(accounts.id, h.accountId))
		.leftJoin(plaidItems, eq(plaidItems.id, accounts.plaidItemId))
		.where(
			and(
				or(
					and(isNotNull(plaidItems.id), isNull(plaidItems.disconnectedAt)),
					and(
						eq(accounts.subtype, "apple_card"),
						isNull(accounts.removedAt),
						isNotNull(accounts.balanceOn),
						gte(h.date, accounts.countedFrom),
					),
				),
				lte(h.date, today),
				or(
					gte(h.date, from),
					eq(
						h.date,
						sql`(SELECT MAX(${prior.date}) FROM ${balanceHistory} ${sql.identifier("prior")} WHERE ${prior.accountId} = ${h.accountId} AND ${prior.date} < ${from})`,
					),
				),
			),
		);
}

/**
 * The banks and the Apple Card the line can name when they're added (decision 154): each connected bank as
 * "linked", and the Apple Card as "added" once its balance counts (the same test countedAccounts applies to it).
 */
function accountSources(
	banks: Bank[],
	appleCard: AppleCardAccount | null,
): AccountSource[] {
	const sources: AccountSource[] = banks.flatMap((bank): AccountSource[] =>
		bank.disconnected
			? []
			: [
					{
						name: bank.name,
						verb: "linked",
						accountIds: bank.accounts
							.filter((account) => account.connected !== false)
							.map((account) => account.id),
					},
				],
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
	const [bankRows, historyRows, cardRows] = await drizzle(db).batch([
		banksStatement(db),
		balanceRowsStatement(db, today),
		appleCardStatement(db),
	]);

	const banks = banksFromRows(bankRows);

	// The Apple Card statement returns at most one row; [0] is that row or undefined.
	const appleCard = appleCardFromRow(cardRows[0]);

	const accountIds = countedAccounts(banks, appleCard)
		.filter((account) => account.connected !== false)
		.map((account) => account.id);

	const rows: BalanceRow[] = historyRows.map((r) => ({
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

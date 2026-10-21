// Stores an Apple Card upload in one D1 batch (spec §8.10, decision 138): the household's one Apple Card account, its
// date and balance, and the rows Tally doesn't hold yet. The batch saves all of an upload or none of it. The rows are
// planned first (plan.ts), from the day Tally's history starts (historyStart).

import { daysBefore } from "../dates";
import { suggestBankNamesSql } from "../db/merchant-names";
import { tidyName } from "../transactions/tidy-name";
import type { AppleRow } from "./csv";
import { type ImportPlan, planImport } from "./plan";

export type ImportResult = {
	ok: true;
	accountId: number;
	/** The ids of the rows this upload added: the rows Tally didn't hold. */
	addedIds: number[];
	added: number;
	/** The rows Tally already held, counted as the file had them (`plan.add` less `added`). */
	already: number;
	notCleared: number;
	beforeHistory: number;
	/** The first day the rows count from (historyStart). */
	historyStart: string;
};

/** Rows per INSERT statement, and the most JSON per statement. Whichever comes first ends a statement. */
const ROWS_PER_STATEMENT = 500;
const JSON_CHARS_PER_STATEMENT = 500_000;

/**
 * The first day Apple Card's rows count from (spec §8.10, decision 138), so Trends and the first budget suggestions
 * stay right. The earliest date among the household's Plaid rows, kept ones included. While a connected bank's 90-day
 * history isn't all in (`history_complete_at` unset, or no rows yet), it's the earlier of that and 90 days before today.
 * With no connected bank and no Plaid rows, it's the Apple Card's own earliest row, or 90 days before today while the card
 * has none. Null when there is no card and no bank to start from.
 */
export async function historyStart(
	db: D1Database,
	today: string,
): Promise<string | null> {
	const facts = await db
		.prepare(
			`SELECT
				(SELECT MIN(t.date) FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.plaid_item_id IS NOT NULL) AS bankEarliest,
				(SELECT COUNT(*) FROM plaid_items WHERE disconnected_at IS NULL) AS connected,
				(SELECT COUNT(*) FROM plaid_items WHERE disconnected_at IS NULL AND history_complete_at IS NULL) AS loading,
				(SELECT MIN(t.date) FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.subtype = 'apple_card') AS cardEarliest,
				(SELECT COUNT(*) FROM accounts WHERE subtype = 'apple_card') AS cards`,
		)
		.first<{
			bankEarliest: string | null;
			connected: number;
			loading: number;
			cardEarliest: string | null;
			cards: number;
		}>();
	const bank = facts?.bankEarliest ?? null;
	const ninetyDaysBack = daysBefore(today, 90);
	if (
		(facts?.connected ?? 0) > 0 &&
		((facts?.loading ?? 0) > 0 || bank === null)
	)
		return bank !== null && bank < ninetyDaysBack ? bank : ninetyDaysBack;
	if (bank !== null) return bank;
	if (facts?.cardEarliest) return facts.cardEarliest;
	if ((facts?.cards ?? 0) > 0) return ninetyDaysBack;
	return null;
}

/**
 * Apple's Merchant, when it is worth suggesting as the store's name: not blank, and not what the list already shows,
 * which is the Description or the Description tidied (the same test as sync's plaidNameToSuggest).
 */
function suggestableName(row: AppleRow): string | null {
	const name = row.merchant;
	if (!name) return null;
	if (name === row.description || name === tidyName(row.description))
		return null;
	return name;
}

/** Splits the planned rows into statements of at most ROWS_PER_STATEMENT rows and JSON_CHARS_PER_STATEMENT characters. */
function chunkRows<T>(items: T[]): T[][] {
	const chunks: T[][] = [];
	let current: T[] = [];
	let size = 2;
	for (const item of items) {
		const itemSize = JSON.stringify(item).length + 1;
		if (
			current.length > 0 &&
			(current.length >= ROWS_PER_STATEMENT ||
				size + itemSize > JSON_CHARS_PER_STATEMENT)
		) {
			chunks.push(current);
			current = [];
			size = 2;
		}
		current.push(item);
		size += itemSize;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/**
 * Adds an upload's rows to the Apple Card account, with its date and balance, in one D1 batch: the account (created with
 * the first upload), its uploaded day and any typed balance, the rows in statements, the balance's day, and the names
 * Apple's merchants suggest. Returns what was added and why the rest wasn't, or an error when there is no card and no
 * bank to start Tally's history from (nothing is saved then). A row Tally holds is never changed or added twice.
 */
export async function importAppleCard(
	db: D1Database,
	rows: AppleRow[],
	options: { by: string; today: string; balanceCents: number | null },
): Promise<ImportResult | { ok: false; error: string }> {
	const start = await historyStart(db, options.today);
	if (start === null)
		return {
			ok: false,
			error: "Link a bank first. Tally's history starts with your bank's.",
		};
	const plan: ImportPlan = planImport(rows, start);
	const { today, balanceCents, by } = options;

	const statements: D1PreparedStatement[] = [
		db.prepare(
			`INSERT INTO accounts (name, type, subtype, is_liability) VALUES ('Apple Card', 'credit', 'apple_card', 1)
			 ON CONFLICT(subtype) WHERE subtype = 'apple_card' DO NOTHING`,
		),
		// A balance typed now becomes the account's; counted_from starts the chart only when no balance counted before
		// (balance_on was NULL: the card is new, or Remove cleared it).
		db
			.prepare(
				`UPDATE accounts SET
					uploaded_on = ?,
					removed_at = NULL,
					balance_cents = CASE WHEN ? IS NULL THEN balance_cents ELSE ? END,
					balance_on = CASE WHEN ? IS NULL THEN balance_on ELSE ? END,
					counted_from = CASE WHEN ? IS NOT NULL AND balance_on IS NULL THEN ? ELSE counted_from END
				WHERE subtype = 'apple_card'
				RETURNING id`,
			)
			.bind(
				today,
				balanceCents,
				balanceCents,
				balanceCents,
				today,
				balanceCents,
				today,
			),
	];

	const rowChunks = chunkRows(
		plan.add.map(({ row, key, twin, excluded }) => ({
			// planImport keeps only cleared rows, so the Clearing Date is set.
			date: row.clearingDate ?? row.transactionDate,
			amountCents: row.amountCents,
			description: row.description,
			merchant: row.merchant,
			category: row.category,
			excluded: excluded ? 1 : 0,
			key,
			twin,
		})),
	);
	// Rows are inserted by key and twin, so a row Tally holds (the same key, the same or a higher twin) is skipped. The
	// insert's own WHERE 1 keeps SQLite from reading ON CONFLICT as a join clause, as merchant-names.ts does.
	for (const chunk of rowChunks)
		statements.push(
			db
				.prepare(
					`INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, apple_category, pending,
						excluded, excluded_source, credit_reviewed, upload_key, upload_twin, updated_by)
					SELECT (SELECT id FROM accounts WHERE subtype = 'apple_card'),
						json_extract(value, '$.date'), json_extract(value, '$.amountCents'),
						json_extract(value, '$.description'), json_extract(value, '$.merchant'), json_extract(value, '$.category'), 0,
						json_extract(value, '$.excluded'),
						CASE WHEN json_extract(value, '$.excluded') = 1 THEN 'plaid' ELSE NULL END,
						CASE WHEN json_extract(value, '$.amountCents') < 0 THEN 0 ELSE 1 END,
						json_extract(value, '$.key'), json_extract(value, '$.twin'), ?
					FROM json_each(?) WHERE 1
					ON CONFLICT (account_id, upload_key, upload_twin) WHERE upload_key IS NOT NULL DO NOTHING
					RETURNING id`,
				)
				.bind(by, JSON.stringify(chunk)),
		);

	if (balanceCents !== null)
		statements.push(
			db
				.prepare(
					`INSERT INTO balance_history (account_id, date, balance_cents)
					SELECT id, ?, ? FROM accounts WHERE subtype = 'apple_card'
					ON CONFLICT(account_id, date) DO UPDATE SET balance_cents = excluded.balance_cents`,
				)
				.bind(today, balanceCents),
		);

	// Names are suggested in this same batch, never after the ids come back, so an upload is all or nothing.
	const names = [
		...new Set(
			plan.add.flatMap(({ row }) => {
				const name = suggestableName(row);
				return name ? [name] : [];
			}),
		),
	];
	if (names.length > 0)
		statements.push(
			db.prepare(suggestBankNamesSql("1")).bind(JSON.stringify(names)),
		);

	const results = await db.batch<{ id: number }>(statements);
	const accountId = results[1]?.results[0]?.id;
	if (accountId === undefined)
		throw new Error("The Apple Card account wasn't found after its upload");
	const addedIds = results
		.slice(2, 2 + rowChunks.length)
		.flatMap((result) => result.results.map((stored) => stored.id));
	const added = addedIds.length;
	return {
		ok: true,
		accountId,
		addedIds,
		added,
		already: plan.add.length - added,
		notCleared: plan.notCleared,
		beforeHistory: plan.beforeHistory,
		historyStart: start,
	};
}

// Home's Your banks list during a new family's first week (P140 A, decision 133, spec §8.8): one row per connected bank,
// with how far Tally has got with it. `readYourBanks` is one grouped query; `bankState` is pure over one row, so the
// precedence is tested without a database. The view (src/views/your-banks.tsx) draws the words.
import { bankFlag } from "../stale-bank";

/** One connected bank, as the list reads it: its sync marks, its stored transactions and whether it was linked in the hour. */
export type YourBank = {
	id: number;
	name: string;
	/** `plaid_items.status`: `ok` or `needs_attention`. */
	status: string;
	/** When its last sync finished, "YYYY-MM-DD HH:MM:SS" UTC, or null. */
	lastSyncedAt: string | null;
	/** When Plaid said its 90-day history was in, or null while it is still coming. */
	historyCompleteAt: string | null;
	/** Linked within the last hour, by D1's clock (`created_at`). */
	fresh: boolean;
	/** The transactions stored from this bank's accounts, split children left out. */
	count: number;
};

/**
 * A bank's state in the list, in precedence order: `in` once its history is in; `paused` when it needs signing in or
 * stopped updating (bankFlag); `being-read` while it is healthy, its history isn't in and it was linked within the hour
 * (the ring, and the list refreshes); `reading` once that hour is past, with no ring.
 */
export type BankState = "in" | "paused" | "being-read" | "reading";

export function bankState(bank: YourBank, today: string): BankState {
	if (bank.historyCompleteAt !== null) return "in";
	const flag = bankFlag(
		{
			id: bank.id,
			name: bank.name,
			needsAttention: bank.status === "needs_attention",
			lastSyncedAt: bank.lastSyncedAt,
		},
		today,
	);
	if (flag !== null) return "paused";
	return bank.fresh ? "being-read" : "reading";
}

/** The connected banks, in link order, with their counts. D1 returns the freshness flag as 0 or 1. */
export async function readYourBanks(db: D1Database): Promise<YourBank[]> {
	const { results } = await db
		.prepare(
			`SELECT p.id AS id, p.institution_name AS name, p.status AS status,
				p.last_synced_at AS lastSyncedAt, p.history_complete_at AS historyCompleteAt,
				p.created_at > datetime('now', '-1 hour') AS fresh, COUNT(t.id) AS count
			FROM plaid_items p
			LEFT JOIN accounts a ON a.plaid_item_id = p.id
			LEFT JOIN transactions t ON t.account_id = a.id AND t.plaid_transaction_id IS NOT NULL
			WHERE p.disconnected_at IS NULL
			GROUP BY p.id
			ORDER BY p.id`,
		)
		.all<Omit<YourBank, "fresh"> & { fresh: number }>();
	return results.map((row) => ({ ...row, fresh: row.fresh === 1 }));
}

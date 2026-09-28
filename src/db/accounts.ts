// The household's accounts, grouped by the bank they were linked from, as Accounts shows them (spec §5, §8).

export type Account = {
	id: number;
	name: string;
	mask: string | null;
	type: string;
	/** Plaid's current balance in cents; for debt, the amount owed. */
	balanceCents: number;
	isLiability: boolean;
	/** Disconnected accounts remain visible but no longer count toward net worth. */
	connected?: boolean;
};

export type Bank = {
	id: number;
	name: string;
	/** The bank's login needs fixing (`plaid_items.status = needs_attention`). */
	needsAttention: boolean;
	disconnected?: boolean;
	accounts: Account[];
};

type Row = {
	bank_id: number;
	bank_name: string;
	status: string;
	disconnected_at: string | null;
	/** The account's columns are null for a bank linked but not yet synced. */
	id: number | null;
	name: string | null;
	mask: string | null;
	type: string | null;
	balance_cents: number | null;
	is_liability: number | null;
};

/** What you have minus what you owe, in cents. */
export function netWorthCents(
	accounts: (Pick<Account, "balanceCents" | "isLiability"> &
		Partial<Pick<Account, "connected">>)[],
): number {
	return accounts.reduce(
		(sum, a) =>
			sum +
			(a.connected === false
				? 0
				: a.isLiability
					? -a.balanceCents
					: a.balanceCents),
		0,
	);
}

/**
 * Every linked bank, in the order it was linked, with its accounts in the order Plaid gave them. A bank
 * linked but not yet synced has no accounts and still appears, so it can be fixed if it needs attention.
 */
export async function accountsByBank(db: D1Database): Promise<Bank[]> {
	const { results } = await db
		.prepare(
			`SELECT p.id AS bank_id, p.institution_name AS bank_name, p.status, p.disconnected_at,
				a.id, a.name, a.mask, a.type, a.balance_cents, a.is_liability
			FROM plaid_items p LEFT JOIN accounts a ON a.plaid_item_id = p.id
			ORDER BY p.id, a.id`,
		)
		.all<Row>();
	const banks: Bank[] = [];
	for (const row of results) {
		let bank = banks.at(-1);
		if (bank?.id !== row.bank_id) {
			bank = {
				id: row.bank_id,
				name: row.bank_name,
				needsAttention: row.status === "needs_attention",
				...(row.disconnected_at !== null ? { disconnected: true } : {}),
				accounts: [],
			};
			banks.push(bank);
		}
		if (row.id === null) continue;
		bank.accounts.push({
			id: row.id,
			name: row.name ?? "",
			mask: row.mask,
			type: row.type ?? "",
			balanceCents: row.balance_cents ?? 0,
			isLiability: row.is_liability === 1,
			...(row.disconnected_at !== null ? { connected: false } : {}),
		});
	}
	return banks;
}

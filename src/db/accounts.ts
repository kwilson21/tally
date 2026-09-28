// The household's accounts, grouped by the bank they were linked from, as Accounts shows them (spec §5, §8).

export type Account = {
	id: number;
	name: string;
	mask: string | null;
	type: string;
	/** Plaid's current balance in cents; for debt, the amount owed. */
	balanceCents: number;
	isLiability: boolean;
};

export type Bank = {
	id: number;
	name: string;
	/** The bank's login needs fixing (`plaid_items.status = needs_attention`). */
	needsAttention: boolean;
	accounts: Account[];
};

type Row = {
	bank_id: number;
	bank_name: string;
	status: string;
	id: number;
	name: string;
	mask: string | null;
	type: string;
	balance_cents: number;
	is_liability: number;
};

/** What you have minus what you owe, in cents. */
export function netWorthCents(
	accounts: Pick<Account, "balanceCents" | "isLiability">[],
): number {
	return accounts.reduce(
		(sum, a) => sum + (a.isLiability ? -a.balanceCents : a.balanceCents),
		0,
	);
}

/** Every linked bank that has accounts, in the order it was linked, with its accounts in the order Plaid gave them. */
export async function accountsByBank(db: D1Database): Promise<Bank[]> {
	const { results } = await db
		.prepare(
			`SELECT p.id AS bank_id, p.institution_name AS bank_name, p.status,
				a.id, a.name, a.mask, a.type, a.balance_cents, a.is_liability
			FROM accounts a JOIN plaid_items p ON p.id = a.plaid_item_id
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
				accounts: [],
			};
			banks.push(bank);
		}
		bank.accounts.push({
			id: row.id,
			name: row.name,
			mask: row.mask,
			type: row.type,
			balanceCents: row.balance_cents,
			isLiability: row.is_liability === 1,
		});
	}
	return banks;
}

// The household's accounts, grouped by the bank they were linked from, as Accounts shows them (spec §5, §8).
import type { BankSync } from "../stale-bank";

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
	lastSyncedAt: string | null;
	disconnected?: boolean;
	accounts: Account[];
};

/** One row of `banksStatement`. */
export type BankRow = {
	bank_id: number;
	bank_name: string;
	status: string;
	last_synced_at: string | null;
	disconnected_at: string | null;
	/** The account's columns are null for a bank linked but not yet synced. */
	id: number | null;
	name: string | null;
	mask: string | null;
	type: string | null;
	balance_cents: number | null;
	is_liability: number | null;
};

/** What names an account in Transactions' Account choice and its count. */
type LabelInput = {
	name: string;
	mask: string | null;
	type: string;
	subtype: string | null;
	/** The bank it was linked from; null for the Cash account. */
	bank: string | null;
};

/** An account's name as the lists name it: "Chase Card ••9921", or just the name when the bank gives no digits. The Cash account reads "Cash". */
function baseLabel(account: LabelInput): string {
	if (account.type === "cash") return "Cash";
	return account.mask ? `${account.name} ••${account.mask}` : account.name;
}

/**
 * One label per account, no two alike, so the choice and the count always say which account. Accounts
 * that share a label get the bank's name ("Checking ••1234 (Chase)"); those still alike get what kind
 * of account it is ("(Chase, credit card)"); any still alike are numbered, the first keeping its label
 * ("... (2)"). Only accounts that share a label are changed, one step at a time.
 */
export function uniqueAccountLabels(accounts: LabelInput[]): string[] {
	const bases = accounts.map(baseLabel);
	// What each account's label becomes at each step; an account with no bank has nothing to add.
	const steps: ((a: LabelInput, base: string) => string)[] = [
		(a, base) => (a.bank ? `${base} (${a.bank})` : base),
		(a, base) =>
			a.bank ? `${base} (${a.bank}, ${a.subtype ?? a.type})` : base,
	];
	let labels = bases;
	for (const step of steps) {
		const current = labels;
		labels = current.map((label, i) =>
			current.some((other, j) => j !== i && other === label)
				? step(accounts[i] as LabelInput, bases[i] as string)
				: label,
		);
	}
	// Still alike: number every one after the first, skipping a number another account already wears.
	const used = new Set(labels);
	const seen = new Set<string>();
	return labels.map((label) => {
		if (!seen.has(label)) {
			seen.add(label);
			return label;
		}
		let n = 2;
		while (used.has(`${label} (${n})`)) n++;
		const numbered = `${label} (${n})`;
		used.add(numbered);
		seen.add(numbered);
		return numbered;
	});
}

/** One entry of Transactions' Account choice. */
export type AccountChoice = {
	id: number;
	label: string;
	/** Its bank was disconnected: the account and its transactions stay (spec §8.1). */
	disconnected: boolean;
};

/**
 * Every account, in the order its bank was linked and Cash last, for Transactions' Account choice. A
 * disconnected bank's accounts are included and marked, since their transactions stay.
 */
export async function accountChoices(db: D1Database): Promise<AccountChoice[]> {
	const { results } = await db
		.prepare(
			`SELECT a.id, a.name, a.mask, a.type, a.subtype, p.institution_name AS bank, p.disconnected_at
			FROM accounts a LEFT JOIN plaid_items p ON p.id = a.plaid_item_id
			ORDER BY a.type = 'cash', a.plaid_item_id, a.id`,
		)
		.all<{
			id: number;
			name: string;
			mask: string | null;
			type: string;
			subtype: string | null;
			bank: string | null;
			disconnected_at: string | null;
		}>();
	const labels = uniqueAccountLabels(results);
	return results.map((a, i) => ({
		id: a.id,
		label: labels[i] as string,
		disconnected: a.disconnected_at !== null,
	}));
}

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
 * Every linked bank's status and last sync, in the order it was linked, for Home's stale-bank line
 * (spec §8.5). It reads `plaid_items` alone, so Home needn't load accounts to ask.
 */
export async function bankSyncs(db: D1Database): Promise<BankSync[]> {
	const { results } = await db
		.prepare(
			"SELECT institution_name, status, last_synced_at, disconnected_at FROM plaid_items ORDER BY id",
		)
		.all<{
			institution_name: string;
			status: string;
			last_synced_at: string | null;
			disconnected_at: string | null;
		}>();
	return results.map((row) => ({
		name: row.institution_name,
		needsAttention: row.status === "needs_attention",
		lastSyncedAt: row.last_synced_at,
		disconnected: row.disconnected_at !== null,
	}));
}

/**
 * Every linked bank, in the order it was linked, with its accounts in the order Plaid gave them. A bank
 * linked but not yet synced has no accounts and still appears, so it can be fixed if it needs attention.
 */
export async function accountsByBank(db: D1Database): Promise<Bank[]> {
	const { results } = await banksStatement(db).all<BankRow>();
	return banksFromRows(results);
}

/**
 * The query behind `accountsByBank`, unrun, so a page can read it in the same `db.batch` as other
 * reads that must agree with it (Accounts' headline and its net-worth line); batch results go to
 * `banksFromRows`.
 */
export function banksStatement(db: D1Database): D1PreparedStatement {
	return db.prepare(
		`SELECT p.id AS bank_id, p.institution_name AS bank_name, p.status, p.last_synced_at, p.disconnected_at,
			a.id, a.name, a.mask, a.type, a.balance_cents, a.is_liability
		FROM plaid_items p LEFT JOIN accounts a ON a.plaid_item_id = p.id
		ORDER BY p.id, a.id`,
	);
}

/** The banks `banksStatement` read, with their accounts. */
export function banksFromRows(results: BankRow[]): Bank[] {
	const banks: Bank[] = [];
	for (const row of results) {
		let bank = banks.at(-1);
		if (bank?.id !== row.bank_id) {
			bank = {
				id: row.bank_id,
				name: row.bank_name,
				needsAttention: row.status === "needs_attention",
				lastSyncedAt: row.last_synced_at,
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

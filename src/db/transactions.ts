import type { JevInput } from "../ai/categorize";
import type { Decision } from "../ai/decide";
import type { ExcludedBreakdown } from "../how-it-works/examples";
import type { Edit } from "../transactions/edit";
import { type Filters, likePattern } from "../transactions/filters";
import type { SplitPart } from "../transactions/split";
import { tidyName } from "../transactions/tidy-name";

export type ListRow = {
	id: number;
	date: string;
	amountCents: number;
	rawName: string;
	displayName: string;
	note: string | null;
	excluded: boolean;
	income: boolean;
	categoryId: number | null;
	categoryName: string | null;
	categoryIcon: string | null;
	categoryColor: string | null;
	parentId?: number | null;
	parentName?: string | null;
	isSplit?: boolean;
	splitRemovedFromCents?: number | null;
};

export const PAGE_SIZE = 25;

// "Needs category" is the same set Home counts as uncategorized (spec §6): counted, not income, no category.
const NEEDS_CATEGORY =
	"t.category_id IS NULL AND t.excluded = 0 AND t.is_split = 0 AND t.flag_income = 0";

/** One page of transactions matching the filters, newest first. A page past the end shows the last page. */
export async function listTransactions(
	db: D1Database,
	f: Filters,
): Promise<{ rows: ListRow[]; total: number; page: number; pages: number }> {
	const where: string[] = [];
	const args: (string | number)[] = [];
	if (f.month !== "all") {
		where.push("substr(t.date, 1, 7) = ?");
		args.push(f.month);
	}
	if (f.category !== null) {
		where.push("t.category_id = ?");
		where.push("t.is_split = 0");
		args.push(f.category);
	}
	if (f.uncategorized) where.push(NEEDS_CATEGORY);
	if (f.excluded) where.push("t.excluded = 1");
	if (f.q) {
		// The raw text also matches with each * read as a space, as its tidied name shows it (#93):
		// "google youtube" finds "GOOGLE *YOUTUBE".
		where.push(
			"(COALESCE(m.display_name, t.raw_name) LIKE ? ESCAPE '\\' OR t.raw_name LIKE ? ESCAPE '\\' OR REPLACE(REPLACE(REPLACE(t.raw_name, '*', ' '), '  ', ' '), '  ', ' ') LIKE ? ESCAPE '\\' OR COALESCE(t.note, '') LIKE ? ESCAPE '\\')",
		);
		const pattern = likePattern(f.q);
		args.push(pattern, pattern, pattern, pattern);
	}

	const from = `FROM transactions t
			LEFT JOIN merchants m ON m.raw_name = t.raw_name
			LEFT JOIN categories c ON c.id = t.category_id
			LEFT JOIN transactions p ON p.id = t.parent_id
			LEFT JOIN merchants pm ON pm.raw_name = p.raw_name
			${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}`;

	const counted = await db
		.prepare(`SELECT COUNT(*) AS n ${from}`)
		.bind(...args)
		.first<{ n: number }>();
	const total = counted?.n ?? 0;
	const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const page = Math.min(f.page, pages);

	const { results } = await db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, t.raw_name AS rawName,
				m.display_name AS merchantName, t.note, t.parent_id AS parentId,
				t.is_split AS isSplit, pm.display_name AS parentMerchantName, p.raw_name AS parentRawName,
				t.split_removed_from_cents AS splitRemovedFromCents,
				t.excluded, t.flag_income AS income,
				c.id AS categoryId, c.name AS categoryName, c.icon AS categoryIcon, c.color AS categoryColor
			${from}
			ORDER BY t.date DESC, t.id DESC
			LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
		)
		.bind(...args)
		.all<
			Omit<ListRow, "excluded" | "income" | "displayName" | "isSplit"> & {
				merchantName: string | null;
				parentMerchantName: string | null;
				parentRawName: string | null;
				excluded: number;
				income: number;
				isSplit: number;
			}
		>();

	// A person's chosen name wins; until then the bank's raw text is tidied for display (spec §7).
	const rows = results.map(
		({ merchantName, parentMerchantName, parentRawName, ...r }) => ({
			...r,
			parentName: parentRawName
				? (parentMerchantName ?? tidyName(parentRawName))
				: null,
			excluded: r.excluded === 1,
			income: r.income === 1,
			isSplit: r.isSplit === 1,
			displayName: merchantName ?? tidyName(r.rawName),
		}),
	);
	return { rows, total, page, pages };
}

/** How many transactions need a category in a month ('YYYY-MM' or 'all'): the chip and Home's band. */
export async function needsCategoryCount(
	db: D1Database,
	month: string,
): Promise<number> {
	const inMonth = month === "all" ? "" : "substr(t.date, 1, 7) = ? AND ";
	const statement = db.prepare(
		`SELECT COUNT(*) AS n FROM transactions t WHERE ${inMonth}${NEEDS_CATEGORY}`,
	);
	const row = await (month === "all"
		? statement
		: statement.bind(month)
	).first<{
		n: number;
	}>();
	return row?.n ?? 0;
}

/** Months that have transactions, newest first, for the month filter. */
export async function monthsWithTransactions(
	db: D1Database,
): Promise<string[]> {
	const { results } = await db
		.prepare(
			"SELECT DISTINCT substr(date, 1, 7) AS month FROM transactions ORDER BY month DESC",
		)
		.all<{ month: string }>();
	return results.map((r) => r.month);
}

export type TransactionDetail = ListRow & {
	accountName: string;
	accountMask: string | null;
	/** The merchant's chosen display name, or null when it falls back to the raw name. */
	merchantName: string | null;
	categorySource: "user" | "merchant_rule" | "jev" | null;
	/** Jev's confidence when Jev picked (or looked at) the category; null otherwise. */
	categoryConfidence: number | null;
};

/** One transaction with what the edit panel shows: account, merchant name, and category source. */
export async function getTransaction(
	db: D1Database,
	id: number,
): Promise<TransactionDetail | null> {
	const r = await db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, t.raw_name AS rawName,
				m.display_name AS merchantName, t.note, t.parent_id AS parentId,
				t.is_split AS isSplit, NULL AS parentName,
				t.split_removed_from_cents AS splitRemovedFromCents,
				t.excluded, t.flag_income AS income, t.category_source AS categorySource, t.category_confidence AS categoryConfidence,
				c.id AS categoryId, c.name AS categoryName, c.icon AS categoryIcon, c.color AS categoryColor,
				a.name AS accountName, a.mask AS accountMask
			FROM transactions t
			JOIN accounts a ON a.id = t.account_id
			LEFT JOIN merchants m ON m.raw_name = t.raw_name
			LEFT JOIN categories c ON c.id = t.category_id
			WHERE t.id = ?`,
		)
		.bind(id)
		.first<
			Omit<
				TransactionDetail,
				"excluded" | "income" | "displayName" | "isSplit"
			> & {
				excluded: number;
				income: number;
				isSplit: number;
			}
		>();
	// A person's chosen name wins; until then the bank's raw text is tidied for display (spec §7).
	return r
		? {
				...r,
				excluded: r.excluded === 1,
				income: r.income === 1,
				isSplit: r.isSplit === 1,
				displayName: r.merchantName ?? tidyName(r.rawName),
			}
		: null;
}

/** Sets `excluded`, recording a person as its source only when the value changes. */
const EXCLUDE =
	"excluded_source = CASE WHEN excluded = ? THEN excluded_source ELSE 'user' END, excluded = ?";

/**
 * Saves the edit panel in one atomic batch: the category (marked as a person's choice when it
 * changes), the note, whether it's excluded, the merchant's display name, and, if asked, the merchant rule, which also
 * recategorizes the merchant's other transactions except ones a person chose (spec §7).
 */
export async function saveEdit(
	db: D1Database,
	id: number,
	edit: Edit,
	actor: string,
): Promise<void> {
	const current = await db
		.prepare(
			"SELECT raw_name AS rawName, category_id AS categoryId, excluded FROM transactions WHERE id = ?",
		)
		.bind(id)
		.first<{ rawName: string; categoryId: number | null; excluded: number }>();
	if (!current) throw new Error(`No transaction ${id}`);

	const changed =
		edit.categoryId !== null && edit.categoryId !== current.categoryId;
	// Changing the exclusion makes it a person's choice, which Jev never overrides.
	const excluded = edit.excluded ? 1 : 0;
	const excludeArgs = [excluded, excluded];

	const statements = [
		changed
			? db
					.prepare(
						`UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL, split_removed_from_cents = NULL,
							note = ?, ${EXCLUDE}, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
					)
					.bind(edit.categoryId, edit.note, ...excludeArgs, actor, id)
			: db
					.prepare(
						`UPDATE transactions SET note = ?, ${edit.categoryId !== null ? "split_removed_from_cents = NULL," : ""} ${EXCLUDE}, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
					)
					.bind(edit.note, ...excludeArgs, actor, id),
		db
			.prepare(
				`INSERT INTO merchants (raw_name, display_name) VALUES (?, ?)
				ON CONFLICT(raw_name) DO UPDATE SET display_name = excluded.display_name`,
			)
			.bind(current.rawName, edit.displayName),
	];
	// A split is one bank transaction: excluding any part of it excludes the purchase and
	// all its parts. Child audit fields change only when the choice does.
	if (excluded !== current.excluded)
		statements.push(
			db
				.prepare(
					`UPDATE transactions SET excluded = ?1, excluded_source = 'user', updated_by = ?2, updated_at = datetime('now')
					WHERE id != ?3 AND (
						parent_id = ?3
						OR id = (SELECT parent_id FROM transactions WHERE id = ?3)
						OR parent_id = (SELECT parent_id FROM transactions WHERE id = ?3)
					)`,
				)
				.bind(excluded, actor, id),
		);
	if (edit.alwaysForMerchant && edit.categoryId !== null) {
		statements.push(
			db
				.prepare(
					"UPDATE merchants SET default_category_id = ? WHERE raw_name = ?",
				)
				.bind(edit.categoryId, current.rawName),
			db
				.prepare(
					`UPDATE transactions SET category_id = ?, category_source = 'merchant_rule', category_confidence = NULL, split_removed_from_cents = NULL,
						updated_by = ?, updated_at = datetime('now')
					WHERE raw_name = ? AND id != ? AND COALESCE(category_source, '') != 'user'`,
				)
				.bind(edit.categoryId, actor, current.rawName, id),
		);
	}
	await db.batch(statements);
}

/** Creates every child and marks its parent in one D1 batch. */
export async function saveSplit(
	db: D1Database,
	parentId: number,
	parts: SplitPart[],
	by: string,
) {
	const parent = await db
		.prepare(
			"SELECT account_id AS accountId, date, raw_name AS rawName, excluded FROM transactions WHERE id = ? AND parent_id IS NULL",
		)
		.bind(parentId)
		.first<{
			accountId: number;
			date: string;
			rawName: string;
			excluded: number;
		}>();
	if (!parent) throw new Error(`No transaction ${parentId}`);
	// Every write checks, inside the same batch, that the parent still has the amount
	// the parts were validated against, so a bank correction mid-save writes nothing.
	const total = parts.reduce((sum, part) => sum + part.amountCents, 0);
	const unchanged =
		"EXISTS (SELECT 1 FROM transactions WHERE id = ? AND amount_cents = ?)";
	const results = await db.batch([
		db
			.prepare(`DELETE FROM transactions WHERE parent_id = ? AND ${unchanged}`)
			.bind(parentId, parentId, total),
		...parts.map((part) =>
			db
				.prepare(`INSERT INTO transactions
			(account_id, date, amount_cents, raw_name, category_id, category_source, excluded, parent_id, plaid_transaction_id, updated_by)
			SELECT ?, ?, ?, ?, ?, 'user', ?, ?, NULL, ? WHERE ${unchanged}`)
				.bind(
					parent.accountId,
					parent.date,
					part.amountCents,
					parent.rawName,
					part.categoryId,
					parent.excluded,
					parentId,
					by,
					parentId,
					total,
				),
		),
		db
			.prepare(
				"UPDATE transactions SET is_split = 1, split_removed_from_cents = NULL, updated_by = ?, updated_at = datetime('now') WHERE id = ? AND amount_cents = ?",
			)
			.bind(by, parentId, total),
	]);
	return (results.at(-1)?.meta.changes ?? 0) > 0;
}

/** Deletes a split and restores its parent atomically. */
export async function removeSplit(
	db: D1Database,
	parentId: number,
	by: string,
) {
	// TODO(#134 refunds): unlink refunds when refund_of_id is added.
	await db.batch([
		db.prepare("DELETE FROM transactions WHERE parent_id = ?").bind(parentId),
		db
			.prepare(
				"UPDATE transactions SET is_split = 0, updated_by = ?, updated_at = datetime('now') WHERE id = ?",
			)
			.bind(by, parentId),
	]);
}

/**
 * Applies merchant rules to transactions nobody has categorized yet (spec §7: a merchant rule
 * comes before Jev). A person's choice, or a category from anywhere else, is never touched.
 * A rule whose category is archived is skipped, and works again once the category is restored.
 */
export async function applyMerchantRules(db: D1Database): Promise<void> {
	const rule = `SELECT m.default_category_id FROM merchants m
		JOIN categories c ON c.id = m.default_category_id AND c.archived = 0
		WHERE m.raw_name = transactions.raw_name`;
	await db
		.prepare(
			`UPDATE transactions SET
				category_id = (${rule}),
				category_source = 'merchant_rule', category_confidence = NULL, updated_at = datetime('now')
			WHERE category_id IS NULL AND category_source IS NULL AND EXISTS (${rule})`,
		)
		.run();
}

/**
 * Transactions to ask Jev about, newest first: the ones that need a category (the same set
 * Home counts), with no category source and no stored confidence. A stored confidence means
 * Jev already looked and wasn't sure (decision 27).
 */
export async function pendingForJev(
	db: D1Database,
	limit: number,
): Promise<(JevInput & { id: number })[]> {
	const { results } = await db
		.prepare(
			`SELECT t.id, t.raw_name AS rawName, m.display_name AS displayName,
				t.amount_cents AS amountCents, a.type AS accountType,
				t.plaid_category AS plaidCategory
			FROM transactions t
			JOIN accounts a ON a.id = t.account_id
			LEFT JOIN merchants m ON m.raw_name = t.raw_name
			WHERE ${NEEDS_CATEGORY} AND t.category_source IS NULL AND t.category_confidence IS NULL
			-- Never-failed first, then longest-ago failures, so a failing one can't block the rest.
			ORDER BY t.jev_failed_at IS NOT NULL, t.jev_failed_at, t.date DESC, t.id DESC
			LIMIT ?`,
		)
		.bind(limit)
		.all<JevInput & { id: number }>();
	return results;
}

/** Records that Jev failed on this one transaction, so the next run asks about it last (decision 31). */
export async function markJevFailed(db: D1Database, id: number): Promise<void> {
	await db
		.prepare(
			"UPDATE transactions SET jev_failed_at = datetime('now') WHERE id = ?",
		)
		.bind(id)
		.run();
}

/**
 * Stores what code decided from Jev's answer. It only writes to a transaction that is still
 * uncategorized with no source, so a person's choice made in the meantime always wins.
 * A transfer or reimbursement flag also excludes the transaction (spec §6), which a person can undo
 * with the edit panel's exclude toggle (#27); it never overrides a person's exclusion choice. Jev's income answer isn't stored: it changes the budget
 * math, and the edit panel has no income control (decision 28). Returns whether it wrote the row.
 */
export async function saveJevResult(
	db: D1Database,
	id: number,
	d: Decision,
): Promise<boolean> {
	// A transfer or reimbursement flag excludes the transaction, unless a person decided otherwise.
	const excludes = d.flags.transfer || d.flags.reimbursement ? 1 : 0;
	const result = await db
		.prepare(
			`UPDATE transactions SET
				category_id = ?, category_source = ?, category_confidence = ?, jev_category_id = ?,
				flag_transfer = MAX(flag_transfer, ?), flag_reimbursement = MAX(flag_reimbursement, ?),
				excluded = CASE WHEN excluded_source = 'user' THEN excluded ELSE MAX(excluded, ?) END,
				excluded_source = CASE WHEN excluded_source = 'user' OR ? = 0 THEN excluded_source ELSE 'jev' END,
				updated_at = datetime('now')
			WHERE id = ? AND category_id IS NULL AND category_source IS NULL`,
		)
		.bind(
			d.categoryId,
			d.categoryId === null ? null : "jev",
			d.confidence,
			d.suggestedCategoryId,
			d.flags.transfer ? 1 : 0,
			d.flags.reimbursement ? 1 : 0,
			excludes,
			excludes,
			id,
		)
		.run();
	return result.meta.changes > 0;
}

/** How many of a month's transactions are excluded (split parents aside), for How Tally works. */
/**
 * This month's excluded transactions by why (How Tally works, spec §9): a person's choice when a
 * person excluded it (even if it's also flagged) or it has no flag; otherwise its flag, transfer
 * first.
 */
export async function excludedBreakdown(
	db: D1Database,
	month: string,
): Promise<ExcludedBreakdown> {
	const row = await db
		.prepare(
			`SELECT COALESCE(SUM(NOT person AND flag_transfer = 1), 0) AS transfer,
				COALESCE(SUM(NOT person AND flag_transfer = 0 AND flag_reimbursement = 1), 0) AS reimbursement,
				COALESCE(SUM(person OR (flag_transfer = 0 AND flag_reimbursement = 0)), 0) AS byPerson
			FROM (SELECT *, COALESCE(excluded_source = 'user', 0) AS person FROM transactions) WHERE substr(date, 1, 7) = ? AND excluded = 1 AND is_split = 0`,
		)
		.bind(month)
		.first<ExcludedBreakdown>();
	return row ?? { transfer: 0, reimbursement: 0, byPerson: 0 };
}

/**
 * This month's numbers for the How Tally works page (spec §9): counted transactions, how many
 * need a category (the same set Home counts), and who categorized the rest.
 */
export async function monthCounts(
	db: D1Database,
	month: string,
): Promise<{
	counted: number;
	needsCategory: number;
	user: number;
	merchantRule: number;
	jev: number;
	unsure: number;
	noneFit: number;
	notYetAsked: number;
	/** Income with no category: it needs none, so it isn't waiting. */
	income: number;
}> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS counted,
				COALESCE(SUM(CASE WHEN ${NEEDS_CATEGORY} THEN 1 ELSE 0 END), 0) AS needsCategory,
				COALESCE(SUM(t.category_source = 'user'), 0) AS user,
				COALESCE(SUM(t.category_source = 'merchant_rule'), 0) AS merchantRule,
				COALESCE(SUM(t.category_source = 'jev'), 0) AS jev,
				COALESCE(SUM(${NEEDS_CATEGORY} AND t.category_source IS NULL AND t.category_confidence IS NOT NULL AND t.jev_category_id IS NOT NULL), 0) AS unsure,
				COALESCE(SUM(${NEEDS_CATEGORY} AND t.category_source IS NULL AND t.category_confidence IS NOT NULL AND t.jev_category_id IS NULL), 0) AS noneFit,
				COALESCE(SUM(${NEEDS_CATEGORY} AND t.category_source IS NULL AND t.category_confidence IS NULL), 0) AS notYetAsked,
				COALESCE(SUM(t.category_id IS NULL AND t.flag_income = 1), 0) AS income
			FROM transactions t
			WHERE substr(t.date, 1, 7) = ? AND t.excluded = 0 AND t.is_split = 0`,
		)
		.bind(month)
		.first<{
			counted: number;
			needsCategory: number;
			user: number;
			merchantRule: number;
			jev: number;
			unsure: number;
			noneFit: number;
			notYetAsked: number;
			income: number;
		}>();
	return (
		row ?? {
			counted: 0,
			needsCategory: 0,
			user: 0,
			merchantRule: 0,
			jev: 0,
			unsure: 0,
			noneFit: 0,
			notYetAsked: 0,
			income: 0,
		}
	);
}

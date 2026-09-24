import type { Edit } from "../transactions/edit";
import { type Filters, likePattern } from "../transactions/filters";

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
		args.push(f.category);
	}
	if (f.uncategorized) where.push(NEEDS_CATEGORY);
	if (f.excluded) where.push("t.excluded = 1");
	if (f.q) {
		where.push(
			"(COALESCE(m.display_name, t.raw_name) LIKE ? ESCAPE '\\' OR t.raw_name LIKE ? ESCAPE '\\' OR COALESCE(t.note, '') LIKE ? ESCAPE '\\')",
		);
		const pattern = likePattern(f.q);
		args.push(pattern, pattern, pattern);
	}

	const from = `FROM transactions t
			LEFT JOIN merchants m ON m.raw_name = t.raw_name
			LEFT JOIN categories c ON c.id = t.category_id
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
				COALESCE(m.display_name, t.raw_name) AS displayName, t.note,
				t.excluded, t.flag_income AS income,
				c.id AS categoryId, c.name AS categoryName, c.icon AS categoryIcon, c.color AS categoryColor
			${from}
			ORDER BY t.date DESC, t.id DESC
			LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
		)
		.bind(...args)
		.all<
			Omit<ListRow, "excluded" | "income"> & {
				excluded: number;
				income: number;
			}
		>();

	const rows = results.map((r) => ({
		...r,
		excluded: r.excluded === 1,
		income: r.income === 1,
	}));
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
};

/** One transaction with what the edit panel shows: account, merchant name, and category source. */
export async function getTransaction(
	db: D1Database,
	id: number,
): Promise<TransactionDetail | null> {
	const r = await db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, t.raw_name AS rawName,
				COALESCE(m.display_name, t.raw_name) AS displayName, m.display_name AS merchantName, t.note,
				t.excluded, t.flag_income AS income, t.category_source AS categorySource,
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
			Omit<TransactionDetail, "excluded" | "income"> & {
				excluded: number;
				income: number;
			}
		>();
	return r
		? { ...r, excluded: r.excluded === 1, income: r.income === 1 }
		: null;
}

/**
 * Saves the edit panel in one atomic batch: the category (marked as a person's choice when it
 * changes), the note, the merchant's display name, and, if asked, the merchant rule, which also
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
			"SELECT raw_name AS rawName, category_id AS categoryId FROM transactions WHERE id = ?",
		)
		.bind(id)
		.first<{ rawName: string; categoryId: number | null }>();
	if (!current) throw new Error(`No transaction ${id}`);

	const changed =
		edit.categoryId !== null && edit.categoryId !== current.categoryId;
	const statements = [
		changed
			? db
					.prepare(
						`UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL,
							note = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
					)
					.bind(edit.categoryId, edit.note, actor, id)
			: db
					.prepare(
						"UPDATE transactions SET note = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?",
					)
					.bind(edit.note, actor, id),
		db
			.prepare(
				`INSERT INTO merchants (raw_name, display_name) VALUES (?, ?)
				ON CONFLICT(raw_name) DO UPDATE SET display_name = excluded.display_name`,
			)
			.bind(current.rawName, edit.displayName),
	];
	if (edit.alwaysForMerchant && edit.categoryId !== null) {
		statements.push(
			db
				.prepare(
					"UPDATE merchants SET default_category_id = ? WHERE raw_name = ?",
				)
				.bind(edit.categoryId, current.rawName),
			db
				.prepare(
					`UPDATE transactions SET category_id = ?, category_source = 'merchant_rule', category_confidence = NULL,
						updated_by = ?, updated_at = datetime('now')
					WHERE raw_name = ? AND id != ? AND COALESCE(category_source, '') != 'user'`,
				)
				.bind(edit.categoryId, actor, current.rawName, id),
		);
	}
	await db.batch(statements);
}

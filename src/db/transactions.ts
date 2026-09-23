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

export const LIST_LIMIT = 200;

// "Needs category" is the same set Home counts as uncategorized (spec §6): counted, not income, no category.
const NEEDS_CATEGORY =
	"t.category_id IS NULL AND t.excluded = 0 AND t.is_split = 0 AND t.flag_income = 0";

/** Transactions matching the filters, newest first, capped at LIST_LIMIT; `more` says rows were left out. */
export async function listTransactions(
	db: D1Database,
	f: Filters,
): Promise<{ rows: ListRow[]; more: boolean }> {
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

	const { results } = await db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, t.raw_name AS rawName,
				COALESCE(m.display_name, t.raw_name) AS displayName, t.note,
				t.excluded, t.flag_income AS income,
				c.id AS categoryId, c.name AS categoryName, c.icon AS categoryIcon, c.color AS categoryColor
			FROM transactions t
			LEFT JOIN merchants m ON m.raw_name = t.raw_name
			LEFT JOIN categories c ON c.id = t.category_id
			${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
			ORDER BY t.date DESC, t.id DESC
			LIMIT ${LIST_LIMIT + 1}`,
		)
		.bind(...args)
		.all<
			Omit<ListRow, "excluded" | "income"> & {
				excluded: number;
				income: number;
			}
		>();

	const rows = results
		.slice(0, LIST_LIMIT)
		.map((r) => ({ ...r, excluded: r.excluded === 1, income: r.income === 1 }));
	return { rows, more: results.length > LIST_LIMIT };
}

/** How many of a month's transactions need a category (the chip and Home's band). */
export async function needsCategoryCount(
	db: D1Database,
	month: string,
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM transactions t WHERE substr(t.date, 1, 7) = ? AND ${NEEDS_CATEGORY}`,
		)
		.bind(month)
		.first<{ n: number }>();
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

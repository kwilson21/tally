// The household's categories and budget amounts, as Settings shows and changes them (spec §5, §7, §8).
import { budgetForMonth } from "../budget";
import type { CategoryValue } from "../settings/category-form";

export type SettingsCategory = {
	id: number;
	name: string;
	icon: string;
	color: string;
	/** This month's budget, or null for none (spec §6). */
	budgetCents: number | null;
};

/** New categories take the next color in turn, so neighbors differ. */
const COLORS = ["cat-blue", "cat-plum", "cat-slate", "cat-ochre", "cat-brown"];

type Row = {
	id: number;
	name: string;
	icon: string;
	color: string;
	archived: number;
};

/** Active categories in order with this month's budget, and archived ones apart. */
export async function settingsCategories(
	db: D1Database,
	month: string,
): Promise<{ active: SettingsCategory[]; archived: SettingsCategory[] }> {
	const [categories, amounts] = (await db.batch([
		db.prepare(
			"SELECT id, name, icon, color, archived FROM categories ORDER BY sort_order, name",
		),
		db.prepare(
			"SELECT category_id AS categoryId, effective_month AS effectiveMonth, amount_cents AS amountCents FROM budget_amounts",
		),
	])) as [
		D1Result<Row>,
		D1Result<Parameters<typeof budgetForMonth>[0][number]>,
	];
	const withBudget = ({ archived: _, ...c }: Row): SettingsCategory => ({
		...c,
		budgetCents: budgetForMonth(amounts.results, c.id, month),
	});
	return {
		active: categories.results.filter((c) => !c.archived).map(withBudget),
		archived: categories.results.filter((c) => c.archived).map(withBudget),
	};
}

/** Every category's name, archived ones too, for the form's checks. */
export async function categoryNames(
	db: D1Database,
): Promise<{ id: number; name: string; archived: boolean }[]> {
	const { results } = await db
		.prepare("SELECT id, name, archived FROM categories")
		.all<{ id: number; name: string; archived: number }>();
	return results.map((c) => ({ ...c, archived: c.archived === 1 }));
}

/** Sets a category's budget from `month` on, replacing one already set for that month. */
const setBudget = (
	db: D1Database,
	categoryId: number | null,
	name: string,
	cents: number,
	month: string,
) =>
	db
		.prepare(
			`INSERT INTO budget_amounts (category_id, effective_month, amount_cents)
			VALUES (COALESCE(?, (SELECT id FROM categories WHERE name = ?)), ?, ?)
			ON CONFLICT (category_id, effective_month) DO UPDATE SET amount_cents = excluded.amount_cents`,
		)
		.bind(categoryId, name, month, cents);

/** Adds a category at the end of the list, with the tag icon, the next color, and its budget if given. */
export async function addCategory(
	db: D1Database,
	value: CategoryValue,
	month: string,
): Promise<number> {
	const count = await db
		.prepare(
			"SELECT COUNT(*) AS n, COALESCE(MAX(sort_order), 0) AS last FROM categories",
		)
		.first<{ n: number; last: number }>();
	const statements = [
		db
			.prepare(
				"INSERT INTO categories (name, icon, color, sort_order) VALUES (?, 'tag', ?, ?)",
			)
			.bind(
				value.name,
				COLORS[(count?.n ?? 0) % COLORS.length],
				(count?.last ?? 0) + 1,
			),
	];
	if (value.budgetCents !== null)
		statements.push(setBudget(db, null, value.name, value.budgetCents, month));
	const [inserted] = await db.batch(statements);
	return Number(inserted?.meta.last_row_id);
}

/** Renames a category and, if given, sets its budget from `month` on, in one atomic batch. */
export async function saveCategory(
	db: D1Database,
	id: number,
	value: CategoryValue,
	month: string,
): Promise<void> {
	const statements = [
		db
			.prepare("UPDATE categories SET name = ? WHERE id = ?")
			.bind(value.name, id),
	];
	if (value.budgetCents !== null)
		statements.push(setBudget(db, id, value.name, value.budgetCents, month));
	await db.batch(statements);
}

/**
 * Archives or restores a category. Nothing is deleted, so every pick and source stays meaningful
 * (spec §7). A restored category goes to the end of the list, so it never shares a place.
 */
export async function setArchived(
	db: D1Database,
	id: number,
	archived: boolean,
): Promise<void> {
	await db
		.prepare(
			archived
				? "UPDATE categories SET archived = 1 WHERE id = ?"
				: `UPDATE categories SET archived = 0,
					sort_order = (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories WHERE archived = 0)
				WHERE id = ?`,
		)
		.bind(id)
		.run();
}

/** Moves an active category one place up or down; the list is renumbered 1, 2, 3… as it goes. */
export async function moveCategory(
	db: D1Database,
	id: number,
	direction: "up" | "down",
): Promise<void> {
	const { results } = await db
		.prepare(
			"SELECT id FROM categories WHERE archived = 0 ORDER BY sort_order, name",
		)
		.all<{ id: number }>();
	const order = results.map((c) => c.id);
	const from = order.indexOf(id);
	const to = direction === "up" ? from - 1 : from + 1;
	if (from === -1 || to < 0 || to >= order.length) return;
	[order[from], order[to]] = [order[to] as number, order[from] as number];
	await db.batch(
		order.map((categoryId, i) =>
			db
				.prepare("UPDATE categories SET sort_order = ? WHERE id = ?")
				.bind(i + 1, categoryId),
		),
	);
}

// The household's categories, as Settings shows and changes them (spec §5, §7, §8). Budgets: db/budgets.ts.
import { asc, count, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { budgetForMonth } from "../budget";
import {
	type CategoryValue,
	COLORS,
	fullMessage,
	MAX_ACTIVE,
	nameKey,
	sameName,
} from "../settings/category-form";
import { isUniqueViolation } from "./errors";
import { budgetAmounts, categories } from "./schema";

export { COLORS };

export type SettingsCategory = {
	id: number;
	name: string;
	icon: string;
	color: string;
	/** This month's budget, or null for none (spec §6). */
	budgetCents: number | null;
};

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
	const orm = drizzle(db);

	// orm.batch returns one array per query, in the order listed: the categories first, then every budget amount.
	const [rows, amounts] = await orm.batch([
		orm
			.select({
				id: categories.id,
				name: categories.name,
				icon: categories.icon,
				color: categories.color,
				archived: categories.archived,
			})
			.from(categories)
			.orderBy(asc(categories.sortOrder), asc(categories.name)),
		orm
			.select({
				categoryId: budgetAmounts.categoryId,
				effectiveMonth: budgetAmounts.effectiveMonth,
				amountCents: budgetAmounts.amountCents,
			})
			.from(budgetAmounts),
	]);

	const withBudget = ({ archived: _, ...c }: Row): SettingsCategory => ({
		...c,
		budgetCents: budgetForMonth(amounts, c.id, month),
	});

	return {
		active: rows.filter((c) => !c.archived).map(withBudget),
		archived: rows.filter((c) => c.archived).map(withBudget),
	};
}

/**
 * Every category's name, archived ones too, for the form's checks. Active ones come first, so a lookup by name
 * finds an active category before an archived one with the same name (migration 0052 kept some Unicode-case duplicates).
 */
export async function categoryNames(
	db: D1Database,
): Promise<{ id: number; name: string; archived: boolean }[]> {
	const rows = await drizzle(db)
		.select({
			id: categories.id,
			name: categories.name,
			archived: categories.archived,
		})
		.from(categories)
		.orderBy(
			asc(categories.archived),
			asc(categories.sortOrder),
			asc(categories.id),
		)
		.all();

	return rows.map((c) => ({ ...c, archived: c.archived === 1 }));
}

/** True while there's room for one more active category; checked inside each write, so two saves at once can't both pass. */
const ROOM = `(SELECT COUNT(*) FROM categories WHERE archived = 0) < ${MAX_ACTIVE}`;

/**
 * Adds a category at the end of the list, with the tag icon and the next color.
 * Returns its id, or null when the list was already full.
 */
export async function addCategory(
	db: D1Database,
	value: CategoryValue,
): Promise<number | null> {
	const summary = await drizzle(db)
		.select({
			n: count(),
			last: sql<number>`COALESCE(MAX(${categories.sortOrder}), 0)`,
		})
		.from(categories)
		.get();

	// stays SQL: INSERT ... SELECT ... WHERE ROOM, so the list-full check and the write are one statement (decision 179).
	const inserted = await db
		.prepare(
			`INSERT INTO categories (name, name_key, icon, color, sort_order) SELECT ?, ?, 'tag', ?, ? WHERE ${ROOM}`,
		)
		.bind(
			value.name,
			nameKey(value.name),
			COLORS[(summary?.n ?? 0) % COLORS.length],
			(summary?.last ?? 0) + 1,
		)
		.run();

	return inserted.meta.changes ? Number(inserted.meta.last_row_id) : null;
}

/**
 * Makes a category a person named in a form, or says why it can't be made: the name is taken (ignoring
 * case, and the form has already refused archived names), or the list is full. Nothing is made on a refusal.
 */
export async function makeCategory(
	db: D1Database,
	value: CategoryValue,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
	try {
		const id = await addCategory(db, value);

		if (id !== null) return { ok: true, id };
	} catch (error) {
		// The unique name indexes settle two saves at once (migrations 0005 and 0052).
		if (!isUniqueViolation(error)) throw error;
	}

	const taken = (await categoryNames(db)).some((category) =>
		sameName(category.name, value.name),
	);

	return {
		ok: false,
		error: taken ? "That name is taken." : fullMessage("add"),
	};
}

/**
 * Takes back a category made for a save that was then refused, so a refusal leaves no category behind. It
 * goes only while nothing uses it: a category another save has already filed transactions in stays.
 */
export async function unmakeCategory(
	db: D1Database,
	id: number,
): Promise<void> {
	// stays SQL: six NOT EXISTS subqueries over several tables in one DELETE (decision 179).
	await db
		.prepare(
			`DELETE FROM categories WHERE id = ?1
				AND NOT EXISTS (SELECT 1 FROM transactions WHERE category_id = ?1 OR jev_category_id = ?1 OR jev_also_category_id = ?1)
				AND NOT EXISTS (SELECT 1 FROM merchants WHERE default_category_id = ?1)
				AND NOT EXISTS (SELECT 1 FROM bills WHERE category_id = ?1)
				AND NOT EXISTS (SELECT 1 FROM budget_amounts WHERE category_id = ?1)
				AND NOT EXISTS (SELECT 1 FROM bank_text_rules WHERE category_id = ?1)
				AND NOT EXISTS (SELECT 1 FROM category_archive_periods WHERE category_id = ?1)`,
		)
		.bind(id)
		.run();
}

/** Renames a category. Throws a UNIQUE error when another category already has the name's key. */
export async function saveCategory(
	db: D1Database,
	id: number,
	value: CategoryValue,
): Promise<void> {
	// stays SQL: Drizzle's wrapped error ("Failed query: ...") drops the UNIQUE text that test/categories-db.test.ts
	// reads from the message (decision 179).
	await db
		.prepare("UPDATE categories SET name = ?, name_key = ? WHERE id = ?")
		.bind(value.name, nameKey(value.name), id)
		.run();
}

/**
 * Archives or restores a category. Nothing is deleted, so every pick and source stays meaningful
 * (spec §7). A restored category goes to the end of the list, so it never shares a place.
 * `on` is the household's date. The category and its archive period (spec §5) change in one batch,
 * so the period opens on archive and closes on restore on the same date.
 */
export async function setArchived(
	db: D1Database,
	id: number,
	archived: boolean,
	on = new Date().toISOString().slice(0, 10),
): Promise<boolean> {
	// stays raw: the caller reads results[0].meta.changes from this one raw db.batch (decision 179).
	const results = await db.batch([
		archived
			? db
					.prepare(
						"UPDATE categories SET archived = 1, archived_on = ? WHERE id = ? AND archived = 0",
					)
					.bind(on, id)
			: db
					.prepare(
						`UPDATE categories SET archived = 0, archived_on = NULL,
						sort_order = (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories WHERE archived = 0)
					WHERE id = ? AND archived = 1 AND ${ROOM}`,
					)
					.bind(id),
		archived
			? db
					.prepare(
						`INSERT INTO category_archive_periods (category_id, archived_on)
						SELECT id, archived_on FROM categories WHERE id = ? AND archived = 1 AND archived_on = ?
						AND NOT EXISTS (SELECT 1 FROM category_archive_periods WHERE category_id = ? AND restored_on IS NULL)`,
					)
					.bind(id, on, id)
			: db
					.prepare(
						`UPDATE category_archive_periods SET restored_on = ?
						WHERE category_id = ? AND restored_on IS NULL
						AND EXISTS (SELECT 1 FROM categories WHERE id = ? AND archived = 0)`,
					)
					.bind(on, id, id),
	]);

	// False when a restore found the category already active, or the list already full.
	return (results[0]?.meta.changes ?? 0) > 0;
}

/** Moves an active category one place up or down; the list is renumbered 1, 2, 3… as it goes. */
export async function moveCategory(
	db: D1Database,
	id: number,
	direction: "up" | "down",
): Promise<void> {
	const rows = await drizzle(db)
		.select({ id: categories.id })
		.from(categories)
		.where(eq(categories.archived, 0))
		.orderBy(asc(categories.sortOrder), asc(categories.name))
		.all();

	const order = rows.map((c) => c.id);
	const from = order.indexOf(id);
	const to = direction === "up" ? from - 1 : from + 1;

	if (from === -1 || to < 0 || to >= order.length) return;
	// SAFETY: from and to were checked against order.length above, so both entries exist.
	[order[from], order[to]] = [order[to] as number, order[from] as number];

	const orm = drizzle(db);

	const [first, ...rest] = order.map((categoryId, i) =>
		orm
			.update(categories)
			.set({ sortOrder: i + 1 })
			.where(eq(categories.id, categoryId)),
	);

	// The list has at least two entries here (from and to both exist), so there is always a first statement.
	if (first) await orm.batch([first, ...rest]);
}

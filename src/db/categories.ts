// The household's categories, as Settings shows and changes them (spec §5, §7, §8). Budgets: db/budgets.ts.
import { budgetForMonth } from "../budget";
import {
	type CategoryValue,
	fullMessage,
	MAX_ACTIVE,
	nameKey,
	sameName,
} from "../settings/category-form";

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

/**
 * Every category's name, archived ones too, for the form's checks. Active ones come first, so a lookup by name
 * finds an active category before an archived one with the same name (migration 0052 kept some Unicode-case duplicates).
 */
export async function categoryNames(
	db: D1Database,
): Promise<{ id: number; name: string; archived: boolean }[]> {
	const { results } = await db
		.prepare(
			"SELECT id, name, archived FROM categories ORDER BY archived, sort_order, id",
		)
		.all<{ id: number; name: string; archived: number }>();
	return results.map((c) => ({ ...c, archived: c.archived === 1 }));
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
	const count = await db
		.prepare(
			"SELECT COUNT(*) AS n, COALESCE(MAX(sort_order), 0) AS last FROM categories",
		)
		.first<{ n: number; last: number }>();
	const inserted = await db
		.prepare(
			`INSERT INTO categories (name, name_key, icon, color, sort_order) SELECT ?, ?, 'tag', ?, ? WHERE ${ROOM}`,
		)
		.bind(
			value.name,
			nameKey(value.name),
			COLORS[(count?.n ?? 0) % COLORS.length],
			(count?.last ?? 0) + 1,
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
		if (!(error instanceof Error && /UNIQUE/i.test(error.message))) throw error;
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
	await db
		.prepare(
			`DELETE FROM categories WHERE id = ?1
				AND NOT EXISTS (SELECT 1 FROM transactions WHERE category_id = ?1 OR jev_category_id = ?1)
				AND NOT EXISTS (SELECT 1 FROM merchants WHERE default_category_id = ?1)
				AND NOT EXISTS (SELECT 1 FROM bills WHERE category_id = ?1)
				AND NOT EXISTS (SELECT 1 FROM budget_amounts WHERE category_id = ?1)
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

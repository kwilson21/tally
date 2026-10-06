import { JEV_THRESHOLD } from "../ai/categorize";
import { tidyName } from "../transactions/tidy-name";
import { merchantKeySql } from "./merchant-key";
import type { ListRow } from "./transactions";

export type NoneFitTransaction = {
	id: number;
	theme: string;
	merchantKey: string;
	merchant: string;
};
export async function noneFitTransactions(
	db: D1Database,
): Promise<NoneFitTransaction[]> {
	const { results } = await db
		.prepare(`SELECT t.id, COALESCE(NULLIF(t.plaid_category,''), 'merchant:' || ${merchantKeySql("t")}) theme,
			${merchantKeySql("t")} merchantKey, COALESCE(m.display_name, NULLIF(t.merchant_name,''), t.raw_name) merchant
		FROM transactions t LEFT JOIN merchants m ON m.raw_name = ${merchantKeySql("t")}
		WHERE t.jev_none_fit = 1 AND t.category_confidence >= ? AND t.jev_category_id IS NULL
		AND t.category_id IS NULL AND t.category_source IS NULL AND t.category_suggestion_id IS NULL
		AND t.amount_cents > 0 AND t.pending = 0 AND t.excluded = 0 AND t.flag_income = 0
		AND t.is_split = 0 AND t.parent_id IS NULL ORDER BY t.id`)
		.bind(JEV_THRESHOLD)
		.all<NoneFitTransaction>();
	return results.map((row) => ({ ...row, merchant: tidyName(row.merchant) }));
}

const placeholders = () => `SELECT value FROM json_each(?)`;
export async function saveSuggestion(
	db: D1Database,
	name: string | null,
	ids: number[],
	avoid: string[] = [],
): Promise<number | null> {
	if (!ids.length) return null;
	const cleaned = name?.trim() ?? "";
	const safeName =
		cleaned && !avoid.some((n) => n.toLowerCase() === cleaned.toLowerCase())
			? cleaned
			: "";
	if (safeName) {
		const existing = await db
			.prepare(
				"SELECT id FROM category_suggestions WHERE name = ? COLLATE NOCASE AND status = 'pending'",
			)
			.bind(safeName)
			.first<{ id: number }>();
		if (existing) {
			await db
				.prepare(
					`UPDATE transactions SET category_suggestion_id = ? WHERE id IN (${placeholders()}) AND category_id IS NULL AND category_source IS NULL AND category_suggestion_id IS NULL`,
				)
				.bind(existing.id, JSON.stringify(ids))
				.run();
			return existing.id;
		}
	}
	const status = safeName ? "pending" : "none";
	const inserted = await db
		.prepare(
			"INSERT INTO category_suggestions (name, status) VALUES (?, ?) RETURNING id",
		)
		.bind(safeName, status)
		.first<{ id: number }>();
	const id = inserted?.id;
	if (!id) return null;
	await db
		.prepare(
			`UPDATE transactions SET category_suggestion_id = ? WHERE id IN (${placeholders()}) AND category_id IS NULL AND category_source IS NULL AND category_suggestion_id IS NULL`,
		)
		.bind(id, JSON.stringify(ids))
		.run();
	return id;
}

export async function namesToAvoid(db: D1Database): Promise<string[]> {
	const { results } = await db
		.prepare(
			"SELECT name FROM categories UNION SELECT name FROM category_suggestions WHERE status = 'dismissed'",
		)
		.all<{ name: string }>();
	return results.map((row) => row.name);
}

export type PendingSuggestion = { id: number; name: string; rows: ListRow[] };
export type PendingSuggestions = PendingSuggestion[] & { more: number };
export async function pendingSuggestions(
	db: D1Database,
): Promise<PendingSuggestions> {
	const { results: suggestions } = await db
		.prepare(
			"SELECT id, name FROM category_suggestions WHERE status = 'pending' ORDER BY id",
		)
		.all<{ id: number; name: string }>();
	if (!suggestions.length)
		return Object.defineProperty([], "more", {
			value: 0,
		}) as unknown as PendingSuggestions;
	const { results } = await db
		.prepare(`WITH pending AS (
			SELECT value AS id FROM json_each(?)
		), candidates AS (
			SELECT cs.id, cs.name, COUNT(t.id) AS n
			FROM pending p JOIN category_suggestions cs ON cs.id = p.id AND cs.status = 'pending'
			JOIN transactions t ON t.category_suggestion_id = cs.id AND t.category_id IS NULL AND t.category_source IS NULL AND t.pending = 0 AND t.amount_cents > 0 AND t.excluded = 0 AND t.flag_income = 0
			GROUP BY cs.id HAVING COUNT(t.id) >= 3
		), ranked AS (
			SELECT *, COUNT(*) OVER() AS total, ROW_NUMBER() OVER(ORDER BY n DESC, id) AS rank FROM candidates
		)
		SELECT r.id, r.name, r.n, r.total, t.id AS transactionId, t.date, t.amount_cents amountCents, t.raw_name rawName,
			COALESCE(m.display_name, t.merchant_name, t.raw_name) displayName, t.note, t.excluded, t.flag_income income,
			t.category_id categoryId, c.name categoryName, c.icon categoryIcon, c.color categoryColor, t.pending
		FROM ranked r JOIN transactions t ON t.category_suggestion_id = r.id
		LEFT JOIN merchants m ON m.raw_name = ${merchantKeySql("t")} LEFT JOIN categories c ON c.id = t.category_id
		WHERE r.rank <= 10 AND t.category_id IS NULL AND t.category_source IS NULL AND t.pending = 0 AND t.amount_cents > 0 AND t.excluded = 0 AND t.flag_income = 0
		ORDER BY r.rank, t.date DESC, t.id DESC`)
		.bind(JSON.stringify(suggestions.map((s) => s.id)))
		.all<
			Omit<ListRow, "pending" | "id"> & {
				id: number;
				name: string;
				transactionId: number;
				pending: number;
				n: number;
				total: number;
			}
		>();
	const byId = new Map<number, PendingSuggestion>();
	for (const row of results) {
		let suggestion = byId.get(row.id);
		if (!suggestion) {
			suggestion = { id: row.id, name: row.name, rows: [] };
			byId.set(row.id, suggestion);
		}
		const { transactionId, n: _n, total: _total, ...tx } = row;
		suggestion.rows.push({
			...tx,
			id: transactionId,
			displayName:
				tx.displayName === tx.displayName.toUpperCase()
					? tidyName(tx.displayName)
					: tx.displayName,
			excluded: !!tx.excluded,
			income: !!tx.income,
			pending: !!tx.pending,
		});
	}
	return Object.defineProperty([...byId.values()], "more", {
		value: Math.max(0, (results[0]?.total ?? 0) - byId.size),
	}) as PendingSuggestions;
}

export type CreateResult =
	| { ok: true; name: string; moved: number; leftOut: number[] }
	| { ok: false; reason: "gone" | "invalid"; error?: string };
export async function createFromSuggestion(
	db: D1Database,
	id: number,
	input: { ticked: number[]; shown: number[]; notes: Record<number, string> },
	actor: string,
): Promise<CreateResult> {
	const s = await db
		.prepare(
			"SELECT name FROM category_suggestions WHERE id = ? AND status = 'pending'",
		)
		.bind(id)
		.first<{ name: string }>();
	if (!s) return { ok: false, reason: "gone" };
	const name = tidyName(s.name);
	const attached = (
		await db
			.prepare(
				`SELECT id FROM transactions WHERE category_suggestion_id = ? AND category_id IS NULL AND category_source IS NULL AND id IN (${placeholders()})`,
			)
			.bind(id, JSON.stringify(input.shown))
			.all<{ id: number }>()
	).results.map((row) => row.id);
	const ticked = input.ticked.filter((tx) => attached.includes(tx));
	if (!ticked.length)
		return {
			ok: false,
			reason: "invalid",
			error: "Tick at least one transaction, or dismiss this suggestion.",
		};
	if (Object.values(input.notes).some((note) => note.length > 500))
		return {
			ok: false,
			reason: "invalid",
			error: "Keep each note under 500 characters.",
		};
	const active = await db
		.prepare("SELECT COUNT(*) n FROM categories WHERE archived = 0")
		.first<{ n: number }>();
	const conflict = await db
		.prepare("SELECT 1 FROM categories WHERE name = ? COLLATE NOCASE")
		.bind(name)
		.first();
	if (conflict)
		return {
			ok: false,
			reason: "invalid",
			error: "That name is reserved for Jev.",
		};
	if ((active?.n ?? 0) >= 50)
		return {
			ok: false,
			reason: "invalid",
			error: "Tally has room for 50 categories. Archive one to add another.",
		};
	const count = await db
		.prepare(
			"SELECT COUNT(*) n, COALESCE(MAX(sort_order),0) last FROM categories",
		)
		.first<{ n: number; last: number }>();
	const category = await db
		.prepare(
			"INSERT INTO categories (name, icon, color, sort_order) VALUES (?, 'tag', ?, ?)",
		)
		.bind(
			name,
			["cat-blue", "cat-plum", "cat-slate", "cat-ochre", "cat-brown"][
				(count?.n ?? 0) % 5
			],
			(count?.last ?? 0) + 1,
		)
		.run();
	const categoryId = Number(category.meta.last_row_id);
	await db
		.prepare(
			`UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL, category_suggestion_id = NULL, updated_by = ?, updated_at = datetime('now') WHERE category_suggestion_id = ? AND id IN (${placeholders()}) AND category_id IS NULL AND category_source IS NULL`,
		)
		.bind(categoryId, actor, id, JSON.stringify(ticked))
		.run();
	for (const [tx, note] of Object.entries(input.notes))
		if (
			!ticked.includes(Number(tx)) &&
			attached.includes(Number(tx)) &&
			note.trim()
		)
			await db
				.prepare(
					"UPDATE transactions SET note = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ? AND category_suggestion_id = ? AND category_id IS NULL AND category_source IS NULL",
				)
				.bind(note.trim(), actor, Number(tx), id)
				.run();
	const { results: leftOut } = await db
		.prepare(
			`SELECT id FROM transactions WHERE category_suggestion_id = ? AND category_id IS NULL AND category_source IS NULL AND id IN (${placeholders()})`,
		)
		.bind(id, JSON.stringify(attached))
		.all<{ id: number }>();
	await db
		.prepare(
			"UPDATE category_suggestions SET status = 'created', decided_at = datetime('now') WHERE id = ?",
		)
		.bind(id)
		.run();
	return {
		ok: true,
		name,
		moved: ticked.length,
		leftOut: leftOut.map((row) => row.id),
	};
}

export async function dismissSuggestion(
	db: D1Database,
	id: number,
): Promise<{ name: string } | null> {
	const result = await db
		.prepare(
			"UPDATE category_suggestions SET status = 'dismissed', decided_at = datetime('now') WHERE id = ? AND status = 'pending' RETURNING name",
		)
		.bind(id)
		.first<{ name: string }>();
	return result ?? null;
}

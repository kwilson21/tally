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
	const theme = `COALESCE(NULLIF(t.plaid_category,''), 'merchant:' || ${merchantKeySql("t")})`;
	const eligible = `t.jev_none_fit = 1 AND t.category_confidence >= ? AND t.jev_category_id IS NULL
		AND t.category_id IS NULL AND t.category_source IS NULL AND t.category_suggestion_id IS NULL
		AND t.amount_cents > 0 AND t.pending = 0 AND t.excluded = 0 AND t.flag_income = 0
		AND t.is_split = 0 AND t.parent_id IS NULL`;
	const { results: groups } = await db
		.prepare(`SELECT COALESCE(NULLIF(t.plaid_category,''), 'merchant:' || ${merchantKeySql("t")}) theme,
			COUNT(*) count FROM transactions t WHERE ${eligible} GROUP BY theme HAVING COUNT(*) >= 3
			ORDER BY count DESC, theme LIMIT 10`)
		.bind(JEV_THRESHOLD)
		.all<{ theme: string; count: number }>();
	if (!groups.length) return [];
	const { results } = await db
		.prepare(`SELECT t.id, ${theme} theme, ${merchantKeySql("t")} merchantKey,
			COALESCE(m.display_name, NULLIF(t.merchant_name,''), t.raw_name) merchant
		FROM transactions t LEFT JOIN merchants m ON m.raw_name = ${merchantKeySql("t")}
		JOIN json_each(?) selected ON selected.value = ${theme}
		WHERE ${eligible} ORDER BY t.date DESC, t.id DESC LIMIT 500`)
		.bind(JSON.stringify(groups.map((group) => group.theme)), JEV_THRESHOLD)
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
	const currentAvoid = [...new Set([...avoid, ...(await namesToAvoid(db))])];
	const safeName =
		cleaned &&
		!currentAvoid.some((n) => n.toLowerCase() === cleaned.toLowerCase())
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
					`UPDATE transactions SET category_suggestion_id = ? WHERE id IN (${placeholders()}) AND category_confidence >= ? AND jev_none_fit=1 AND jev_category_id IS NULL AND amount_cents>0 AND pending=0 AND excluded=0 AND flag_income=0 AND is_split=0 AND parent_id IS NULL AND category_id IS NULL AND category_source IS NULL AND category_suggestion_id IS NULL`,
				)
				.bind(existing.id, JSON.stringify(ids), JEV_THRESHOLD)
				.run();
			return existing.id;
		}
	}
	const status = safeName ? "pending" : "none";
	const eligible = `id IN (${placeholders()}) AND category_confidence >= ? AND jev_none_fit=1 AND jev_category_id IS NULL AND amount_cents>0 AND pending=0 AND excluded=0 AND flag_income=0 AND is_split=0 AND parent_id IS NULL AND category_id IS NULL AND category_source IS NULL AND category_suggestion_id IS NULL`;
	try {
		const results = await db.batch([
			db
				.prepare(
					`UPDATE transactions SET category_suggestion_id=NULL WHERE id IN (${placeholders()}) AND category_suggestion_id IN (SELECT id FROM category_suggestions WHERE status='none')`,
				)
				.bind(JSON.stringify(ids)),
			db
				.prepare(
					`INSERT INTO category_suggestions (name,status) SELECT ?,? WHERE (SELECT COUNT(*) FROM transactions WHERE ${eligible}) >= 3 RETURNING id`,
				)
				.bind(safeName, status, JSON.stringify(ids), JEV_THRESHOLD),
			db
				.prepare(
					`UPDATE transactions SET category_suggestion_id=(SELECT id FROM category_suggestions WHERE name=? COLLATE NOCASE AND status=? ORDER BY id DESC LIMIT 1) WHERE ${eligible} AND (SELECT COUNT(*) FROM transactions WHERE ${eligible}) >= 3 AND EXISTS (SELECT 1 FROM category_suggestions WHERE name=? COLLATE NOCASE AND status=?)`,
				)
				.bind(
					safeName,
					status,
					JSON.stringify(ids),
					JEV_THRESHOLD,
					JSON.stringify(ids),
					JEV_THRESHOLD,
					safeName,
					status,
				),
		]);
		const id = (results[1]?.results as { id: number }[] | undefined)?.[0]?.id;
		if (id) return id;
		return (
			(
				await db
					.prepare(
						"SELECT id FROM category_suggestions WHERE name=? COLLATE NOCASE AND status='pending'",
					)
					.bind(safeName)
					.first<{ id: number }>()
			)?.id ?? null
		);
	} catch (error) {
		// A concurrent nightly run may win the partial unique index; attach this group to that row.
		if (!safeName || !/UNIQUE/i.test(String(error))) throw error;
		const existing = await db
			.prepare(
				"SELECT id FROM category_suggestions WHERE name=? COLLATE NOCASE AND status='pending'",
			)
			.bind(safeName)
			.first<{ id: number }>();
		if (!existing) throw error;
		await db
			.prepare(
				`UPDATE transactions SET category_suggestion_id=? WHERE ${eligible}`,
			)
			.bind(existing.id, JSON.stringify(ids), JEV_THRESHOLD)
			.run();
		return existing.id;
	}
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
	await db.batch([
		db.prepare(
			`UPDATE transactions SET category_suggestion_id=NULL WHERE category_suggestion_id IN (SELECT cs.id FROM category_suggestions cs WHERE cs.status='pending' AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.category_suggestion_id=cs.id AND t.category_id IS NULL AND t.category_source IS NULL AND t.pending=0 AND t.amount_cents>0 AND t.excluded=0 AND t.flag_income=0 AND t.is_split=0 AND t.parent_id IS NULL))`,
		),
		db.prepare(
			`UPDATE category_suggestions SET status='none' WHERE status='pending' AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.category_suggestion_id=category_suggestions.id AND t.category_id IS NULL AND t.category_source IS NULL AND t.pending=0 AND t.amount_cents>0 AND t.excluded=0 AND t.flag_income=0 AND t.is_split=0 AND t.parent_id IS NULL)`,
		),
	]);
	// Select the ten busiest eligible pending suggestions before loading ids or purchase rows.
	const { results: suggestions } = await db
		.prepare(
			`WITH candidates AS (
				SELECT cs.id, cs.name, COUNT(t.id) n
				FROM category_suggestions cs JOIN transactions t ON t.category_suggestion_id=cs.id
				AND t.category_id IS NULL AND t.category_source IS NULL AND t.pending=0 AND t.amount_cents>0 AND t.excluded=0 AND t.flag_income=0 AND t.is_split=0 AND t.parent_id IS NULL
				WHERE cs.status='pending' GROUP BY cs.id HAVING COUNT(t.id)>0
			), ranked AS (SELECT *, COUNT(*) OVER() total, ROW_NUMBER() OVER(ORDER BY n DESC,id) rank FROM candidates)
			SELECT id,name,n,total FROM ranked WHERE rank<=10 ORDER BY rank`,
		)
		.all<{ id: number; name: string; n: number; total: number }>();
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
			JOIN transactions t ON t.category_suggestion_id = cs.id AND t.category_id IS NULL AND t.category_source IS NULL AND t.pending = 0 AND t.amount_cents > 0 AND t.excluded = 0 AND t.flag_income = 0 AND t.is_split=0 AND t.parent_id IS NULL
			GROUP BY cs.id HAVING COUNT(t.id) > 0
		), ranked AS (
			SELECT *, COUNT(*) OVER() AS total, ROW_NUMBER() OVER(ORDER BY n DESC, id) AS rank FROM candidates
		)
		SELECT r.id, r.name, r.n, r.total, t.id AS transactionId, t.date, t.amount_cents amountCents, t.raw_name rawName,
			COALESCE(m.display_name, t.merchant_name, t.raw_name) displayName, t.note, t.excluded, t.flag_income income,
			t.category_id categoryId, c.name categoryName, c.icon categoryIcon, c.color categoryColor, t.pending
		FROM ranked r JOIN transactions t ON t.category_suggestion_id = r.id
		LEFT JOIN merchants m ON m.raw_name = ${merchantKeySql("t")} LEFT JOIN categories c ON c.id = t.category_id
		WHERE r.rank <= 10 AND t.category_id IS NULL AND t.category_source IS NULL AND t.pending = 0 AND t.amount_cents > 0 AND t.excluded = 0 AND t.flag_income = 0 AND t.is_split=0 AND t.parent_id IS NULL
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
		value: Math.max(0, (suggestions[0]?.total ?? 0) - byId.size),
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
				`SELECT id FROM transactions WHERE category_suggestion_id = ? AND category_id IS NULL AND category_source IS NULL AND is_split=0 AND parent_id IS NULL AND pending=0 AND amount_cents>0 AND excluded=0 AND flag_income=0 AND id IN (${placeholders()})`,
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
	const count = await db
		.prepare(
			"SELECT COUNT(*) n, COUNT(CASE WHEN archived=0 THEN 1 END) active, COALESCE(MAX(sort_order),0) last, MAX(name=? COLLATE NOCASE) conflict FROM categories",
		)
		.bind(name)
		.first<{ n: number; active: number; last: number; conflict: number }>();
	if (count?.conflict)
		return {
			ok: false,
			reason: "invalid",
			error: "That name is reserved for Jev.",
		};
	if ((count?.active ?? 0) >= 50)
		return {
			ok: false,
			reason: "invalid",
			error: "Tally has room for 50 categories. Archive one to add another.",
		};
	const notes = Object.entries(input.notes)
		.filter(
			([tx, note]) =>
				!ticked.includes(Number(tx)) &&
				attached.includes(Number(tx)) &&
				note.trim(),
		)
		.map(([tx, note]) => ({ id: Number(tx), note: note.trim() }));
	const token = `${Date.now()}-${Math.random()}`;
	const gate =
		"EXISTS (SELECT 1 FROM category_suggestions WHERE id=? AND status='pending' AND decided_at=?)";
	const createdGate =
		"EXISTS (SELECT 1 FROM category_suggestions WHERE id=? AND status='created' AND decided_at=?)";
	let results: D1Result[];
	try {
		results = await db.batch([
			db
				.prepare(
					"UPDATE category_suggestions SET decided_at=? WHERE id=? AND status='pending' AND decided_at IS NULL",
				)
				.bind(token, id),
			db
				.prepare(
					`INSERT INTO categories (name,icon,color,sort_order) SELECT ?,'tag',?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM categories) WHERE ${gate} AND (SELECT COUNT(*) FROM categories WHERE archived=0)<50 AND NOT EXISTS(SELECT 1 FROM categories WHERE name=? COLLATE NOCASE) AND EXISTS(SELECT 1 FROM transactions WHERE category_suggestion_id=? AND id IN (${placeholders()}) AND category_id IS NULL AND category_source IS NULL AND is_split=0 AND parent_id IS NULL AND pending=0 AND amount_cents>0 AND excluded=0 AND flag_income=0)`,
				)
				.bind(
					name,
					["cat-blue", "cat-plum", "cat-slate", "cat-ochre", "cat-brown"][
						(count?.n ?? 0) % 5
					],
					id,
					token,
					name,
					id,
					JSON.stringify(ticked),
				),
			db
				.prepare(
					"UPDATE category_suggestions SET status='created' WHERE id=? AND status='pending' AND decided_at=? AND changes()>0",
				)
				.bind(id, token),
			db
				.prepare(
					`UPDATE transactions SET category_id=(SELECT id FROM categories WHERE name=? COLLATE NOCASE),category_source='user',category_confidence=NULL,jev_none_fit=0,category_suggestion_id=NULL,updated_by=?,updated_at=datetime('now') WHERE category_suggestion_id=? AND id IN (${placeholders()}) AND category_id IS NULL AND category_source IS NULL AND is_split=0 AND parent_id IS NULL AND pending=0 AND amount_cents>0 AND excluded=0 AND flag_income=0 AND ${createdGate}`,
				)
				.bind(name, actor, id, JSON.stringify(ticked), id, token),
			db
				.prepare(
					`UPDATE transactions SET note=json_extract(note.value,'$.note'),updated_by=?,updated_at=datetime('now') FROM json_each(?) AS note WHERE transactions.id=json_extract(note.value,'$.id') AND transactions.category_suggestion_id=? AND transactions.category_id IS NULL AND transactions.category_source IS NULL AND is_split=0 AND parent_id IS NULL AND pending=0 AND amount_cents>0 AND excluded=0 AND flag_income=0 AND ${createdGate}`,
				)
				.bind(actor, JSON.stringify(notes), id, id, token),
			db
				.prepare(
					`UPDATE transactions SET category_suggestion_id=NULL,category_confidence=NULL,jev_none_fit=0 WHERE category_suggestion_id=? AND category_id IS NULL AND category_source IS NULL AND is_split=0 AND parent_id IS NULL AND pending=0 AND amount_cents>0 AND excluded=0 AND flag_income=0 AND ${createdGate} RETURNING id`,
				)
				.bind(id, id, token),
			db
				.prepare(
					`UPDATE transactions SET category_suggestion_id=NULL WHERE category_suggestion_id=? AND ${createdGate}`,
				)
				.bind(id, id, token),
			db
				.prepare(
					"UPDATE category_suggestions SET decided_at=datetime('now') WHERE id=? AND status='created' AND decided_at=?",
				)
				.bind(id, token),
			db
				.prepare(
					"UPDATE category_suggestions SET decided_at=NULL WHERE id=? AND status='pending' AND decided_at=?",
				)
				.bind(id, token),
		]);
	} catch (error) {
		if (error instanceof Error && /UNIQUE/i.test(error.message))
			return { ok: false, reason: "invalid", error: "That name is taken." };
		throw error;
	}
	if ((results[2]?.meta.changes ?? 0) === 0) {
		const stillPending = await db
			.prepare("SELECT status FROM category_suggestions WHERE id=?")
			.bind(id)
			.first<{ status: string }>();
		if (stillPending?.status !== "pending")
			return { ok: false, reason: "gone" };
		const currentCount = await db
			.prepare("SELECT COUNT(*) n FROM categories WHERE archived=0")
			.first<{ n: number }>();
		if ((currentCount?.n ?? 0) >= 50)
			return {
				ok: false,
				reason: "invalid",
				error: "Tally has room for 50 categories. Archive one to add another.",
			};
		if (
			await db
				.prepare("SELECT 1 FROM categories WHERE name=? COLLATE NOCASE")
				.bind(name)
				.first()
		)
			return { ok: false, reason: "invalid", error: "That name is taken." };
		return {
			ok: false,
			reason: "invalid",
			error: "Tick at least one transaction, or dismiss this suggestion.",
		};
	}
	const leftOut = (results[5]?.results as { id: number }[]) ?? [];
	return {
		ok: true,
		name,
		moved: results[3]?.meta.changes ?? 0,
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

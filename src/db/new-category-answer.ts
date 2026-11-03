// The Maybe card's "New category" answer (decision 156): Tally's suggested name, opened in place, becomes an active
// category with no budget amount, and the card's purchase is filed in it. Naming goes through the one AI path
// (src/ai/suggest-name.ts), and only when the categories switch is on and an AI binding exists.
import { suggestCategoryName } from "../ai/suggest-name";
import {
	fullMessage,
	MAX_ACTIVE,
	nameForm,
	nameKey,
	normalizeName,
	parseCategory,
	sameName,
} from "../settings/category-form";
import { readAiSwitches } from "./ai-switches";
import { COLORS } from "./categories";
import { namesToAvoid } from "./category-suggestions";
import { merchantKeySql } from "./merchant-key";
import { neverSuggestedSql } from "./never-suggest";
import { categoryAskedSql } from "./suggestions-queue";

/**
 * The limit's words on the Maybe card: the category form's full message, and the offer to add to one the family has
 * instead (the Something else select is open with it).
 */
export const FULL_NEW_CATEGORY = `${fullMessage("add")} Add it to an existing category instead.`;

/** Where the purchase goes: an active category the family already has with the name, or a new one. */
export type NewCategoryTarget =
	| { ok: true; kind: "existing"; id: number; name: string }
	| { ok: true; kind: "create"; name: string; color: string }
	| { ok: false; error: string };

/**
 * The typed name, checked as the category form checks it (parseCategory). A name that is already an active category
 * files the purchase in that one, with no duplicate; an archived one is refused, as the form refuses it, so Restore
 * stays the way back. Pure: `categories` is what the family has now.
 */
export function newCategoryTarget(
	typed: string,
	categories: { id: number; name: string; archived: boolean }[],
): NewCategoryTarget {
	const name = normalizeName(typed);
	const active = categories.find((c) => !c.archived && sameName(c.name, name));
	if (active)
		return { ok: true, kind: "existing", id: active.id, name: active.name };
	const parsed = parseCategory(nameForm(name), categories, null);
	if (!parsed.ok) {
		const error = parsed.errors.name ?? "";
		return {
			ok: false,
			error: error === fullMessage("add") ? FULL_NEW_CATEGORY : error,
		};
	}
	return {
		ok: true,
		kind: "create",
		name: parsed.value.name,
		color: COLORS[categories.length % COLORS.length] ?? "cat-blue",
	};
}

/**
 * The pending category suggestion's name for each store, from the transactions it covers (the first, newest one wins).
 * A store with one is named without an AI call, and the card draws its row in place, with no script (decision 156).
 */
export async function pendingCategoryNames(
	db: D1Database,
	merchantKeys: string[],
): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	if (merchantKeys.length === 0) return names;
	const { results } = await db
		.prepare(
			`SELECT ${merchantKeySql("t")} AS key, cs.name AS name FROM category_suggestions cs
			JOIN transactions t ON t.category_suggestion_id = cs.id
			WHERE cs.status = 'pending' AND ${merchantKeySql("t")} IN (SELECT value FROM json_each(?))
				AND NOT ${neverSuggestedSql("t", "new_category")}
			ORDER BY cs.id DESC`,
		)
		.bind(JSON.stringify(merchantKeys))
		.all<{ key: string; name: string }>();
	for (const row of results)
		if (!names.has(row.key)) names.set(row.key, row.name);
	return names;
}

/**
 * The name Tally suggests for a store's purchase, or null. A pending suggestion for the same store is preferred and
 * makes no call. Otherwise Workers AI names it, from the store's name only, and only while the categories switch is on
 * and there is an AI binding (the demo has one too). A store with a "Never suggest" for a new category gets neither (the
 * same check the queue's new categories use, decision 101), so no name and no call. Each transaction is asked once: the
 * answer, a name or none, is kept in maybe_names and read back with no call after that (decision 161). Nothing here logs
 * the name.
 */
export async function suggestedCategoryName(
	db: D1Database,
	ai: Ai | undefined,
	item: { transactionId: number; merchantKey: string; merchant: string },
): Promise<string | null> {
	const allowed = await db
		.prepare(
			`SELECT 1 AS ok WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = ? AND ${neverSuggestedSql("t", "new_category")})`,
		)
		.bind(item.transactionId)
		.first();
	if (!allowed) return null;
	const pending = (await pendingCategoryNames(db, [item.merchantKey])).get(
		item.merchantKey,
	);
	if (pending) return pending;
	if (!ai || !(await readAiSwitches(db)).categories) return null;
	// Asked once for each transaction (decision 161): a kept answer, a name or "no name", is read and never asked again.
	const kept = await keptRow(db, item.transactionId);
	if (kept) return kept.name;
	// Claim first: the insert wins the transaction only once, so only the winner asks Workers AI. A request that loses
	// the claim reads what is stored: no name while the winner is still waiting, its name once it is kept.
	// The token names this claim: only it can finish the row, so an answer for a purchase that was deleted meanwhile (and
	// whose id a new purchase reused) is dropped rather than written over that purchase's row.
	const token = crypto.randomUUID();
	const claim = await db
		.prepare(
			`INSERT INTO maybe_names (transaction_id, name, claim)
			SELECT id, NULL, ? FROM transactions WHERE id = ?
			ON CONFLICT(transaction_id) DO NOTHING`,
		)
		.bind(token, item.transactionId)
		.run();
	if ((claim.meta.changes ?? 0) === 0)
		return (await keptRow(db, item.transactionId))?.name ?? null;
	// The store's name only: a person's own name or note for this purchase is typed text and never leaves the app.
	const result = await suggestCategoryName(
		ai,
		[item.merchant],
		await namesToAvoid(db),
	);
	// Kept whatever came back, so a failed call or an unusable answer is "no name" and is not asked again either.
	const name = result.ok ? result.name : null;
	const done = await db
		.prepare(
			"UPDATE maybe_names SET name = ? WHERE transaction_id = ? AND claim = ?",
		)
		.bind(name, item.transactionId, token)
		.run();
	// Nothing changed when the row was replaced meanwhile: the answer is for a purchase that is gone, so it is dropped.
	if ((done.meta.changes ?? 0) === 0) return null;
	return name;
}

/** The kept row for a transaction, or null when it was never claimed. Its name is null for "no name" or while waiting. */
async function keptRow(
	db: D1Database,
	transactionId: number,
): Promise<{ name: string | null } | null> {
	return db
		.prepare("SELECT name FROM maybe_names WHERE transaction_id = ?")
		.bind(transactionId)
		.first<{ name: string | null }>();
}

export type FileResult =
	| { ok: true; name: string; created: boolean }
	/** The purchase was answered, or changed, since the card was drawn: nothing was made or filed. */
	| { ok: false; reason: "gone" }
	/** The family has its 50 active categories: nothing was made or filed. */
	| { ok: false; reason: "limit" };

/**
 * Makes the category (for a create) and files the purchase in it, as one D1 batch. The category is found the way the
 * other category writes find one (by its name's key or, for a key migration 0052 kept as SQLite folded it, by its
 * name ignoring ASCII case), or by its id when the family already has it. Each statement has the same guards as the
 * Something else answer, so a race, a stale card or a full list changes nothing. The answer record is written before
 * the filing clears the Maybe's guess. No budget row is written.
 *
 * What it reports is what the batch did: `created` only when this batch inserted the row, and the name is the stored
 * category's, so a create that lost a race to the same name says "Added" in the stored casing.
 */
export async function fileInNewCategory(
	db: D1Database,
	input: {
		transactionId: number;
		target: Exclude<NewCategoryTarget, { ok: false }>;
		today: string;
		who: string;
	},
): Promise<FileResult> {
	const { transactionId, target, today, who } = input;
	const key = nameKey(target.name);
	// The question must still be asked, and no "Never suggest" for a new category may have been added since the name was
	// drawn (a cached row can outlive the rule). Every guard and the waiting check below use this, so a refused create
	// files nothing and reads as an answer that changed somewhere else, never as the limit.
	const asked = `${categoryAskedSql("transactions")} AND NOT ${neverSuggestedSql("transactions", "new_category")}`;
	// The category this batch files in: by id for an existing one, else by the name the way createFromSuggestion does.
	const pick =
		target.kind === "existing"
			? "(SELECT id FROM categories WHERE id = ? AND archived = 0)"
			: "(SELECT id FROM categories WHERE (name_key = ? OR name = ? COLLATE NOCASE) AND archived = 0 ORDER BY id LIMIT 1)";
	const pickBinds: (string | number)[] =
		target.kind === "existing" ? [target.id] : [key, target.name];
	const statements: D1PreparedStatement[] = [];
	if (target.kind === "create")
		statements.push(
			db
				.prepare(
					`INSERT INTO categories (name, name_key, icon, color, sort_order)
					SELECT ?, ?, 'tag', ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories)
					WHERE (SELECT COUNT(*) FROM categories WHERE archived = 0) < ${MAX_ACTIVE}
						AND NOT EXISTS (SELECT 1 FROM categories WHERE name_key = ? OR name = ? COLLATE NOCASE)
						AND EXISTS (SELECT 1 FROM transactions WHERE id = ? AND ${asked})`,
				)
				.bind(target.name, key, target.color, key, target.name, transactionId),
		);
	statements.push(
		db
			.prepare(
				`INSERT INTO maybe_answers (kind, confidence, answer, household_day)
				SELECT 'category', transactions.category_confidence,
					CASE WHEN transactions.jev_category_id = ${pick} THEN 'yes' ELSE 'something_else' END, ?
				FROM transactions WHERE id = ? AND ${asked} AND ${pick} IS NOT NULL`,
			)
			.bind(...pickBinds, today, transactionId, ...pickBinds),
	);
	statements.push(
		db
			.prepare(
				`UPDATE transactions SET category_id = ${pick},
					category_source = 'user', category_confidence = NULL, split_removed_from_cents = NULL, split_removed_bills = NULL,
					updated_by = ?, updated_at = datetime('now')
				WHERE id = ? AND ${asked} AND ${pick} IS NOT NULL`,
			)
			.bind(...pickBinds, who, transactionId, ...pickBinds),
	);
	const results = await db.batch(statements);
	const filed = results[results.length - 1]?.meta.changes ?? 0;
	if (filed === 0) {
		// A refusal is "gone" unless the purchase still waits for this answer: a stale answer must never read as the
		// limit, even when the list is full too. Only a waiting purchase on a create can be refused for the limit.
		const waiting = await db
			.prepare(`SELECT 1 AS ok FROM transactions WHERE id = ? AND ${asked}`)
			.bind(transactionId)
			.first();
		if (waiting && target.kind === "create") {
			const active = await db
				.prepare("SELECT COUNT(*) AS n FROM categories WHERE archived = 0")
				.first<{ n: number }>();
			if ((active?.n ?? 0) >= MAX_ACTIVE) return { ok: false, reason: "limit" };
		}
		return { ok: false, reason: "gone" };
	}
	const created =
		target.kind === "create" && (results[0]?.meta.changes ?? 0) === 1;
	// The stored category's own name, as it was saved (a create that lost a race keeps the other person's casing).
	const stored = await db
		.prepare(
			"SELECT c.name AS name FROM transactions t JOIN categories c ON c.id = t.category_id WHERE t.id = ?",
		)
		.bind(transactionId)
		.first<{ name: string }>();
	return { ok: true, name: stored?.name ?? target.name, created };
}

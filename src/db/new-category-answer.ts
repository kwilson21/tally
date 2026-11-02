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
import { categoryAskedSql } from "./suggestions-queue";

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
	if (!parsed.ok)
		return { ok: false, error: parsed.errors.name ?? fullMessage("add") };
	return {
		ok: true,
		kind: "create",
		name: parsed.value.name,
		color: COLORS[categories.length % COLORS.length] ?? "cat-blue",
	};
}

/**
 * The name Tally suggests for a store's purchase, or null. A pending suggestion for the same store is preferred and
 * makes no call. Otherwise Workers AI names it, from the store's name only, and only while the categories switch is on
 * and there is an AI binding (the demo has one too). Nothing here logs the name.
 */
export async function suggestedCategoryName(
	db: D1Database,
	ai: Ai | undefined,
	item: { merchantKey: string; label: string },
): Promise<string | null> {
	const pending = await db
		.prepare(
			`SELECT cs.name AS name FROM category_suggestions cs
			JOIN transactions t ON t.category_suggestion_id = cs.id
			WHERE cs.status = 'pending' AND ${merchantKeySql("t")} = ?
			ORDER BY cs.id DESC LIMIT 1`,
		)
		.bind(item.merchantKey)
		.first<{ name: string }>();
	if (pending) return pending.name;
	if (!ai || !(await readAiSwitches(db)).categories) return null;
	const result = await suggestCategoryName(
		ai,
		[item.label],
		await namesToAvoid(db),
	);
	return result.ok ? result.name : null;
}

export type FileResult =
	| { ok: true; name: string; created: boolean }
	/** The purchase was answered, or changed, since the card was drawn: nothing was made or filed. */
	| { ok: false; reason: "gone" }
	/** The family has its 50 active categories: nothing was made or filed. */
	| { ok: false; reason: "limit" };

/**
 * Makes the category (for a create) and files the purchase in it, as one D1 batch: the create, the answer record and
 * the filing are each guarded by the same checks the Something else answer uses (categoryAskedSql, an active category
 * by its key, the limit), so a race, a stale card or a full list changes nothing. The answer record is written before
 * the filing clears the Maybe's guess, as the Something else answer does. No budget row is written.
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
	const asked = categoryAskedSql("transactions");
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
					CASE WHEN transactions.jev_category_id = (SELECT id FROM categories WHERE name_key = ? AND archived = 0) THEN 'yes' ELSE 'something_else' END, ?
				FROM transactions WHERE id = ? AND ${asked}
					AND EXISTS (SELECT 1 FROM categories cc WHERE cc.name_key = ? AND cc.archived = 0)`,
			)
			.bind(key, today, transactionId, key),
	);
	statements.push(
		db
			.prepare(
				`UPDATE transactions SET category_id = (SELECT id FROM categories WHERE name_key = ? AND archived = 0),
					category_source = 'user', category_confidence = NULL, split_removed_from_cents = NULL, split_removed_bills = NULL,
					updated_by = ?, updated_at = datetime('now')
				WHERE id = ? AND ${asked}
					AND EXISTS (SELECT 1 FROM categories cc WHERE cc.name_key = ? AND cc.archived = 0)`,
			)
			.bind(key, who, transactionId, key),
	);
	const results = await db.batch(statements);
	const filed = results[results.length - 1]?.meta.changes ?? 0;
	if (filed === 0) {
		// Only a create can be refused for the limit; any other refusal means the card is out of date.
		if (target.kind === "create") {
			const active = await db
				.prepare("SELECT COUNT(*) AS n FROM categories WHERE archived = 0")
				.first<{ n: number }>();
			if ((active?.n ?? 0) >= MAX_ACTIVE) return { ok: false, reason: "limit" };
		}
		return { ok: false, reason: "gone" };
	}
	return { ok: true, name: target.name, created: target.kind === "create" };
}

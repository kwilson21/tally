// Mixed trips (#233, decision 113): when Jev says a trip spans more than one category, Tally offers a split,
// and no "Always use …?" question is asked for it. One definition, in SQL, so the edit panel, the split form,
// the rule offers and Organize's question read the same rule (as suggestions-queue.ts does for its bounds).
import { JEV_THRESHOLD } from "../ai/categorize";
import { BASIS_POINTS, confidenceBasisPoints } from "../ai/confidence";

/**
 * Jev says the trip looks mixed: its probability is at or above the threshold (the same floor the flags use),
 * it named another active category that differs from its active pick. Nothing about who chose the category,
 * so a rule offer, which comes after a person's pick, can still see it. `alias` names the transactions row.
 */
export const jevSaysMixedSql = (alias: string) =>
	`(COALESCE(CAST(${alias}.jev_mixed * ${BASIS_POINTS} AS INTEGER) >= ${confidenceBasisPoints(JEV_THRESHOLD)}, 0)
		AND ${alias}.jev_also_category_id IS NOT NULL AND ${alias}.jev_also_category_id != ${alias}.jev_category_id
		AND EXISTS (SELECT 1 FROM categories mc WHERE mc.id = ${alias}.jev_category_id AND mc.archived = 0)
		AND EXISTS (SELECT 1 FROM categories ma WHERE ma.id = ${alias}.jev_also_category_id AND ma.archived = 0))`;

/**
 * The edit panel's line and its split guess (decision 113): Jev says the trip looks mixed, and no person chose its
 * category. Once a person picks, the trip is theirs and the line goes; the rule offers don't use this (they follow
 * a person's own pick), only `jevSaysMixedSql`.
 */
export function looksMixed(
	jevSaysMixed: boolean,
	categorySource: string | null,
) {
	return jevSaysMixed && categorySource !== "user";
}

/** The fields of a transaction that decide whether its panel offers a split of Tally's guessed parts (#233). */
export type MixedTrip = {
	parentId?: number | null;
	isSplit?: boolean;
	income?: boolean;
	jevSaysMixed: boolean;
	categorySource: string | null;
	suggestedCategoryId: number | null;
	suggestedCategoryName: string | null;
	alsoCategoryId: number | null;
	alsoCategoryName: string | null;
};

/**
 * The two categories a trip that looks mixed splits into, Jev's pick first, or null when it doesn't look mixed
 * or can't be split (a split part, a split purchase, income). The split form and the edit panel both read this.
 */
export function mixedCategories(tx: MixedTrip): {
	first: { id: number; name: string };
	second: { id: number; name: string };
} | null {
	if (
		(tx.parentId ?? null) !== null ||
		tx.isSplit === true ||
		tx.income === true
	)
		return null;
	if (!looksMixed(tx.jevSaysMixed, tx.categorySource)) return null;
	if (
		tx.suggestedCategoryId === null ||
		tx.suggestedCategoryName === null ||
		tx.alsoCategoryId === null ||
		tx.alsoCategoryName === null
	)
		return null;
	return {
		first: { id: tx.suggestedCategoryId, name: tx.suggestedCategoryName },
		second: { id: tx.alsoCategoryId, name: tx.alsoCategoryName },
	};
}

/**
 * Whether any of these transactions looks mixed by Jev's answer, whoever chose the category (Organize's question
 * is asked after a person's save, so it can't use `looksMixed`). One statement for the whole list.
 */
export async function jevSaysMixedAmong(
	db: D1Database,
	ids: number[],
): Promise<boolean> {
	if (ids.length === 0) return false;
	const row = await db
		.prepare(
			`SELECT 1 AS hit FROM transactions t WHERE t.id IN (SELECT value FROM json_each(?)) AND ${jevSaysMixedSql("t")} LIMIT 1`,
		)
		.bind(JSON.stringify(ids))
		.first<{ hit: number }>();
	return row !== null;
}

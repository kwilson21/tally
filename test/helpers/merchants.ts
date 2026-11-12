import { expect } from "vitest";

// Test helpers for a merchant's suggestion, which is a `merchants` row (its status and names_asked) plus its rows in
// `merchant_suggested_names`. There is no foreign key, so every test that removes merchants must remove their names too,
// and every test that seeds a merchant must replace its names: these helpers do both. The invariants (I1 to I3, with
// I2 only for pending, see migrations/0071_merchant_suggested_names.sql) are checked by assertMerchantInvariants.

type Status = "none" | "pending" | "accepted" | "rejected";

export type MerchantSeed = {
	key: string;
	status?: Status;
	/** The names, in order (at most three). A pending merchant needs at least one; a none merchant has none. */
	names?: string[];
	/** Workers AI was asked and had no usable name (only with status none). */
	namesAsked?: boolean;
	displayName?: string | null;
	defaultCategoryId?: number | null;
	notABill?: boolean;
};

/**
 * Replaces whatever merchant row and names the key has with the state given: a plain INSERT, after the key's old names
 * are deleted (so INSERT OR REPLACE is never needed, and an old name can't survive a reseed).
 */
export async function seedMerchant(
	db: D1Database,
	merchant: MerchantSeed,
): Promise<void> {
	const status = merchant.status ?? "none";
	const names = merchant.names ?? [];
	await db.batch([
		db
			.prepare("DELETE FROM merchant_suggested_names WHERE merchant_key = ?")
			.bind(merchant.key),
		db.prepare("DELETE FROM merchants WHERE raw_name = ?").bind(merchant.key),
		db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name, default_category_id, suggestion_status, names_asked, not_a_bill) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.bind(
				merchant.key,
				merchant.displayName ?? null,
				merchant.defaultCategoryId ?? null,
				status,
				merchant.namesAsked ? 1 : 0,
				merchant.notABill ? 1 : 0,
			),
		...names.map((name, position) =>
			db
				.prepare(
					"INSERT INTO merchant_suggested_names (merchant_key, position, name) VALUES (?, ?, ?)",
				)
				.bind(merchant.key, position, name),
		),
	]);
}

/**
 * Replaces only the names of a key, leaving its merchant row alone (for a test that changes names on an existing row).
 * An empty list removes them.
 */
export async function setMerchantNames(
	db: D1Database,
	key: string,
	names: string[],
): Promise<void> {
	await db.batch([
		db
			.prepare("DELETE FROM merchant_suggested_names WHERE merchant_key = ?")
			.bind(key),
		...names.map((name, position) =>
			db
				.prepare(
					"INSERT INTO merchant_suggested_names (merchant_key, position, name) VALUES (?, ?, ?)",
				)
				.bind(key, position, name),
		),
	]);
}

/** A key's names in position order (empty when it has none). */
export async function merchantNames(
	db: D1Database,
	key: string,
): Promise<string[]> {
	const { results } = await db
		.prepare(
			"SELECT name FROM merchant_suggested_names WHERE merchant_key = ? ORDER BY position",
		)
		.bind(key)
		.all<{ name: string }>();

	return results.map((row) => row.name);
}

/**
 * Deletes the merchants matching `where` (SQL over `merchants` columns, e.g. "suggestion_status = 'pending'"; all of them
 * when omitted), and their names first, so no name row is left for a missing merchant.
 */
export async function clearMerchants(
	db: D1Database,
	where?: string,
	binds: unknown[] = [],
): Promise<void> {
	const scope = where ? `WHERE ${where}` : "";
	await db.batch([
		db
			.prepare(
				`DELETE FROM merchant_suggested_names WHERE merchant_key IN (SELECT raw_name FROM merchants ${scope})`,
			)
			.bind(...binds),
		db.prepare(`DELETE FROM merchants ${scope}`).bind(...binds),
	]);
}

/**
 * The invariants a store function must leave: (I1) a none merchant has no names; (I2) a pending merchant has at least one
 * name and was not asked again (names_asked 0); (I3) names are trimmed, non-empty, and positions run 0..n-1 with at most
 * three; and no name row is left for a merchant that doesn't exist.
 */
export async function assertMerchantInvariants(db: D1Database): Promise<void> {
	const check = async (sql: string) =>
		(await db.prepare(sql).all<{ key: string }>()).results.map(
			(row) => row.key,
		);

	expect(
		await check(
			"SELECT m.raw_name AS key FROM merchants m WHERE m.suggestion_status = 'none' AND EXISTS (SELECT 1 FROM merchant_suggested_names n WHERE n.merchant_key = m.raw_name)",
		),
		"I1: a none merchant has names",
	).toEqual([]);
	expect(
		await check(
			"SELECT m.raw_name AS key FROM merchants m WHERE m.suggestion_status = 'pending' AND (NOT EXISTS (SELECT 1 FROM merchant_suggested_names n WHERE n.merchant_key = m.raw_name) OR m.names_asked != 0)",
		),
		"I2: a pending merchant has no names, or was asked",
	).toEqual([]);
	expect(
		await check(
			"SELECT n.merchant_key AS key FROM merchant_suggested_names n GROUP BY n.merchant_key HAVING MAX(n.position) + 1 != COUNT(*) OR COUNT(*) > 3",
		),
		"I3: positions have gaps, or more than three names",
	).toEqual([]);
	expect(
		await check(
			"SELECT n.merchant_key AS key FROM merchant_suggested_names n WHERE NOT EXISTS (SELECT 1 FROM merchants m WHERE m.raw_name = n.merchant_key)",
		),
		"a name row with no merchant",
	).toEqual([]);
}

/** The JSON text merchantNamesJsonSql gives for these names, as the readers take it: `[[0, "first"], [1, "second"]]`. */
export const storedNames = (names: readonly string[]): string =>
	JSON.stringify(names.map((name, position) => [position, name]));

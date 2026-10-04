import { COUNTED_JOINS, countedCategorySql } from "../db/counted-month";
import { tidyName } from "./tidy-name";

// The same set Home counts as needing a category (a linked refund goes by its purchase's category).
// A linked refund is left to its purchase, as in src/db/transactions.ts.
const NEEDS_CATEGORY = `${countedCategorySql()} IS NULL AND t.excluded = 0 AND t.is_split = 0 AND t.flag_income = 0 AND t.refund_of_id IS NULL`;
const NEEDS_CATEGORY_UPDATE =
	"category_id IS NULL AND excluded = 0 AND is_split = 0 AND flag_income = 0 AND refund_of_id IS NULL";
const CHUNK_SIZE = 90;

export type OrganizeGroup = {
	name: string;
	count: number;
	totalCents: number;
	rawNames: string[];
};

/** Aggregates transactions in SQL, then combines raw merchants that share a shown name. */
export async function organizeGroups(db: D1Database): Promise<OrganizeGroup[]> {
	const { results } = await db
		.prepare(
			`SELECT t.raw_name AS rawName, COUNT(*) AS count, SUM(t.amount_cents) AS totalCents,
				m.display_name AS displayName
			FROM transactions t LEFT JOIN merchants m ON m.raw_name = t.raw_name
			${COUNTED_JOINS}
			WHERE ${NEEDS_CATEGORY}
			GROUP BY t.raw_name, m.display_name`,
		)
		.all<{
			rawName: string;
			count: number;
			totalCents: number;
			displayName: string | null;
		}>();
	const groups = new Map<string, OrganizeGroup>();
	for (const row of results) {
		const name = row.displayName ?? tidyName(row.rawName);
		const group = groups.get(name) ?? {
			name,
			count: 0,
			totalCents: 0,
			rawNames: [],
		};
		group.count += row.count;
		group.totalCents += row.totalCents;
		group.rawNames.push(row.rawName);
		groups.set(name, group);
	}
	return [...groups.values()].sort(
		(a, b) =>
			b.totalCents - a.totalCents ||
			b.count - a.count ||
			a.name.localeCompare(b.name),
	);
}

/** Categorizes a current merchant group and creates rules for future transactions. */
export async function saveOrganizeGroup(
	db: D1Database,
	rawNames: string[],
	categoryId: number,
	displayName: string | null,
	updatedBy: string,
): Promise<number> {
	const names = [...new Set(rawNames)];
	if (names.length === 0) return 0;
	let saved = 0;
	for (let offset = 0; offset < names.length; offset += CHUNK_SIZE) {
		const chunk = names.slice(offset, offset + CHUNK_SIZE);
		const marks = chunk.map(() => "?").join(", ");
		const count = await db
			.prepare(
				`SELECT COUNT(*) AS n FROM transactions t ${COUNTED_JOINS} WHERE ${NEEDS_CATEGORY} AND t.raw_name IN (${marks})`,
			)
			.bind(...chunk)
			.first<{ n: number }>();
		saved += count?.n ?? 0;
	}
	// A stale form must not alter rules after another request categorized the group.
	if (saved === 0) return 0;

	const statements: D1PreparedStatement[] = [];
	for (let offset = 0; offset < names.length; offset += CHUNK_SIZE) {
		const chunk = names.slice(offset, offset + CHUNK_SIZE);
		const marks = chunk.map(() => "?").join(", ");
		statements.push(
			db
				.prepare(
					`UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL, split_removed_from_cents = NULL,
						updated_by = ?, updated_at = datetime('now')
					WHERE ${NEEDS_CATEGORY_UPDATE} AND raw_name IN (${marks})`,
				)
				.bind(categoryId, updatedBy, ...chunk),
		);
	}
	for (const rawName of names) {
		statements.push(
			db
				.prepare(
					`INSERT INTO merchants (raw_name, display_name, default_category_id) VALUES (?, ?, ?)
					ON CONFLICT(raw_name) DO UPDATE SET default_category_id = excluded.default_category_id,
						display_name = CASE WHEN ? IS NULL THEN merchants.display_name ELSE excluded.display_name END`,
				)
				.bind(rawName, displayName, categoryId, displayName),
		);
	}
	await db.batch(statements);
	return saved;
}

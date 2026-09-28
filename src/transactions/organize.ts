import { tidyName } from "./tidy-name";

const NEEDS_CATEGORY =
	"t.category_id IS NULL AND t.excluded = 0 AND t.is_split = 0 AND t.flag_income = 0";
const NEEDS_CATEGORY_UPDATE =
	"category_id IS NULL AND excluded = 0 AND is_split = 0 AND flag_income = 0";

export type OrganizeGroup = {
	name: string;
	count: number;
	totalCents: number;
	rawNames: string[];
};

/** Groups every transaction needing a category by the merchant name shown in the list. */
export async function organizeGroups(db: D1Database): Promise<OrganizeGroup[]> {
	const { results } = await db
		.prepare(
			`SELECT t.raw_name AS rawName, t.amount_cents AS amountCents, m.display_name AS displayName
			FROM transactions t LEFT JOIN merchants m ON m.raw_name = t.raw_name
			WHERE ${NEEDS_CATEGORY}`,
		)
		.all<{
			rawName: string;
			amountCents: number;
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
		group.count += 1;
		group.totalCents += row.amountCents;
		if (!group.rawNames.includes(row.rawName)) group.rawNames.push(row.rawName);
		groups.set(name, group);
	}
	return [...groups.values()].sort(
		(a, b) =>
			b.totalCents - a.totalCents ||
			b.count - a.count ||
			a.name.localeCompare(b.name),
	);
}

/** Categorizes a merchant group and creates the rules that categorize future transactions. */
export async function saveOrganizeGroup(
	db: D1Database,
	rawNames: string[],
	categoryId: number,
	displayName: string | null,
	updatedBy: string,
): Promise<number> {
	const names = [...new Set(rawNames)];
	if (names.length === 0) return 0;
	const marks = names.map(() => "?").join(", ");
	const count = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM transactions t WHERE ${NEEDS_CATEGORY} AND t.raw_name IN (${marks})`,
		)
		.bind(...names)
		.first<{ n: number }>();
	const statements = [
		db
			.prepare(
				`UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL,
					updated_by = ?, updated_at = datetime('now')
				WHERE ${NEEDS_CATEGORY_UPDATE} AND raw_name IN (${marks})`,
			)
			.bind(categoryId, updatedBy, ...names),
	];
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
	return count?.n ?? 0;
}

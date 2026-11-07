import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { EXPORT_COLUMNS } from "../src/settings/export";

// A live column the JSON export leaves out on purpose: table -> column -> one-line reason.
const NAMED_OMISSIONS: Record<string, Record<string, string>> = {
	transactions: {
		entry_key:
			"The Add cash form's one-time key, so a double submit records one entry (migration 0019); not family data.",
	},
	categories: {
		name_key:
			"The name as the form compares it, ignoring case and spacing: a lookup key made from name, which is exported (spec §5, migration 0052).",
	},
	bill_payments: {
		undo_token:
			"A random one-use token for a Not this one's Undo (spec §5, #340); not family data.",
	},
	category_archive_periods: {
		id: "UNKNOWN: ask the owner",
	},
};

// An app table the JSON export leaves out on purpose: table -> one-line reason.
const NOT_EXPORTED: Record<string, string> = {
	push_subscriptions:
		"Each device's push endpoint and keys are device tokens, like the access token (export.ts comment, spec §5, decision 149).",
	cash_delete_holds:
		"A one-use, ten-second undo snapshot for a deleted cash entry, removed by the nightly run (spec §5, decision 84).",
	planned_delete_holds:
		"A ten-second undo snapshot for a deleted plan, removed by each later delete (spec §5, decision 101).",
	feedback: "UNKNOWN: ask the owner",
	maybe_names: "UNKNOWN: ask the owner",
};

// Tables tallyExport reads with its own statement rather than EXPORT_COLUMNS.
const OWN_STATEMENT = ["plaid_items", "documents"];

type Lists = {
	namedOmissions: Record<string, Record<string, string>>;
	notExported: Record<string, string>;
	ownStatement: string[];
};

/**
 * Compare the live schema with what the export selects. Pure: the caller reads the
 * database and passes liveSchema (app table -> live column names), exportedColumns
 * (EXPORT_COLUMNS table -> names its statement returns) and the lists. Returns one
 * message per problem; an empty array means the export is complete.
 */
function exportProblems(
	liveSchema: Record<string, string[]>,
	exportedColumns: Record<string, string[]>,
	lists: Lists,
): string[] {
	const problems: string[] = [];
	const exportedTables = Object.keys(exportedColumns);

	for (const table of exportedTables) {
		if (!(table in liveSchema))
			problems.push(`${table}: in EXPORT_COLUMNS but not an app table`);
	}

	for (const [table, columns] of Object.entries(liveSchema)) {
		if (!(table in exportedColumns)) {
			if (!lists.ownStatement.includes(table) && !(table in lists.notExported))
				problems.push(
					`${table}: table is not in EXPORT_COLUMNS, its own export statement, or NOT_EXPORTED`,
				);
			continue;
		}
		const exported = new Set(exportedColumns[table]);
		const named = lists.namedOmissions[table] ?? {};
		for (const column of columns) {
			if (!exported.has(column) && !(column in named))
				problems.push(
					`${table}.${column}: column is neither exported nor in NAMED_OMISSIONS`,
				);
		}
		for (const column of Object.keys(named)) {
			if (exported.has(column))
				problems.push(
					`${table}.${column}: in NAMED_OMISSIONS but exported, remove it`,
				);
			else if (!columns.includes(column))
				problems.push(
					`${table}.${column}: in NAMED_OMISSIONS but not a live column`,
				);
		}
	}

	for (const table of Object.keys(lists.notExported)) {
		if (!(table in liveSchema))
			problems.push(`${table}: in NOT_EXPORTED but not an app table`);
		else if (table in exportedColumns)
			problems.push(`${table}: in NOT_EXPORTED but also in EXPORT_COLUMNS`);
	}
	for (const table of lists.ownStatement) {
		if (!(table in liveSchema))
			problems.push(
				`${table}: listed as its own statement but not an app table`,
			);
	}
	for (const table of Object.keys(lists.namedOmissions)) {
		if (!exportedTables.includes(table))
			problems.push(`${table}: in NAMED_OMISSIONS but not in EXPORT_COLUMNS`);
	}
	return problems;
}

async function appTables(): Promise<string[]> {
	const { results } = await env.DB.prepare(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
	).all<{ name: string }>();
	return results.map((row) => row.name);
}

async function liveColumns(table: string): Promise<string[]> {
	const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
		name: string;
	}>();
	return results.map((row) => row.name);
}

async function exportedNames(
	table: string,
	columns: string,
): Promise<string[]> {
	// With columnNames, the names come back as the first row, even when LIMIT 0 leaves no data rows.
	const [names] = await env.DB.prepare(
		`SELECT ${columns} FROM ${table} LIMIT 0`,
	).raw<string[]>({ columnNames: true });
	return names;
}

describe("JSON export column guard", () => {
	it("exports or names every live column of each exported table", async () => {
		const tables = await appTables();
		const liveSchema: Record<string, string[]> = {};
		const exportedColumns: Record<string, string[]> = {};
		for (const table of Object.keys(EXPORT_COLUMNS)) {
			if (!tables.includes(table)) continue;
			liveSchema[table] = await liveColumns(table);
			exportedColumns[table] = await exportedNames(
				table,
				EXPORT_COLUMNS[table as keyof typeof EXPORT_COLUMNS],
			);
		}
		const problems = exportProblems(liveSchema, exportedColumns, {
			namedOmissions: NAMED_OMISSIONS,
			notExported: {},
			ownStatement: [],
		});
		expect(problems).toEqual([]);
	});

	it("lists every app table as exported, read by its own statement, or not exported", async () => {
		// Only table names matter here, so every live table is given no columns.
		const liveSchema: Record<string, string[]> = {};
		for (const table of await appTables()) liveSchema[table] = [];
		const exportedColumns: Record<string, string[]> = {};
		for (const table of Object.keys(EXPORT_COLUMNS))
			exportedColumns[table] = [];
		const problems = exportProblems(liveSchema, exportedColumns, {
			namedOmissions: {},
			notExported: NOT_EXPORTED,
			ownStatement: OWN_STATEMENT,
		});
		expect(problems).toEqual([]);
	});

	describe("exportProblems reports what is missing", () => {
		const schema = {
			categories: ["id", "name", "secret"],
			hidden: ["id"],
		};
		const exported = { categories: ["id", "name"] };
		const lists: Lists = {
			namedOmissions: {},
			notExported: {},
			ownStatement: [],
		};

		it("reports a live column that is neither exported nor named", () => {
			expect(exportProblems(schema, exported, lists)).toContain(
				"categories.secret: column is neither exported nor in NAMED_OMISSIONS",
			);
		});

		it("accepts a live column that is named with a reason", () => {
			expect(
				exportProblems(schema, exported, {
					...lists,
					namedOmissions: { categories: { secret: "a test reason" } },
				}).filter((problem) => problem.startsWith("categories.secret")),
			).toEqual([]);
		});

		it("reports a table that is in no list", () => {
			expect(exportProblems(schema, exported, lists)).toContain(
				"hidden: table is not in EXPORT_COLUMNS, its own export statement, or NOT_EXPORTED",
			);
		});

		it("accepts a table that is listed as not exported", () => {
			expect(
				exportProblems(
					{ categories: ["id", "name"], hidden: ["id"] },
					exported,
					{ ...lists, notExported: { hidden: "a test reason" } },
				),
			).toEqual([]);
		});

		it("reports a named omission for a column the export already selects", () => {
			expect(
				exportProblems(schema, exported, {
					...lists,
					namedOmissions: { categories: { name: "stale" } },
				}),
			).toContain(
				"categories.name: in NAMED_OMISSIONS but exported, remove it",
			);
		});
	});
});

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { EXPORT_COLUMNS, OWN_STATEMENTS } from "../src/settings/export";

// A live column the JSON export leaves out on purpose: table -> column -> one-line reason.
const NAMED_OMISSIONS = {
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
			"A random one-use token for a Not this one's Undo (migration 0048, decision 99); not family data.",
	},
	category_archive_periods: {
		id: "A row number; the category and both days are exported (decision 185).",
	},
	merchants: {
		started_by_sync:
			"The lock id of the sync that started the row: internal bookkeeping, not family data (migration 0072, decision 218).",
	},
	plaid_items: {
		id: "A row number; banks come out by name and status only (spec, Download your data).",
		plaid_item_id:
			"Plaid's own id for the login; banks come out by name and status only (spec, Download your data).",
		access_token_encrypted:
			"The encrypted access token; access tokens are never in the download (spec, Download your data).",
		sync_cursor:
			"Plaid's sync position; sync cursors are never in the download (spec, Download your data).",
		sync_update_cursor:
			"Where the bank's update in progress began; sync cursors are never in the download (spec, Download your data).",
		sync_locked_until:
			"When the sync lease ends; sync locks are never in the download (spec, Download your data).",
		sync_lock_id:
			"The sync lease's owner; sync locks are never in the download (spec, Download your data).",
		linked_by:
			"The email of who linked the bank; banks come out by name and status only (spec §5, Download your data).",
		created_at:
			"When the login was linked; banks come out by name and status only (spec, Download your data).",
		last_synced_at:
			"When the bank last synced; banks come out by name and status only (spec, Download your data).",
		last_sync_attempt_at:
			"When the bank last tried to sync; banks come out by name and status only (spec, Download your data).",
		disconnected_at:
			"When the bank was disconnected; its exported status says 'disconnected' instead (migration 0010, export.ts).",
		reconnect_emailed_at:
			"When the reconnect email last went out (spec §5, decision 82); banks come out by name and status only.",
		history_complete_at:
			"When the 90-day history was imported (spec §5); banks come out by name and status only (spec, Download your data).",
		attention_login:
			"Whether a login problem needs attention (decision 173, migration 0069); banks come out by name and status only.",
		attention_held:
			"Whether a relink is needed to clear the attention (decision 173, migration 0069); banks come out by name and status only.",
		connection_revision:
			"A count of completed syncs and relinks (decision 173, migration 0070); banks come out by name and status only.",
	},
	documents: {
		id: "A row number; documents come out as file names and dates (spec, Download your data).",
		r2_key:
			"The storage key of the file's bytes; documents come out as file names and dates, not the files (spec, Download your data).",
		size_bytes:
			"The file's size; documents come out as file names and dates (spec, Download your data).",
		uploaded_by:
			"The email of who uploaded the file; documents come out as file names and dates (spec §5, Download your data).",
		note: "A note a person wrote on the file; documents come out as file names and dates (spec, Download your data).",
	},
	maybe_names: {
		claim:
			"A random token that lets one request finish the row (migration 0063, decision 161); not family data (decision 185).",
	},
} satisfies Record<string, Record<string, string>>;

// An app table the JSON export leaves out on purpose: table -> one-line reason.
const NOT_EXPORTED = {
	push_subscriptions:
		"Each device's push endpoint and keys are device tokens, like the access token (export.ts comment, spec §5, decision 149).",
	cash_delete_holds:
		"A one-use, ten-second undo snapshot for a deleted cash entry, removed by the nightly run (spec §5, decision 84).",
	planned_delete_holds:
		"A ten-second undo snapshot for a deleted plan, removed by each later delete (spec §5, decision 101).",
	feedback:
		"Left out of the download by the owner's choice (decision 185); the in-app feedback form has its own privacy handling (decision 61).",
} satisfies Record<string, string>;

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

// The names a select returns, read from the select itself: the subquery keeps its ORDER BY out of the way.
// With columnNames, the names come back as the first row, even when LIMIT 0 leaves no data rows.
async function exportedNames(select: string): Promise<string[]> {
	const [names] = await env.DB.prepare(`SELECT * FROM (${select}) LIMIT 0`).raw<
		string[]
	>({ columnNames: true });

	return names;
}

describe("JSON export column guard", () => {
	it("exports or names every live column of each exported table", async () => {
		const tables = await appTables();
		const liveSchema: Record<string, string[]> = {};
		const exportedColumns: Record<string, string[]> = {};

		// Every table the download reads, whether from EXPORT_COLUMNS or its own statement, is held to the same rule.
		const selects = {
			...Object.fromEntries(
				Object.entries(EXPORT_COLUMNS).map(([table, columns]) => [
					table,
					`SELECT ${columns} FROM ${table}`,
				]),
			),
			...OWN_STATEMENTS,
		};

		for (const [table, select] of Object.entries(selects)) {
			if (!tables.includes(table)) continue;
			liveSchema[table] = await liveColumns(table);
			exportedColumns[table] = await exportedNames(select);
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
			ownStatement: Object.keys(OWN_STATEMENTS),
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

		it("reports a named omission for a column the table does not have", () => {
			expect(
				exportProblems(schema, exported, {
					...lists,
					namedOmissions: { categories: { gone: "stale" } },
				}),
			).toContain("categories.gone: in NAMED_OMISSIONS but not a live column");
		});

		it("reports a NOT_EXPORTED table that is not an app table", () => {
			expect(
				exportProblems(schema, exported, {
					...lists,
					notExported: { missing_table: "stale" },
				}),
			).toContain("missing_table: in NOT_EXPORTED but not an app table");
		});

		it("reports a new live column on a table read by its own statement", () => {
			expect(
				exportProblems(
					{ documents: ["id", "filename", "uploaded_at", "new_col"] },
					{ documents: ["filename", "uploaded_at"] },
					{ ...lists, ownStatement: ["documents"] },
				),
			).toEqual([
				"documents.id: column is neither exported nor in NAMED_OMISSIONS",
				"documents.new_col: column is neither exported nor in NAMED_OMISSIONS",
			]);
		});

		it("reports a new live column on plaid_items, read by its own statement", () => {
			expect(
				exportProblems(
					{ plaid_items: ["id", "institution_name", "status", "new_col"] },
					{ plaid_items: ["institution_name", "status"] },
					{ ...lists, ownStatement: ["plaid_items"] },
				),
			).toEqual([
				"plaid_items.id: column is neither exported nor in NAMED_OMISSIONS",
				"plaid_items.new_col: column is neither exported nor in NAMED_OMISSIONS",
			]);
		});

		it("reports a NOT_EXPORTED table that EXPORT_COLUMNS also exports", () => {
			expect(
				exportProblems(schema, exported, {
					...lists,
					notExported: { categories: "stale" },
				}),
			).toContain("categories: in NOT_EXPORTED but also in EXPORT_COLUMNS");
		});
	});
});

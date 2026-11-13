import { env } from "cloudflare:workers";
import { getTableName, is, SQL, sql } from "drizzle-orm";
import {
	type AnySQLiteColumn,
	getTableConfig,
	type Index,
	index,
	integer,
	primaryKey,
	type SQLiteColumn,
	SQLiteSyncDialect,
	SQLiteTable,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import * as schemaModule from "../src/db/schema";
import {
	accounts,
	BILL_FREQUENCY_VALUES,
	BILL_PAYMENT_MATCHED_BY_VALUES,
	BILL_PAYMENT_STATUS_VALUES,
	billAmounts,
	billPayments,
	bills,
	budgetAmounts,
	CATEGORY_SUGGESTION_STATUS_VALUES,
	CHECK_LISTS,
	categories,
	categoryArchivePeriods,
	categorySuggestions,
	householdPeople,
	MERCHANT_STATUS_VALUES,
	merchantSuggestedNames,
	merchants,
	plaidItems,
	savingsGoalAmounts,
	TRANSACTION_KIND_VALUES,
	transactions,
} from "../src/db/schema";

// The drift test: src/db/schema.ts (hand-written, see its top comment) must say what the live database says.
// It reads the live tables with PRAGMA and sqlite_master, so it runs in the Workers runtime against the migrated
// database. It compares columns, CHECK lists, indexes, foreign keys (target, ON UPDATE, ON DELETE) and the unique
// constraints a CREATE TABLE writes inline; and the set of application tables against the schema file.
// The described tables are the ones src/db/schema.ts exports (today: accounts, bill_amounts, bill_payments, bills,
// budget_amounts, categories, category_archive_periods, category_suggestions, household_people,
// merchant_suggested_names, merchants, plaid_items, savings_goal_amounts, transactions). Every other live application
// table is listed by name in NOT_YET_DESCRIBED below, with its reason, until a later PR describes it.

type Lists = Record<string, Record<string, readonly string[]>>;

/**
 * Application tables that src/db/schema.ts does not describe yet, each with its reason. The list can only shrink:
 * the table-set test fails when a name here is described already or is not in the database. The last PR for #963
 * empties it, and the check becomes "every live table is in the schema".
 */
const NOT_YET_DESCRIBED = {
	ai_log: "described in a later #963 PR",
	balance_history: "described in a later #963 PR",
	bank_text_rules: "described in a later #963 PR",
	cash_delete_holds: "described in a later #963 PR",
	documents: "described in a later #963 PR",
	feedback: "described in a later #963 PR",
	forgotten_texts: "described in a later #963 PR",
	household_members: "described in a later #963 PR",
	household_settings: "described in a later #963 PR",
	maybe_answers: "described in a later #963 PR",
	maybe_names: "described in a later #963 PR",
	merchant_name_failures: "described in a later #963 PR",
	never_suggest_rules: "described in a later #963 PR",
	planned_delete_holds: "described in a later #963 PR",
	planned_expenses: "described in a later #963 PR",
	push_subscriptions: "described in a later #963 PR",
} satisfies Record<string, string>;

interface LiveForeignKey {
	table: string;
	from: string;
	to: string;
	on_update: string;
	on_delete: string;
}

/** A foreign key as the drift test compares it: the target table and column, and both actions in SQLite's spelling. */
interface ForeignKeyTarget {
	table: string;
	column: string;
	onUpdate: string;
	onDelete: string;
}

interface LiveColumn {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

const dialect = new SQLiteSyncDialect();

/** Strips one pair of outer parentheses if they wrap the whole text, then one pair of single quotes. */
function unwrapDefault(value: string): string {
	let text = value.trim();

	if (wrapsWholeText(text, "(", ")")) text = text.slice(1, -1).trim();

	if (text.length >= 2 && text.startsWith("'") && text.endsWith("'"))
		text = text.slice(1, -1);

	return text;
}

/** True when the first `open` closes at the last `close`, so the pair wraps everything. */
function wrapsWholeText(text: string, open: string, close: string): boolean {
	if (!text.startsWith(open) || !text.endsWith(close)) return false;
	let depth = 0;

	for (let i = 0; i < text.length; i++) {
		if (text[i] === open) depth++;
		else if (text[i] === close) depth--;

		if (depth === 0) return i === text.length - 1;
	}

	return false;
}

/** The text an index expression or WHERE is compared as: lowercase, no quotes, no table qualifiers, one space. */
function normaliseSql(text: string): string {
	return text
		.replace(/["`'[\]]/g, "")
		.replace(/\b(merchants|category_suggestions)\./gi, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

/** A column's default as text, or null for none. Drizzle keeps a string or number as given and an sql`` as SQL. */
function schemaDefault(column: SQLiteColumn): string | null {
	const value: unknown = column.default;

	if (value === undefined || value === null) return null;

	if (isPlainDefault(value)) return unwrapDefault(String(value));

	if (value instanceof SQL) return unwrapDefault(dialect.sqlToQuery(value).sql);

	throw new Error("a column default is neither a plain value nor SQL");
}

function isPlainDefault(value: unknown): value is string | number {
	return typeof value === "string" || typeof value === "number";
}

/**
 * The CHECK value lists in a CREATE TABLE statement: `CHECK (col IN ('a', 'b'))` and `CHECK (col IN (0, 1))`, as text.
 * Only a column's own CHECK counts: a table-level CHECK that mentions `col IN (...)` inside a larger expression, or
 * a `NOT IN`, is not a value list for any column (bills has both).
 */
function liveChecks(createSql: string) {
	const found: [string, string[]][] = [];

	for (const match of createSql.matchAll(
		/CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)\s*\)/gi,
	)) {
		const column = match[1] ?? "";
		found.push([
			column,
			(match[2] ?? "")
				.split(",")
				.map((value) => value.trim().replace(/^'(.*)'$/, "$1")),
		]);
	}

	return Object.fromEntries(found);
}

interface LiveIndex {
	unique: boolean;
	expression: string;
	where: string | undefined;
}

/** Splits a CREATE INDEX statement into uniqueness, the indexed expression and the WHERE text. */
function parseLiveIndex(createSql: string): LiveIndex {
	const on = /\bON\s+\w+\s*\(/i.exec(createSql);

	if (!on) throw new Error(`cannot read index: ${createSql}`);
	const start = on.index + on[0].length;
	let depth = 1;
	let end = start;

	for (; end < createSql.length && depth > 0; end++) {
		if (createSql[end] === "(") depth++;
		else if (createSql[end] === ")") depth--;
	}

	const rest = createSql.slice(end);
	const where = /^\s*WHERE\s+([\s\S]*)$/i.exec(rest);

	return {
		unique: /^\s*CREATE\s+UNIQUE\s+INDEX/i.test(createSql),
		expression: createSql.slice(start, end - 1),
		where: where?.[1],
	};
}

/** The same shape for a Drizzle index, rendered the way SQLite writes it (bare column names). */
function schemaIndex(index: Index): LiveIndex {
	const { config } = index;

	return {
		unique: config.unique,
		expression: config.columns
			.map((column) => dialect.sqlToQuery(sql`${column}`, "indexes").sql)
			.join(", "),
		where: config.where
			? dialect.sqlToQuery(config.where, "indexes").sql
			: undefined,
	};
}

/** Everything the schema file claims that the live database does not back up. Empty means in step. */
async function drift(table: SQLiteTable, lists: Lists): Promise<string[]> {
	const config = getTableConfig(table);
	const tableName = config.name;
	const problems: string[] = [];

	const { results: live } = await env.DB.prepare(
		`PRAGMA table_info(${tableName})`,
	).all<LiveColumn>();

	const liveByName = new Map(live.map((column) => [column.name, column]));

	// A key of several columns is declared with primaryKey(), so its columns are not `primary` one by one.
	const keyColumns = new Set(
		config.primaryKeys.flatMap((key) =>
			key.columns.map((column) => column.name),
		),
	);

	for (const column of config.columns) {
		const where = `${tableName}.${column.name}`;
		const found = liveByName.get(column.name);

		if (!found) {
			problems.push(`${where} is not in the database`);
			continue;
		}

		const schemaType = column.getSQLType().toUpperCase();
		const liveType = found.type.toUpperCase();

		if (schemaType !== liveType)
			problems.push(
				`${where} type differs: schema ${schemaType}, database ${liveType}`,
			);

		// Drizzle's primaryKey() sets notNull in the model, but the migrations do not write NOT NULL on these keys
		// (SQLite reports notnull 0), so a primary key's not-null is not compared.
		if (!column.primary && column.notNull !== Boolean(found.notnull))
			problems.push(`${where} not-null differs`);
		const wantDefault = schemaDefault(column);

		const haveDefault =
			found.dflt_value === null ? null : unwrapDefault(found.dflt_value);

		if (wantDefault !== haveDefault)
			problems.push(
				`${where} default differs: schema ${wantDefault}, database ${haveDefault}`,
			);
		const isKey = column.primary || keyColumns.has(column.name);

		if (isKey !== Boolean(found.pk))
			problems.push(`${where} primary key differs`);
	}

	for (const name of liveByName.keys())
		if (!config.columns.some((column) => column.name === name))
			problems.push(
				`${tableName}.${name} is in the database, not in the schema`,
			);

	const { results: tableRow } = await env.DB.prepare(
		"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
	)
		.bind(tableName)
		.all<{ sql: string }>();

	const checks = liveChecks(tableRow[0]?.sql ?? "");
	const expected = lists[tableName] ?? {};

	for (const [column, values] of Object.entries(checks)) {
		const want = expected[column];

		if (!want)
			problems.push(
				`${tableName}.${column} has a CHECK in the database and no entry in CHECK_LISTS`,
			);
		else if (
			JSON.stringify([...values].sort()) !==
			JSON.stringify([...want].map(String).sort())
		)
			problems.push(
				`${tableName}.${column} CHECK differs: CHECK_LISTS ${[...want]}, database ${values}`,
			);
	}

	for (const column of Object.keys(expected))
		if (!(column in checks))
			problems.push(
				`CHECK_LISTS has ${tableName}.${column}, but the database has no such CHECK`,
			);

	const { results: indexes } = await env.DB.prepare(
		"SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
	)
		.bind(tableName)
		.all<{ name: string; sql: string }>();

	const liveIndexes = indexes.filter(
		(index) => !index.name.startsWith("sqlite_autoindex_"),
	);

	for (const live of liveIndexes) {
		const declared = config.indexes.find(
			(index) => index.config.name === live.name,
		);

		if (!declared) {
			problems.push(`index ${live.name} is in the database, not in the schema`);
			continue;
		}

		const want = schemaIndex(declared);
		const have = parseLiveIndex(live.sql);

		if (want.unique !== have.unique)
			problems.push(`index ${live.name} uniqueness differs`);

		if ((want.where !== undefined) !== (have.where !== undefined))
			problems.push(`index ${live.name} partial-ness differs`);

		if (normaliseSql(want.expression) !== normaliseSql(have.expression))
			problems.push(
				`index ${live.name} expression differs: schema ${want.expression}, database ${have.expression}`,
			);

		if (
			want.where !== undefined &&
			have.where !== undefined &&
			normaliseSql(want.where) !== normaliseSql(have.where)
		)
			problems.push(
				`index ${live.name} WHERE differs: schema ${want.where}, database ${have.where}`,
			);
	}

	for (const declared of config.indexes)
		if (!liveIndexes.some((live) => live.name === declared.config.name))
			problems.push(
				`index ${declared.config.name} is in the schema, not in the database`,
			);

	const wantForeignKeys = schemaForeignKeys(table);
	const haveForeignKeys = await liveForeignKeys(tableName);

	for (const [column, have] of haveForeignKeys) {
		const where = `${tableName}.${column}`;
		const want = wantForeignKeys.get(column);

		if (!want) {
			problems.push(
				`${where} is a foreign key in the database, not in the schema`,
			);
			continue;
		}

		if (want.table !== have.table || want.column !== have.column)
			problems.push(
				`${where} foreign key target differs: schema ${want.table}.${want.column}, database ${have.table}.${have.column}`,
			);

		if (want.onDelete !== have.onDelete)
			problems.push(
				`${where} ON DELETE differs: schema ${want.onDelete}, database ${have.onDelete}`,
			);

		if (want.onUpdate !== have.onUpdate)
			problems.push(
				`${where} ON UPDATE differs: schema ${want.onUpdate}, database ${have.onUpdate}`,
			);
	}

	for (const column of wantForeignKeys.keys())
		if (!haveForeignKeys.has(column))
			problems.push(
				`${tableName}.${column} is a foreign key in the schema, not in the database`,
			);

	const haveUniques = await liveUniqueConstraints(tableName);
	const wantUniques = schemaUniqueConstraints(table);

	for (const key of haveUniques)
		if (!wantUniques.includes(key))
			problems.push(
				`${tableName} unique constraint on (${key}) is in the database, not in the schema`,
			);

	for (const key of wantUniques)
		if (!haveUniques.includes(key))
			problems.push(
				`${tableName} unique constraint on (${key}) is in the schema, not in the database`,
			);

	return problems;
}

/**
 * The foreign keys a table declares (inline .references() or foreignKey()), keyed by child column. An action the
 * schema leaves out is NO ACTION, which is what SQLite assumes too.
 */
function schemaForeignKeys(table: SQLiteTable): Map<string, ForeignKeyTarget> {
	const keys = new Map<string, ForeignKeyTarget>();

	for (const foreignKey of getTableConfig(table).foreignKeys) {
		const { columns, foreignColumns, foreignTable } = foreignKey.reference();

		for (const [i, column] of columns.entries()) {
			keys.set(column.name, {
				table: getTableName(foreignTable),
				column: foreignColumns[i]?.name ?? "",
				onUpdate: (foreignKey.onUpdate ?? "no action").toUpperCase(),
				onDelete: (foreignKey.onDelete ?? "no action").toUpperCase(),
			});
		}
	}

	return keys;
}

/** The foreign keys SQLite reports for a live table, keyed by child column. */
async function liveForeignKeys(
	tableName: string,
): Promise<Map<string, ForeignKeyTarget>> {
	const { results } = await env.DB.prepare(
		`PRAGMA foreign_key_list(${tableName})`,
	).all<LiveForeignKey>();

	return new Map(
		results.map((row) => [
			row.from,
			{
				table: row.table,
				column: row.to,
				onUpdate: row.on_update,
				onDelete: row.on_delete,
			},
		]),
	);
}

/**
 * The unique constraints a table declares: .unique() on a column and unique() in the table config, as a sorted
 * list of column lists. Drizzle cannot say a collation, so a COLLATE NOCASE in the database is not compared.
 */
function schemaUniqueConstraints(table: SQLiteTable): string[] {
	const config = getTableConfig(table);
	const keys: string[] = [];

	for (const column of config.columns)
		if (column.isUnique) keys.push(column.name);

	for (const constraint of config.uniqueConstraints)
		keys.push(constraint.columns.map((column) => column.name).join(", "));

	return keys.sort();
}

/**
 * The unique constraints a CREATE TABLE writes inline, as SQLite lists them: automatic indexes with origin `u`.
 * Primary keys (origin `pk`) are not unique constraints and are left out, and explicit CREATE UNIQUE INDEX
 * statements (origin `c`) are compared as indexes above.
 */
async function liveUniqueConstraints(tableName: string): Promise<string[]> {
	const { results: indexes } = await env.DB.prepare(
		`PRAGMA index_list(${tableName})`,
	).all<{ name: string; origin: string }>();

	const keys: string[] = [];

	for (const live of indexes) {
		if (live.origin !== "u") continue;

		const { results: columns } = await env.DB.prepare(
			`PRAGMA index_info(${live.name})`,
		).all<{ name: string | null }>();

		keys.push(columns.map((column) => column.name ?? "").join(", "));
	}

	return keys.sort();
}

/** The tables src/db/schema.ts exports, found by type so no export list has to be kept in step. */
function schemaTables(): SQLiteTable[] {
	const values: unknown[] = Object.values(schemaModule);

	return values.filter((value): value is SQLiteTable => is(value, SQLiteTable));
}

/**
 * The table-set rule as a pure function of three lists: every live table is described or listed as not yet
 * described; a listed table is neither described nor missing from the database; a described table is in the database.
 */
function tableSetProblems(
	live: readonly string[],
	described: readonly string[],
	notYetDescribed: readonly string[],
): string[] {
	const problems: string[] = [];

	for (const name of live)
		if (!described.includes(name) && !notYetDescribed.includes(name))
			problems.push(
				`${name} is in the database, but neither src/db/schema.ts nor NOT_YET_DESCRIBED names it`,
			);

	for (const name of notYetDescribed) {
		if (described.includes(name))
			problems.push(
				`${name} is in NOT_YET_DESCRIBED, but src/db/schema.ts describes it`,
			);

		if (!live.includes(name))
			problems.push(
				`${name} is in NOT_YET_DESCRIBED, but the database has no such table`,
			);
	}

	for (const name of described)
		if (!live.includes(name))
			problems.push(
				`${name} is described in src/db/schema.ts, but the database has no such table`,
			);

	return problems;
}

async function appTableNames(): Promise<string[]> {
	const { results } = await env.DB.prepare(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
	).all<{ name: string }>();

	return results.map((row) => row.name);
}

describe("the schema file matches the live database", () => {
	it("merchants matches the live table", async () => {
		expect(await drift(merchants, CHECK_LISTS)).toEqual([]);
	});

	it("merchant_suggested_names matches the live table, its composite key included", async () => {
		expect(await drift(merchantSuggestedNames, CHECK_LISTS)).toEqual([]);
	});

	it("category_suggestions matches the live table, index included", async () => {
		expect(await drift(categorySuggestions, CHECK_LISTS)).toEqual([]);
	});

	it("categories matches the live table, its inline unique and both indexes included", async () => {
		expect(await drift(categories, CHECK_LISTS)).toEqual([]);
	});

	it("household_people matches the live table, its inline unique included", async () => {
		expect(await drift(householdPeople, CHECK_LISTS)).toEqual([]);
	});

	it("plaid_items matches the live table, its status and flag CHECKs included", async () => {
		expect(await drift(plaidItems, CHECK_LISTS)).toEqual([]);
	});

	it("accounts matches the live table, its foreign key, inline unique and partial indexes included", async () => {
		expect(await drift(accounts, CHECK_LISTS)).toEqual([]);
	});

	it("transactions matches the live table, its self-references, expression and partial indexes and CHECK lists included", async () => {
		expect(await drift(transactions, CHECK_LISTS)).toEqual([]);
	});

	it("bills matches the live table, its three IN lists and its CHECKs that are not IN lists left out", async () => {
		expect(await drift(bills, CHECK_LISTS)).toEqual([]);
	});

	it("bill_amounts matches the live table, its composite key and cascade foreign key included", async () => {
		expect(await drift(billAmounts, CHECK_LISTS)).toEqual([]);
	});

	it("bill_payments matches the live table, its partial index and two IN lists included", async () => {
		expect(await drift(billPayments, CHECK_LISTS)).toEqual([]);
	});

	it("budget_amounts matches the live table, its composite key and cascade foreign key included", async () => {
		expect(await drift(budgetAmounts, CHECK_LISTS)).toEqual([]);
	});

	it("savings_goal_amounts matches the live table, its inline unique included", async () => {
		expect(await drift(savingsGoalAmounts, CHECK_LISTS)).toEqual([]);
	});

	it("category_archive_periods matches the live table, its partial index included", async () => {
		expect(await drift(categoryArchivePeriods, CHECK_LISTS)).toEqual([]);
	});

	it("every live application table is described in the schema or listed as not yet described", async () => {
		const described = schemaTables().map((table) => getTableConfig(table).name);

		expect(
			tableSetProblems(
				await appTableNames(),
				described,
				Object.keys(NOT_YET_DESCRIBED),
			),
		).toEqual([]);
	});

	it("the CHECK value lists are read from the live CREATE TABLE and compared both ways", () => {
		// Sanity on the parser: quoted strings and bare numbers both come back as text.
		expect(
			liveChecks(
				"CREATE TABLE m (a TEXT CHECK (a IN ('x', 'y')), b INTEGER CHECK (b IN (0,1)))",
			),
		).toEqual({ a: ["x", "y"], b: ["0", "1"] });
	});

	it("reads a column's own IN list only, not a table-level CHECK or a NOT IN", () => {
		// The shape of bills: a table-level CHECK repeats `frequency IN (...)` and writes `NOT IN (...)`.
		expect(
			liveChecks(
				"CREATE TABLE bills (frequency TEXT NOT NULL CHECK (frequency IN ('monthly', 'yearly', 'weekly')), anchor_month INTEGER, CHECK ((frequency IN ('yearly', 'quarterly') AND anchor_month IS NOT NULL) OR (frequency NOT IN ('yearly', 'quarterly') AND anchor_month IS NULL)), CHECK (frequency NOT IN ('weekly', 'biweekly') OR due_day BETWEEN 1 AND 7))",
			),
		).toEqual({ frequency: ["monthly", "yearly", "weekly"] });
	});

	it("normalises defaults the way the drift check compares them", () => {
		expect(unwrapDefault("(CURRENT_TIMESTAMP)")).toBe("CURRENT_TIMESTAMP");
		expect(unwrapDefault("CURRENT_TIMESTAMP")).toBe("CURRENT_TIMESTAMP");
		expect(unwrapDefault("'none'")).toBe("none");
		expect(unwrapDefault("0")).toBe("0");
		// Only a pair that wraps the whole text is stripped.
		expect(unwrapDefault("(a) + (b)")).toBe("(a) + (b)");
	});

	it("reads the partial unique index's expression and WHERE from the live SQL", () => {
		expect(
			parseLiveIndex(
				"CREATE UNIQUE INDEX category_suggestions_pending_name ON category_suggestions(lower(name)) WHERE status = 'pending' AND name <> ''",
			),
		).toEqual({
			unique: true,
			expression: "lower(name)",
			where: "status = 'pending' AND name <> ''",
		});
	});
});

describe("the drift check fails on a wrong schema", () => {
	it("a column with the wrong SQLite type", async () => {
		const wrong = sqliteTable("category_suggestions", {
			id: integer().primaryKey({ autoIncrement: true }),
			name: text().notNull(),
			status: text({ enum: CATEGORY_SUGGESTION_STATUS_VALUES }).notNull(),
			createdAt: integer("created_at")
				.notNull()
				.default(sql`CURRENT_TIMESTAMP`),
			decidedAt: text("decided_at"),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"category_suggestions.created_at type differs",
		);
	});

	it("a column with an invented default", async () => {
		const wrong = sqliteTable("category_suggestions", {
			id: integer().primaryKey({ autoIncrement: true }),
			name: text().notNull(),
			status: text({ enum: CATEGORY_SUGGESTION_STATUS_VALUES }).notNull(),
			createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
			decidedAt: text("decided_at").default("never"),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"category_suggestions.decided_at default differs",
		);
	});

	it("a live column the schema leaves out", async () => {
		const wrong = sqliteTable("category_suggestions", {
			id: integer().primaryKey({ autoIncrement: true }),
			name: text().notNull(),
			status: text({ enum: CATEGORY_SUGGESTION_STATUS_VALUES }).notNull(),
			createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"category_suggestions.decided_at is in the database, not in the schema",
		);
	});

	it("a schema column the live table does not have", async () => {
		const wrong = sqliteTable("category_suggestions", {
			id: integer().primaryKey({ autoIncrement: true }),
			name: text().notNull(),
			status: text({ enum: CATEGORY_SUGGESTION_STATUS_VALUES }).notNull(),
			createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
			decidedAt: text("decided_at"),
			ghost: text(),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"category_suggestions.ghost is not in the database",
		);
	});

	// Primary keys and not-null. A primary key's not-null is not compared (see drift()): Drizzle's primaryKey() sets
	// notNull in the model although the migrations never write NOT NULL on the key, so only the non-key columns below
	// check it.

	it("a column the schema says is not the primary key, but the database says is", async () => {
		const wrong = sqliteTable("category_suggestions", {
			id: integer(), // the database: INTEGER PRIMARY KEY AUTOINCREMENT
			name: text().notNull(),
			status: text({ enum: CATEGORY_SUGGESTION_STATUS_VALUES }).notNull(),
			createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
			decidedAt: text("decided_at"),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"category_suggestions.id primary key differs",
		);
	});

	it("a primary key the database does not have", async () => {
		const wrong = sqliteTable("merchants", {
			rawName: text("raw_name"), // the database: TEXT PRIMARY KEY
			displayName: text("display_name"),
			defaultCategoryId: integer("default_category_id"),
			suggestionStatus: text("suggestion_status", {
				enum: MERCHANT_STATUS_VALUES,
			})
				.notNull()
				.default("none"),
			namesAsked: integer("names_asked").notNull().default(0),
			notABill: integer("not_a_bill").notNull().default(0),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"merchants.raw_name primary key differs",
		);
	});

	it("a column of a composite key the schema leaves out of the key", async () => {
		const wrong = sqliteTable("merchant_suggested_names", {
			merchantKey: text("merchant_key").notNull(), // the database: part of PRIMARY KEY (merchant_key, position)
			position: integer().notNull(),
			name: text().notNull(),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"merchant_suggested_names.merchant_key primary key differs",
		);
		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"merchant_suggested_names.position primary key differs",
		);
	});

	it("a non-key column the database has NOT NULL on, but the schema leaves nullable", async () => {
		const wrong = sqliteTable("category_suggestions", {
			id: integer().primaryKey({ autoIncrement: true }),
			name: text(), // the database: name TEXT NOT NULL
			status: text({ enum: CATEGORY_SUGGESTION_STATUS_VALUES }).notNull(),
			createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
			decidedAt: text("decided_at"),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"category_suggestions.name not-null differs",
		);
	});

	it("a non-key column the schema says NOT NULL, but the database leaves nullable", async () => {
		const wrong = sqliteTable("category_suggestions", {
			id: integer().primaryKey({ autoIncrement: true }),
			name: text().notNull(),
			status: text({ enum: CATEGORY_SUGGESTION_STATUS_VALUES }).notNull(),
			createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
			decidedAt: text("decided_at").notNull(), // the database: decided_at TEXT, nullable
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"category_suggestions.decided_at not-null differs",
		);
	});

	it("a wrong enum list", async () => {
		const lists = {
			...CHECK_LISTS,
			category_suggestions: { status: ["pending", "created", "dismissed"] },
		};

		expect((await drift(categorySuggestions, lists)).join("\n")).toContain(
			"category_suggestions.status CHECK differs",
		);
	});

	it("a live CHECK with no entry in CHECK_LISTS", async () => {
		const lists = { merchants: CHECK_LISTS.merchants };
		expect((await drift(categorySuggestions, lists)).join("\n")).toContain(
			"category_suggestions.status has a CHECK in the database and no entry in CHECK_LISTS",
		);
	});

	it("a CHECK_LISTS entry with no live CHECK", async () => {
		const lists = {
			...CHECK_LISTS,
			merchants: { ...CHECK_LISTS.merchants, ghost: ["x"] },
		};

		expect((await drift(merchants, lists)).join("\n")).toContain(
			"CHECK_LISTS has merchants.ghost, but the database has no such CHECK",
		);
	});

	it("a missing partial unique index", async () => {
		const wrong = sqliteTable("category_suggestions", {
			id: integer().primaryKey({ autoIncrement: true }),
			name: text().notNull(),
			status: text({ enum: CATEGORY_SUGGESTION_STATUS_VALUES }).notNull(),
			createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
			decidedAt: text("decided_at"),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"index category_suggestions_pending_name is in the database, not in the schema",
		);
	});

	it("an index with the wrong indexed expression", async () => {
		const wrong = sqliteTable(
			"category_suggestions",
			{
				id: integer().primaryKey({ autoIncrement: true }),
				name: text().notNull(),
				status: text({ enum: CATEGORY_SUGGESTION_STATUS_VALUES }).notNull(),
				createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
				decidedAt: text("decided_at"),
			},
			(t) => [
				uniqueIndex("category_suggestions_pending_name")
					.on(t.name)
					.where(sql`${t.status} = 'pending' AND ${t.name} <> ''`),
			],
		);

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"index category_suggestions_pending_name expression differs",
		);
	});

	it("an index with the wrong WHERE", async () => {
		const wrong = sqliteTable(
			"category_suggestions",
			{
				id: integer().primaryKey({ autoIncrement: true }),
				name: text().notNull(),
				status: text({ enum: CATEGORY_SUGGESTION_STATUS_VALUES }).notNull(),
				createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
				decidedAt: text("decided_at"),
			},
			(t) => [
				uniqueIndex("category_suggestions_pending_name")
					.on(sql`lower(${t.name})`)
					.where(sql`${t.status} = 'created' AND ${t.name} <> ''`),
			],
		);

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"index category_suggestions_pending_name WHERE differs",
		);
	});

	it("an index that is declared without UNIQUE", async () => {
		const wrong = sqliteTable(
			"category_suggestions",
			{
				id: integer().primaryKey({ autoIncrement: true }),
				name: text().notNull(),
				status: text({ enum: CATEGORY_SUGGESTION_STATUS_VALUES }).notNull(),
				createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
				decidedAt: text("decided_at"),
			},
			(t) => [
				index("category_suggestions_pending_name")
					.on(sql`lower(${t.name})`)
					.where(sql`${t.status} = 'pending' AND ${t.name} <> ''`),
			],
		);

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"index category_suggestions_pending_name uniqueness differs",
		);
	});
});

describe("the drift check fails on a wrong foreign key", () => {
	it("a foreign key the database has but the schema leaves out", async () => {
		const wrong = sqliteTable("merchants", {
			rawName: text("raw_name").primaryKey(),
			displayName: text("display_name"),
			defaultCategoryId: integer("default_category_id"), // the database: REFERENCES categories(id)
			suggestionStatus: text("suggestion_status", {
				enum: MERCHANT_STATUS_VALUES,
			})
				.notNull()
				.default("none"),
			namesAsked: integer("names_asked").notNull().default(0),
			notABill: integer("not_a_bill").notNull().default(0),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"merchants.default_category_id is a foreign key in the database, not in the schema",
		);
	});

	it("a foreign key the schema declares but the database does not have", async () => {
		const wrong = sqliteTable("merchants", {
			rawName: text("raw_name").primaryKey(),
			displayName: text("display_name").references(() => categories.id),
			defaultCategoryId: integer("default_category_id").references(
				() => categories.id,
				{ onDelete: "set null" },
			),
			suggestionStatus: text("suggestion_status", {
				enum: MERCHANT_STATUS_VALUES,
			})
				.notNull()
				.default("none"),
			namesAsked: integer("names_asked").notNull().default(0),
			notABill: integer("not_a_bill").notNull().default(0),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"merchants.display_name is a foreign key in the schema, not in the database",
		);
	});

	it("a foreign key that points at the wrong table", async () => {
		const wrong = sqliteTable("merchants", {
			rawName: text("raw_name").primaryKey(),
			displayName: text("display_name"),
			defaultCategoryId: integer("default_category_id").references(
				() => accounts.id,
				{ onDelete: "set null" },
			),
			suggestionStatus: text("suggestion_status", {
				enum: MERCHANT_STATUS_VALUES,
			})
				.notNull()
				.default("none"),
			namesAsked: integer("names_asked").notNull().default(0),
			notABill: integer("not_a_bill").notNull().default(0),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"merchants.default_category_id foreign key target differs: schema accounts.id, database categories.id",
		);
	});

	it("a foreign key with the wrong ON DELETE action", async () => {
		const wrong = sqliteTable("merchants", {
			rawName: text("raw_name").primaryKey(),
			displayName: text("display_name"),
			defaultCategoryId: integer("default_category_id").references(
				() => categories.id,
				{ onDelete: "cascade" },
			), // the database: ON DELETE SET NULL
			suggestionStatus: text("suggestion_status", {
				enum: MERCHANT_STATUS_VALUES,
			})
				.notNull()
				.default("none"),
			namesAsked: integer("names_asked").notNull().default(0),
			notABill: integer("not_a_bill").notNull().default(0),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"merchants.default_category_id ON DELETE differs: schema CASCADE, database SET NULL",
		);
	});

	it("a foreign key with the wrong ON UPDATE action", async () => {
		const wrong = sqliteTable("merchants", {
			rawName: text("raw_name").primaryKey(),
			displayName: text("display_name"),
			defaultCategoryId: integer("default_category_id").references(
				() => categories.id,
				{ onDelete: "set null", onUpdate: "cascade" },
			), // the database: ON UPDATE NO ACTION
			suggestionStatus: text("suggestion_status", {
				enum: MERCHANT_STATUS_VALUES,
			})
				.notNull()
				.default("none"),
			namesAsked: integer("names_asked").notNull().default(0),
			notABill: integer("not_a_bill").notNull().default(0),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"merchants.default_category_id ON UPDATE differs: schema CASCADE, database NO ACTION",
		);
	});

	it("a plaid_items status CHECK with a value the database does not allow", async () => {
		const lists = {
			...CHECK_LISTS,
			plaid_items: { ...CHECK_LISTS.plaid_items, status: ["ok", "broken"] },
		};

		expect((await drift(plaidItems, lists)).join("\n")).toContain(
			"plaid_items.status CHECK differs",
		);
	});
});

describe("the drift check fails on a wrong unique constraint", () => {
	it("a unique constraint the database has but the schema leaves out", async () => {
		const wrong = sqliteTable("household_people", {
			id: integer().primaryKey({ autoIncrement: true }),
			name: text().notNull(), // the database: UNIQUE COLLATE NOCASE
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"household_people unique constraint on (name) is in the database, not in the schema",
		);
	});

	it("a unique constraint the schema declares but the database does not have", async () => {
		const wrong = sqliteTable("merchants", {
			rawName: text("raw_name").primaryKey(),
			displayName: text("display_name").unique(), // the database: no UNIQUE here
			defaultCategoryId: integer("default_category_id").references(
				() => categories.id,
				{ onDelete: "set null" },
			),
			suggestionStatus: text("suggestion_status", {
				enum: MERCHANT_STATUS_VALUES,
			})
				.notNull()
				.default("none"),
			namesAsked: integer("names_asked").notNull().default(0),
			notABill: integer("not_a_bill").notNull().default(0),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"merchants unique constraint on (display_name) is in the schema, not in the database",
		);
	});

	it("a unique constraint on different columns", async () => {
		const wrong = sqliteTable(
			"accounts",
			{
				id: integer().primaryKey(),
				plaidItemId: integer("plaid_item_id").references(() => plaidItems.id),
				plaidAccountId: text("plaid_account_id"), // the database: UNIQUE here
				name: text().notNull().unique(), // the database: no UNIQUE here
				mask: text(),
				type: text().notNull(),
				subtype: text(),
				isLiability: integer("is_liability").notNull().default(0),
				balanceCents: integer("balance_cents").notNull().default(0),
				updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
				uploadedOn: text("uploaded_on"),
				balanceOn: text("balance_on"),
				removedAt: text("removed_at"),
				countedFrom: text("counted_from"),
			},
			(t) => [
				uniqueIndex("accounts_one_apple_card")
					.on(t.subtype)
					.where(sql`${t.subtype} = 'apple_card'`),
				uniqueIndex("accounts_one_cash")
					.on(t.type)
					.where(sql`${t.type} = 'cash'`),
			],
		);

		const problems = (await drift(wrong, CHECK_LISTS)).join("\n");
		expect(problems).toContain(
			"accounts unique constraint on (plaid_account_id) is in the database, not in the schema",
		);
		expect(problems).toContain(
			"accounts unique constraint on (name) is in the schema, not in the database",
		);
	});
});

describe("the drift check fails on a wrong transactions table", () => {
	it("a self-reference with the wrong ON DELETE", async () => {
		const wrong = sqliteTable("transactions", {
			id: integer().primaryKey(),
			parentId: integer("parent_id").references(
				(): AnySQLiteColumn => wrong.id,
				{ onDelete: "set null" },
			), // the database: ON DELETE CASCADE
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"transactions.parent_id ON DELETE differs: schema SET NULL, database CASCADE",
		);
	});

	it("one of the three categories foreign keys missing", async () => {
		const wrong = sqliteTable("transactions", {
			id: integer().primaryKey(),
			categoryId: integer("category_id").references(() => categories.id, {
				onDelete: "set null",
			}),
			jevCategoryId: integer("jev_category_id").references(
				() => categories.id,
				{ onDelete: "set null" },
			),
			jevAlsoCategoryId: integer("jev_also_category_id"), // the database: REFERENCES categories(id) ON DELETE SET NULL
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"transactions.jev_also_category_id is a foreign key in the database, not in the schema",
		);
	});

	it("the merchant-history index with a changed expression", async () => {
		const wrong = sqliteTable(
			"transactions",
			{
				id: integer().primaryKey(),
				merchantName: text("merchant_name"),
				rawName: text("raw_name").notNull(),
				date: text().notNull(),
			},
			(t) => [
				index("transactions_merchant_history").on(
					sql`COALESCE(${t.merchantName}, ${t.rawName}), ${t.date} DESC, ${t.id} DESC`,
				), // the database: COALESCE(NULLIF(merchant_name, ''), raw_name)
			],
		);

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"index transactions_merchant_history expression differs",
		);
	});

	it("the upload-twin unique index made non-partial", async () => {
		const wrong = sqliteTable(
			"transactions",
			{
				id: integer().primaryKey(),
				accountId: integer("account_id").notNull(),
				uploadKey: text("upload_key"),
				uploadTwin: integer("upload_twin"),
			},
			(t) => [
				uniqueIndex("transactions_upload_twin").on(
					t.accountId,
					t.uploadKey,
					t.uploadTwin,
				), // the database: WHERE upload_key IS NOT NULL
			],
		);

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"index transactions_upload_twin partial-ness differs",
		);
	});

	it("a *_VALUES list with an extra word", async () => {
		const lists = {
			...CHECK_LISTS,
			transactions: {
				...CHECK_LISTS.transactions,
				kind: [...TRANSACTION_KIND_VALUES, "gift"],
			},
		};

		expect((await drift(transactions, lists)).join("\n")).toContain(
			"transactions.kind CHECK differs",
		);
	});

	it("a REAL column declared as INTEGER", async () => {
		const wrong = sqliteTable("transactions", {
			id: integer().primaryKey(),
			categoryConfidence: integer("category_confidence"), // the database: REAL
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"transactions.category_confidence type differs: schema INTEGER, database REAL",
		);
	});
});

describe("the drift check fails on a wrong bills table", () => {
	it("a composite key the schema leaves out of the key, on bill_amounts", async () => {
		const wrong = sqliteTable("bill_amounts", {
			billId: integer("bill_id")
				.notNull()
				.references(() => bills.id, { onDelete: "cascade" }), // the database: part of PRIMARY KEY (bill_id, effective_month)
			effectiveMonth: text("effective_month").notNull(),
			amountCents: integer("amount_cents").notNull(),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"bill_amounts.bill_id primary key differs",
		);
	});

	it("a composite key the schema leaves out of the key, on budget_amounts", async () => {
		const wrong = sqliteTable("budget_amounts", {
			categoryId: integer("category_id")
				.notNull()
				.references(() => categories.id, { onDelete: "cascade" }), // the database: part of PRIMARY KEY (category_id, effective_month)
			effectiveMonth: text("effective_month").notNull(),
			amountCents: integer("amount_cents").notNull(),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"budget_amounts.category_id primary key differs",
		);
	});

	it("a CASCADE foreign key declared as SET NULL, on bill_amounts", async () => {
		const wrong = sqliteTable(
			"bill_amounts",
			{
				billId: integer("bill_id")
					.notNull()
					.references(() => bills.id, { onDelete: "set null" }), // the database: ON DELETE CASCADE
				effectiveMonth: text("effective_month").notNull(),
				amountCents: integer("amount_cents").notNull(),
			},
			(t) => [primaryKey({ columns: [t.billId, t.effectiveMonth] })],
		);

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"bill_amounts.bill_id ON DELETE differs: schema SET NULL, database CASCADE",
		);
	});

	it("a partial unique index made non-partial, on bill_payments", async () => {
		const wrong = sqliteTable(
			"bill_payments",
			{
				id: integer().primaryKey(),
				billId: integer("bill_id")
					.notNull()
					.references(() => bills.id, { onDelete: "cascade" }),
				period: text().notNull(),
				transactionId: integer("transaction_id")
					.notNull()
					.references(() => transactions.id, { onDelete: "cascade" }),
				matchedBy: text("matched_by", {
					enum: BILL_PAYMENT_MATCHED_BY_VALUES,
				}).notNull(),
				status: text({ enum: BILL_PAYMENT_STATUS_VALUES }).notNull(),
				createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
				undoToken: text("undo_token"),
			},
			(t) => [
				uniqueIndex("bill_payments_one_bill_per_transaction").on(
					t.transactionId,
				), // the database: WHERE status = 'linked'
			],
		);

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"index bill_payments_one_bill_per_transaction partial-ness differs",
		);
	});

	it("a savings goal month without the inline unique", async () => {
		const wrong = sqliteTable("savings_goal_amounts", {
			effectiveMonth: text("effective_month").notNull(), // the database: UNIQUE (effective_month)
			amountCents: integer("amount_cents").notNull(),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"savings_goal_amounts unique constraint on (effective_month) is in the database, not in the schema",
		);
	});

	it("a bills frequency list with an extra word", async () => {
		const lists = {
			...CHECK_LISTS,
			bills: {
				...CHECK_LISTS.bills,
				frequency: [...BILL_FREQUENCY_VALUES, "daily"],
			},
		};

		expect((await drift(bills, lists)).join("\n")).toContain(
			"bills.frequency CHECK differs",
		);
	});

	it("a bill payment's transaction_id without its foreign key", async () => {
		const wrong = sqliteTable("bill_payments", {
			id: integer().primaryKey(),
			billId: integer("bill_id")
				.notNull()
				.references(() => bills.id, { onDelete: "cascade" }),
			period: text().notNull(),
			transactionId: integer("transaction_id").notNull(), // the database: REFERENCES transactions(id) ON DELETE CASCADE
			matchedBy: text("matched_by", {
				enum: BILL_PAYMENT_MATCHED_BY_VALUES,
			}).notNull(),
			status: text({ enum: BILL_PAYMENT_STATUS_VALUES }).notNull(),
			createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
			undoToken: text("undo_token"),
		});

		expect((await drift(wrong, CHECK_LISTS)).join("\n")).toContain(
			"bill_payments.transaction_id is a foreign key in the database, not in the schema",
		);
	});
});

describe("the table-set check fails on a wrong list", () => {
	const described = ["a"];

	it("a live table in neither the schema nor the not-yet list", () => {
		expect(tableSetProblems(["a", "b"], described, [])).toEqual([
			"b is in the database, but neither src/db/schema.ts nor NOT_YET_DESCRIBED names it",
		]);
	});

	it("a not-yet-described name that is not in the database", () => {
		expect(tableSetProblems(["a"], described, ["gone"])).toEqual([
			"gone is in NOT_YET_DESCRIBED, but the database has no such table",
		]);
	});

	it("a described table still listed as not yet described", () => {
		expect(tableSetProblems(["a"], described, ["a"])).toEqual([
			"a is in NOT_YET_DESCRIBED, but src/db/schema.ts describes it",
		]);
	});

	it("a described table that is not in the database", () => {
		expect(tableSetProblems([], described, [])).toEqual([
			"a is described in src/db/schema.ts, but the database has no such table",
		]);
	});

	it("passes when every live table is described or listed", () => {
		expect(tableSetProblems(["a", "b"], described, ["b"])).toEqual([]);
	});

	it("the exports the drift test enumerates are the described tables only", () => {
		expect(
			schemaTables()
				.map((table) => getTableConfig(table).name)
				.sort(),
		).toEqual([
			"accounts",
			"bill_amounts",
			"bill_payments",
			"bills",
			"budget_amounts",
			"categories",
			"category_archive_periods",
			"category_suggestions",
			"household_people",
			"merchant_suggested_names",
			"merchants",
			"plaid_items",
			"savings_goal_amounts",
			"transactions",
		]);
	});
});

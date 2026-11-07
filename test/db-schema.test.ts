import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import {
	getTableConfig,
	type Index,
	index,
	integer,
	type SQLiteColumn,
	SQLiteSyncDialect,
	type SQLiteTable,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import {
	CATEGORY_SUGGESTION_STATUS_VALUES,
	CHECK_LISTS,
	categorySuggestions,
	MERCHANT_STATUS_VALUES,
	merchantSuggestedNames,
	merchants,
} from "../src/db/schema";

// The drift test: src/db/schema.ts (hand-written, see its top comment) must say what the live database says.
// It reads the live tables with PRAGMA table_info and sqlite_master, so it runs in the Workers runtime against the
// migrated database. Foreign keys are not described or compared yet.

type Lists = Record<string, Record<string, readonly string[]>>;

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
	if (typeof value === "string" || typeof value === "number")
		return unwrapDefault(String(value));
	return unwrapDefault(dialect.sqlToQuery(value as never).sql);
}

/** The CHECK value lists in a CREATE TABLE statement: `col IN ('a', 'b')` and `col IN (0, 1)`, as text. */
function liveChecks(createSql: string): Record<string, string[]> {
	const found: Record<string, string[]> = {};
	for (const match of createSql.matchAll(/\b(\w+)\s+IN\s*\(([^)]*)\)/gi)) {
		const column = match[1] ?? "";
		found[column] = (match[2] ?? "")
			.split(",")
			.map((value) => value.trim().replace(/^'(.*)'$/, "$1"));
	}
	return found;
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

	return problems;
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

	it("the CHECK value lists are read from the live CREATE TABLE and compared both ways", () => {
		// Sanity on the parser: quoted strings and bare numbers both come back as text.
		expect(
			liveChecks(
				"CREATE TABLE m (a TEXT CHECK (a IN ('x', 'y')), b INTEGER CHECK (b IN (0,1)))",
			),
		).toEqual({ a: ["x", "y"], b: ["0", "1"] });
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

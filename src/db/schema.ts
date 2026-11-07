// Hand-kept Drizzle description of three tables: `merchants`, `merchant_suggested_names` and `category_suggestions`. The migrations in
// migrations/*.sql are the only thing that changes the database; this file is written to match them, and
// test/db-schema.test.ts fails when they disagree (columns, SQLite types, not-null, defaults, primary keys, CHECK
// value lists, and indexes, including unique and partial).
//
// The CHECK value lists are CHECK_LISTS at the bottom of this file: the drift test compares them both ways with the
// live CREATE TABLE statements, so they are the verified record. No CHECK() is declared here, because nothing
// compares those to the database and they could drift silently.
//
// Not described or compared yet: foreign keys (merchants.default_category_id references categories). Nothing here
// uses .references(), and the drift test does not look at foreign keys.
import { sql } from "drizzle-orm";
import {
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** merchants.suggestion_status: the CHECK in migrations/0001_initial_schema.sql. */
export const MERCHANT_STATUS_VALUES = [
	"none",
	"pending",
	"accepted",
	"rejected",
] as const;

/** category_suggestions.status: the CHECK in migrations/0024_category_suggestions.sql. */
export const CATEGORY_SUGGESTION_STATUS_VALUES = [
	"pending",
	"created",
	"dismissed",
	"none",
] as const;

export const merchants = sqliteTable("merchants", {
	rawName: text("raw_name").primaryKey(),
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

/** A merchant's suggested names, one row per name, by position (migrations/0071_merchant_suggested_names.sql). */
export const merchantSuggestedNames = sqliteTable(
	"merchant_suggested_names",
	{
		merchantKey: text("merchant_key").notNull(),
		position: integer("position").notNull(),
		name: text("name").notNull(),
	},
	(t) => [primaryKey({ columns: [t.merchantKey, t.position] })],
);

export const categorySuggestions = sqliteTable(
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
			.where(sql`${t.status} = 'pending' AND ${t.name} <> ''`),
	],
);

/**
 * Every `col IN (...)` CHECK the two tables have in the live database, by table and column, as text. The drift test
 * reads each one from the live CREATE TABLE and compares it both ways with this list.
 */
export const CHECK_LISTS = {
	merchants: {
		suggestion_status: MERCHANT_STATUS_VALUES,
		not_a_bill: ["0", "1"],
		names_asked: ["0", "1"],
	},
	merchant_suggested_names: {
		position: ["0", "1", "2"],
	},
	category_suggestions: {
		status: CATEGORY_SUGGESTION_STATUS_VALUES,
	},
} as const;

export type MerchantRow = typeof merchants.$inferSelect;
export type CategorySuggestionRow = typeof categorySuggestions.$inferSelect;

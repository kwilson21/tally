// Hand-kept Drizzle description of two tables: `merchants` and `category_suggestions`. The migrations in
// migrations/*.sql are the only thing that changes the database; this file is written to match them, and
// test/db-schema.test.ts fails when they disagree (columns, SQLite types, not-null, defaults, primary keys, CHECK
// value lists, and indexes, including unique and partial). The CHECK() calls below are documentation only.
//
// Not described or compared yet: foreign keys (merchants.default_category_id references categories). Nothing here
// uses .references(), and the drift test does not look at foreign keys.
import { sql } from "drizzle-orm";
import {
	check,
	integer,
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

export const merchants = sqliteTable(
	"merchants",
	{
		rawName: text("raw_name").primaryKey(),
		suggestedName: text("suggested_name"),
		displayName: text("display_name"),
		defaultCategoryId: integer("default_category_id"),
		suggestionStatus: text("suggestion_status", {
			enum: MERCHANT_STATUS_VALUES,
		})
			.notNull()
			.default("none"),
		notABill: integer("not_a_bill").notNull().default(0),
	},
	(t) => [
		check(
			"merchants_suggestion_status",
			sql`${t.suggestionStatus} IN ('none', 'pending', 'accepted', 'rejected')`,
		),
		check("merchants_not_a_bill", sql`${t.notABill} IN (0, 1)`),
	],
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
		check(
			"category_suggestions_status",
			sql`${t.status} IN ('pending', 'created', 'dismissed', 'none')`,
		),
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
	},
	category_suggestions: {
		status: CATEGORY_SUGGESTION_STATUS_VALUES,
	},
} as const;

export type MerchantRow = typeof merchants.$inferSelect;
export type CategorySuggestionRow = typeof categorySuggestions.$inferSelect;

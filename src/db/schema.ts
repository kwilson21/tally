// Hand-kept Drizzle description of the application's tables, one table at a time (decision 213). The migrations in
// migrations/*.sql are the only thing that changes the database; this file is written to match them, and
// test/db-schema.test.ts fails when they disagree: columns, SQLite types, not-null, defaults, primary keys, CHECK
// value lists, indexes (unique and partial), foreign keys (target, ON UPDATE and ON DELETE), and the unique
// constraints a CREATE TABLE writes inline. The same test fails when a live application table is not described here
// and not listed in its NOT_YET_DESCRIBED.
//
// The CHECK value lists are CHECK_LISTS at the bottom of this file: the drift test compares them both ways with the
// live CREATE TABLE statements, so they are the verified record. No CHECK() is declared here, because nothing
// compares those to the database and they could drift silently.
import { sql } from "drizzle-orm";
import {
	blob,
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

/** plaid_items.status: the CHECK in migrations/0001_initial_schema.sql. */
export const PLAID_ITEM_STATUS_VALUES = ["ok", "needs_attention"] as const;

/** A category. name is unique in two ways: a case-sensitive UNIQUE written inline, and a NOCASE index. */
export const categories = sqliteTable(
	"categories",
	{
		id: integer().primaryKey(),
		name: text().notNull().unique(),
		icon: text().notNull(),
		color: text().notNull(),
		sortOrder: integer("sort_order").notNull().default(0),
		archived: integer().notNull().default(0),
		archivedOn: text("archived_on"),
		nameKey: text("name_key"),
	},
	(t) => [
		uniqueIndex("categories_name_key").on(t.nameKey),
		// An index column takes no collation option in Drizzle, so COLLATE NOCASE is written as SQL.
		uniqueIndex("categories_name_nocase").on(sql`${t.name} COLLATE NOCASE`),
	],
);

/**
 * A name in the household. The migration declares it UNIQUE COLLATE NOCASE; Drizzle cannot say a collation on a
 * unique column, so the drift test compares the column list only. The id is AUTOINCREMENT in the database, which
 * PRAGMA table_info does not report, so that part is not compared.
 */
export const householdPeople = sqliteTable("household_people", {
	id: integer().primaryKey({ autoIncrement: true }),
	name: text().notNull().unique(),
});

/** A bank connection (Plaid item). The access token is stored in access_token_encrypted as a BLOB. */
export const plaidItems = sqliteTable(
	"plaid_items",
	{
		id: integer().primaryKey(),
		accessTokenEncrypted: blob("access_token_encrypted").notNull(),
		institutionName: text("institution_name").notNull(),
		syncCursor: text("sync_cursor"),
		status: text({ enum: PLAID_ITEM_STATUS_VALUES }).notNull().default("ok"),
		linkedBy: text("linked_by").notNull(),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
		plaidItemId: text("plaid_item_id"),
		syncLockedUntil: text("sync_locked_until"),
		syncLockId: text("sync_lock_id"),
		lastSyncedAt: text("last_synced_at"),
		lastSyncAttemptAt: text("last_sync_attempt_at"),
		disconnectedAt: text("disconnected_at"),
		reconnectEmailedAt: text("reconnect_emailed_at"),
		historyCompleteAt: text("history_complete_at"),
		attentionLogin: integer("attention_login").notNull().default(0),
		attentionHeld: integer("attention_held").notNull().default(0),
		connectionRevision: integer("connection_revision").notNull().default(0),
	},
	(t) => [uniqueIndex("plaid_items_plaid_item_id").on(t.plaidItemId)],
);

/** A bank or card account, or cash. */
export const accounts = sqliteTable(
	"accounts",
	{
		id: integer().primaryKey(),
		plaidItemId: integer("plaid_item_id").references(() => plaidItems.id),
		plaidAccountId: text("plaid_account_id").unique(),
		name: text().notNull(),
		mask: text(),
		type: text().notNull(),
		subtype: text(),
		isLiability: integer("is_liability").notNull().default(0),
		// The migration's CHECK here is (typeof(balance_cents) = 'integer'), not an IN list, so the drift test does not
		// read it. Reading it would mean parsing CHECK text in general; that is a follow-up, not part of this check.
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
		uniqueIndex("accounts_one_cash").on(t.type).where(sql`${t.type} = 'cash'`),
	],
);

export const merchants = sqliteTable("merchants", {
	rawName: text("raw_name").primaryKey(),
	displayName: text("display_name"),
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
 * Every `col IN (...)` CHECK the described tables have in the live database, by table and column, as text. The drift
 * test reads each one from the live CREATE TABLE and compares it both ways with this list.
 */
export const CHECK_LISTS = {
	categories: {
		archived: ["0", "1"],
	},
	plaid_items: {
		status: PLAID_ITEM_STATUS_VALUES,
		attention_login: ["0", "1"],
		attention_held: ["0", "1"],
	},
	accounts: {
		is_liability: ["0", "1"],
	},
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

// Hand-kept Drizzle description of the application's tables, one table at a time (decision 213). The migrations in
// migrations/*.sql are the only thing that changes the database; this file is written to match them, and
// test/db-schema.test.ts fails when they disagree: columns, SQLite types, not-null, defaults, primary keys, CHECK
// value lists, indexes (unique and partial), foreign keys (target, ON UPDATE and ON DELETE), and the unique
// constraints a CREATE TABLE writes inline. The same test fails for any live application table this file does not
// describe.
//
// The CHECK value lists are CHECK_LISTS at the bottom of this file: the drift test compares them both ways with the
// live CREATE TABLE statements, so they are the verified record. No CHECK() is declared here, because nothing
// compares those to the database and they could drift silently.
import { sql } from "drizzle-orm";
import {
	type AnySQLiteColumn,
	blob,
	index,
	integer,
	primaryKey,
	real,
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
		syncUpdateCursor: text("sync_update_cursor"),
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
	startedBySync: text("started_by_sync"),
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

/** transactions.category_source: the CHECK in migrations/0026_bill_category.sql (0001 wrote it, 0026 added 'bill'). */
export const TRANSACTION_CATEGORY_SOURCE_VALUES = [
	"user",
	"merchant_rule",
	"jev",
	"bill",
] as const;

/**
 * transactions.excluded_source: the CHECK in migrations/0017_merchant_name_pending.sql (0004 wrote it, 0017 added
 * 'plaid'; 0026 rebuilt the table with the same list).
 */
export const TRANSACTION_EXCLUDED_SOURCE_VALUES = [
	"user",
	"jev",
	"plaid",
] as const;

/** transactions.income_source: the CHECK in migrations/0016_income_source.sql (kept by 0017 and 0026). */
export const TRANSACTION_INCOME_SOURCE_VALUES = ["user", "jev"] as const;

/** transactions.credit_reviewed_by: the CHECK in migrations/0016_income_source.sql (kept by 0017 and 0026). */
export const TRANSACTION_CREDIT_REVIEWED_BY_VALUES = ["user"] as const;

/** transactions.kind: the CHECK in migrations/0030_transaction_details.sql. */
export const TRANSACTION_KIND_VALUES = [
	"subscription",
	"one_off",
	"bill",
	"transfer",
] as const;

/** transactions.note_state: the CHECK in migrations/0068_note_state.sql. */
export const TRANSACTION_NOTE_STATE_VALUES = [
	"unasked",
	"unanswered",
	"no_call",
	"queued",
	"failed",
	"tried_empty",
	"emptied_by_person",
	"guessed",
	"written",
	"dismissed",
] as const;

/**
 * A bank transaction, a split part of one, or a refund's link to its purchase. 59 columns, grouped below by what they
 * are for. Nothing is renamed: each column is the database's name, and each group is a reading aid only.
 */
export const transactions = sqliteTable(
	"transactions",
	{
		// Identity and bank fields: what the bank sent, and the row's own id.
		id: integer().primaryKey(),
		plaidTransactionId: text("plaid_transaction_id").unique(),
		accountId: integer("account_id")
			.notNull()
			.references(() => accounts.id),
		// The migration's CHECK here is (date GLOB 'YYYY-MM-DD'), not an IN list, so the drift test does not read it.
		date: text().notNull(),
		// The migration's CHECK here is (typeof(amount_cents) = 'integer'), not an IN list, so the drift test does not
		// read it.
		amountCents: integer("amount_cents").notNull(),
		rawName: text("raw_name").notNull(),
		merchantName: text("merchant_name"),
		pending: integer().notNull().default(0),
		plaidCategory: text("plaid_category"),
		plaidDetailedCategory: text("plaid_detailed_category"),
		appleCategory: text("apple_category"),
		entryKey: text("entry_key"),
		ownName: text("own_name"),

		// Categorisation and Jev fields: which category a row has, where it came from, and Jev's attempts at it.
		categoryId: integer("category_id").references(() => categories.id, {
			onDelete: "set null",
		}),
		categorySource: text("category_source", {
			enum: TRANSACTION_CATEGORY_SOURCE_VALUES,
		}),
		categoryConfidence: real("category_confidence"),
		categorySuggestionId: integer("category_suggestion_id").references(
			() => categorySuggestions.id,
		),
		jevCategoryId: integer("jev_category_id").references(() => categories.id, {
			onDelete: "set null",
		}),
		jevAlsoCategoryId: integer("jev_also_category_id").references(
			() => categories.id,
			{ onDelete: "set null" },
		),
		jevMixed: real("jev_mixed"),
		jevFailedAt: text("jev_failed_at"),
		jevAttempts: integer("jev_attempts").notNull().default(0),
		jevNoneFit: integer("jev_none_fit").notNull().default(0),
		updatedBy: text("updated_by"),
		updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),

		// Flags and the sources of them: transfers, reimbursements, income, exclusions and the credit review.
		flagTransfer: integer("flag_transfer").notNull().default(0),
		flagReimbursement: integer("flag_reimbursement").notNull().default(0),
		flagIncome: integer("flag_income").notNull().default(0),
		excluded: integer().notNull().default(0),
		excludedSource: text("excluded_source", {
			enum: TRANSACTION_EXCLUDED_SOURCE_VALUES,
		}),
		incomeSource: text("income_source", {
			enum: TRANSACTION_INCOME_SOURCE_VALUES,
		}),
		// The migration's CHECK here is (income_confidence IS NULL OR ... BETWEEN 0 AND 1), not an IN list, so the drift
		// test does not read it.
		incomeConfidence: real("income_confidence"),
		incomeMaybeDeclined: integer("income_maybe_declined").notNull().default(0),
		// The migration's CHECK here is (transfer_confidence IS NULL OR ... BETWEEN 0 AND 1), not an IN list, so the
		// drift test does not read it.
		transferConfidence: real("transfer_confidence"),
		transferMaybeDeclined: integer("transfer_maybe_declined")
			.notNull()
			.default(0),
		creditReviewed: integer("credit_reviewed"),
		creditReviewedBy: text("credit_reviewed_by", {
			enum: TRANSACTION_CREDIT_REVIEWED_BY_VALUES,
		}),

		// Note, kind and for-person fields: the question asked about a row, and the answers and guesses behind it.
		note: text(),
		noteState: text("note_state", { enum: TRANSACTION_NOTE_STATE_VALUES })
			.notNull()
			.default("unasked"),
		noteGuessed: integer("note_guessed").notNull().default(0),
		noteTriedAt: text("note_tried_at"),
		noteFailedAt: text("note_failed_at"),
		noteDismissed: integer("note_dismissed").notNull().default(0),
		noteWorthWriting: integer("note_worth_writing"),
		detailsAsked: integer("details_asked").notNull().default(0),
		kind: text({ enum: TRANSACTION_KIND_VALUES }),
		kindGuessed: integer("kind_guessed").notNull().default(0),
		kindCleared: integer("kind_cleared").notNull().default(0),
		forPersonId: integer("for_person_id").references(() => householdPeople.id, {
			onDelete: "set null",
		}),
		forPersonGuessed: integer("for_person_guessed").notNull().default(0),
		forPersonCleared: integer("for_person_cleared").notNull().default(0),

		// Split and refund links: a split part points at its parent, a refund at the purchase it returns.
		isSplit: integer("is_split").notNull().default(0),
		parentId: integer("parent_id").references(
			(): AnySQLiteColumn => transactions.id,
			{ onDelete: "cascade" },
		),
		splitRemovedFromCents: integer("split_removed_from_cents"),
		splitRemovedBills: text("split_removed_bills"),
		refundOfId: integer("refund_of_id").references(
			(): AnySQLiteColumn => transactions.id,
			{ onDelete: "set null" },
		),
		refundUnlinkedPurchaseDate: text("refund_unlinked_purchase_date"),

		// Upload fields: the key and twin number that stop a file's rows being imported twice.
		uploadKey: text("upload_key"),
		uploadTwin: integer("upload_twin"),
	},
	(t) => [
		index("transactions_date").on(t.date),
		index("transactions_category").on(t.categoryId),
		index("transactions_raw_name").on(t.rawName),
		index("transactions_parent").on(t.parentId),
		index("transactions_refund_of_id_idx").on(t.refundOfId),
		index("transactions_category_suggestion_id").on(t.categorySuggestionId),
		uniqueIndex("transactions_entry_key")
			.on(t.entryKey)
			.where(sql`${t.entryKey} IS NOT NULL`),
		uniqueIndex("transactions_upload_twin")
			.on(t.accountId, t.uploadKey, t.uploadTwin)
			.where(sql`${t.uploadKey} IS NOT NULL`),
		// The merchant's history is keyed by its name, or the raw name when there is none (the empty string counts as none).
		index("transactions_merchant_history").on(
			sql`COALESCE(NULLIF(${t.merchantName}, ''), ${t.rawName}), ${t.date} DESC, ${t.id} DESC`,
		),
	],
);

/**
 * bills.frequency: the CHECK in migrations/0035_bill_cadence.sql (0001 wrote monthly and yearly; 0035 rebuilt the table
 * with the other three).
 */
export const BILL_FREQUENCY_VALUES = [
	"monthly",
	"yearly",
	"weekly",
	"biweekly",
	"quarterly",
] as const;

/**
 * bill_payments.matched_by: the CHECK in migrations/0035_bill_cadence.sql (0001 wrote it; 0017, 0026 and 0035 rebuilt
 * the table with the same list).
 */
export const BILL_PAYMENT_MATCHED_BY_VALUES = ["auto", "user"] as const;

/**
 * bill_payments.status: the CHECK in migrations/0035_bill_cadence.sql (0001 wrote it; 0017, 0026 and 0035 rebuilt the
 * table with the same list).
 */
export const BILL_PAYMENT_STATUS_VALUES = ["linked", "dismissed"] as const;

/**
 * A recurring bill, matched to bank transactions by its merchant. The table has 12 columns, grouped below by what they
 * are for. Its three table-level CHECKs (frequency against anchor_month and against anchor_date, and a weekly or
 * biweekly bill's due_day of 1 to 7) are not IN lists, so the drift test does not read them.
 */
export const bills = sqliteTable("bills", {
	// What the bill is, its amount, and when it falls due.
	id: integer().primaryKey(),
	name: text().notNull(),
	// The migration's CHECK here is (typeof(amount_cents) = 'integer' AND amount_cents > 0), not an IN list, so the drift
	// test does not read it.
	amountCents: integer("amount_cents").notNull(),
	// The migration's CHECK here is (due_day BETWEEN 1 AND 31), not an IN list, so the drift test does not read it.
	dueDay: integer("due_day").notNull(),
	frequency: text({ enum: BILL_FREQUENCY_VALUES }).notNull(),
	// The migration's CHECK here is (anchor_month BETWEEN 1 AND 12), not an IN list, so the drift test does not read it.
	anchorMonth: integer("anchor_month"),
	// The migration's CHECK here is (anchor_date IS NULL OR anchor_date GLOB 'YYYY-MM-DD'), not an IN list, so the drift
	// test does not read it.
	anchorDate: text("anchor_date"),

	// Where the bill is filed and how its merchant was known when it was saved.
	categoryId: integer("category_id").references(() => categories.id, {
		onDelete: "set null",
	}),
	merchantRawName: text("merchant_raw_name").notNull(),
	merchantRawText: integer("merchant_raw_text").notNull().default(0),

	// Whether the bill is still active, and the day it was added.
	active: integer().notNull().default(1),
	// The migration's CHECK here is (added_on IS NULL OR added_on GLOB 'YYYY-MM-DD'), not an IN list, so the drift test
	// does not read it.
	addedOn: text("added_on"),
});

/**
 * A bill's amount from a month on, one row per bill and month (migrations/0044_bill_amount_history.sql). The key is
 * (bill_id, effective_month), so both columns are NOT NULL and in the composite primary key.
 */
export const billAmounts = sqliteTable(
	"bill_amounts",
	{
		billId: integer("bill_id")
			.notNull()
			.references(() => bills.id, { onDelete: "cascade" }),
		// The migration's CHECK here is (effective_month GLOB 'YYYY-MM' AND the month is 01 to 12), not an IN list, so the
		// drift test does not read it.
		effectiveMonth: text("effective_month").notNull(),
		// The migration's CHECK here is (typeof(amount_cents) = 'integer' AND amount_cents > 0), not an IN list, so the
		// drift test does not read it.
		amountCents: integer("amount_cents").notNull(),
	},
	(t) => [primaryKey({ columns: [t.billId, t.effectiveMonth] })],
);

/**
 * A bill matched to one bank transaction in one period, or dismissed by a person ("Not this one"). At most one linked
 * row per transaction, by a partial unique index (migrations/0001_initial_schema.sql, rebuilt by 0035).
 */
export const billPayments = sqliteTable(
	"bill_payments",
	{
		id: integer().primaryKey(),
		billId: integer("bill_id")
			.notNull()
			.references(() => bills.id, { onDelete: "cascade" }),
		// The migration's CHECK here is four GLOB alternatives (YYYY, YYYY-MM, YYYY-MM-DD and YYYY-Qn), not an IN list, so
		// the drift test does not read it.
		period: text().notNull(),
		transactionId: integer("transaction_id")
			.notNull()
			.references(() => transactions.id, { onDelete: "cascade" }),
		matchedBy: text("matched_by", {
			enum: BILL_PAYMENT_MATCHED_BY_VALUES,
		}).notNull(),
		status: text({ enum: BILL_PAYMENT_STATUS_VALUES }).notNull(),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
		// The Undo token of a person's "Not this one" (migrations/0048_bill_payment_undo_token.sql).
		undoToken: text("undo_token"),
	},
	(t) => [
		uniqueIndex("bill_payments_one_bill_per_transaction")
			.on(t.transactionId)
			.where(sql`${t.status} = 'linked'`),
	],
);

/**
 * A category's budget from a month on, one row per category and month (migrations/0001_initial_schema.sql). The key is
 * (category_id, effective_month), so both columns are NOT NULL and in the composite primary key.
 */
export const budgetAmounts = sqliteTable(
	"budget_amounts",
	{
		categoryId: integer("category_id")
			.notNull()
			.references(() => categories.id, { onDelete: "cascade" }),
		// The migration's CHECK here is (effective_month GLOB 'YYYY-MM'), not an IN list, so the drift test does not read it.
		effectiveMonth: text("effective_month").notNull(),
		// The migration's CHECK here is (typeof(amount_cents) = 'integer' AND amount_cents >= 0), not an IN list, so the
		// drift test does not read it.
		amountCents: integer("amount_cents").notNull(),
	},
	(t) => [primaryKey({ columns: [t.categoryId, t.effectiveMonth] })],
);

/** The savings goal for each month, one row per month (migrations/0029_savings_goal_amounts.sql). */
export const savingsGoalAmounts = sqliteTable("savings_goal_amounts", {
	// The migration's CHECK here is (effective_month GLOB 'YYYY-MM' AND the month is 01 to 12), not an IN list, so the
	// drift test does not read it. The month is unique: the migration's table-level UNIQUE is written here as .unique().
	effectiveMonth: text("effective_month").notNull().unique(),
	// The migration's CHECK here is (amount_cents >= 0 AND typeof(amount_cents) = 'integer'), not an IN list, so the
	// drift test does not read it.
	amountCents: integer("amount_cents").notNull(),
});

/**
 * A span in which a category was archived. restored_on is NULL while the category is still archived, and at most one
 * open span per category is allowed by a partial unique index (migrations/0038_category_archive_periods.sql).
 */
export const categoryArchivePeriods = sqliteTable(
	"category_archive_periods",
	{
		id: integer().primaryKey(),
		categoryId: integer("category_id")
			.notNull()
			.references(() => categories.id, { onDelete: "cascade" }),
		archivedOn: text("archived_on").notNull(),
		restoredOn: text("restored_on"),
	},
	(t) => [
		uniqueIndex("category_archive_periods_open")
			.on(t.categoryId)
			.where(sql`${t.restoredOn} IS NULL`),
	],
);

/**
 * A one-off cost set aside in one month until a payment is linked to it (migrations/0053_planned_expenses.sql). A plan
 * has no category. Its transaction link is UNIQUE, and is cleared (SET NULL) when that transaction is deleted.
 */
export const plannedExpenses = sqliteTable("planned_expenses", {
	id: integer().primaryKey({ autoIncrement: true }),
	name: text().notNull(),
	// The migration's CHECK here is (amount_cents > 0), not an IN list, so the drift test does not read it.
	amountCents: integer("amount_cents").notNull(),
	// The migration's CHECK here is (month GLOB 'YYYY-MM'), not an IN list, so the drift test does not read it.
	month: text().notNull(),
	// The payment linked to the plan. One payment pays at most one plan.
	transactionId: integer("transaction_id")
		.unique()
		.references(() => transactions.id, { onDelete: "set null" }),
	// The email claim of who planned it (or 'demo').
	createdBy: text("created_by").notNull(),
});

/**
 * The undo hold for a deleted planned expense, kept for ten seconds so its Undo writes the plan back once
 * (migrations/0053_planned_expenses.sql). Holds older than that are pruned by each delete.
 */
export const plannedDeleteHolds = sqliteTable("planned_delete_holds", {
	// The undo token the toast carries.
	token: text().primaryKey(),
	// The server's clock in epoch milliseconds, for pruning.
	createdMs: integer("created_ms").notNull(),
	name: text().notNull(),
	amountCents: integer("amount_cents").notNull(),
	month: text().notNull(),
	// The payment the plan had. ON DELETE SET NULL, so a payment deleted inside the window is forgotten.
	transactionId: integer("transaction_id").references(() => transactions.id, {
		onDelete: "set null",
	}),
	// Whether the plan had a payment, so Undo can say it is no longer linked. The only IN list in this table.
	hadPayment: integer("had_payment").notNull().default(0),
	createdBy: text("created_by").notNull(),
});

/**
 * A cash entry's delete snapshot, kept so its Undo can restore it once from the toast
 * (migrations/0027_cash_delete_undo.sql, with plan_rows added later).
 */
export const cashDeleteHolds = sqliteTable("cash_delete_holds", {
	// The undo token the toast carries.
	token: text().primaryKey(),
	createdAt: integer("created_at").notNull(),
	displayName: text("display_name").notNull(),
	// The entry, its split parts, its payments and its refunds, as stored when it was deleted.
	transactionRow: text("transaction_row").notNull(),
	splitRows: text("split_rows").notNull(),
	paymentRows: text("payment_rows").notNull(),
	refundRows: text("refund_rows").notNull(),
	// Added by migrations/0031; NULL when the hold has none.
	restoreMarker: text("restore_marker"),
	// The planned expenses the entry paid, as JSON, so Undo can point each plan back at the restored row (migrations/0054).
	planRows: text("plan_rows").notNull().default("[]"),
});

/**
 * The name Workers AI gave a Maybe card's "New category" row, kept once for each transaction (migrations/0063_maybe_names.sql).
 * The row goes with its transaction (CASCADE).
 */
export const maybeNames = sqliteTable("maybe_names", {
	// The transaction the name was asked for. Its primary key, so one row per transaction.
	transactionId: integer("transaction_id")
		.primaryKey()
		.references(() => transactions.id, { onDelete: "cascade" }),
	// The name Tally suggested, or NULL for "no name" (so a transaction is never asked twice).
	name: text(),
	// A random token set when a request claims the transaction. Only the request holding it may finish the row.
	claim: text().notNull(),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	categoriesKey: text("categories_key"),
});

/**
 * A bank's balance on a day, one row per account and date (migrations/0001_initial_schema.sql). The key is
 * (account_id, date), so both columns are NOT NULL and in the composite primary key.
 */
export const balanceHistory = sqliteTable(
	"balance_history",
	{
		accountId: integer("account_id")
			.notNull()
			.references(() => accounts.id, { onDelete: "cascade" }),
		// The migration's CHECK here is (date GLOB 'YYYY-MM-DD'), not an IN list, so the drift test does not read it.
		date: text().notNull(),
		// The migration's CHECK here is (typeof(balance_cents) = 'integer'), not an IN list, so the drift test does not
		// read it.
		balanceCents: integer("balance_cents").notNull(),
	},
	(t) => [primaryKey({ columns: [t.accountId, t.date] })],
);

/**
 * A rule that files every transaction whose cleaned bank text matches in one category, before Jev is asked
 * (migrations/0065_bank_text_rules.sql). One rule per text.
 */
export const bankTextRules = sqliteTable("bank_text_rules", {
	// The row's own id.
	id: integer().primaryKey(),
	// The cleaned bank text the rule is for. One rule per text.
	cleanedText: text("cleaned_text").notNull().unique(),
	// The category the rule files a matching transaction in. Removing the category removes the rule.
	categoryId: integer("category_id")
		.notNull()
		.references(() => categories.id, { onDelete: "cascade" }),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

/**
 * A cleaned bank text the person forgot on the Settings page "What Tally has learned" (migrations/0064_forgotten_texts.sql).
 * One row per text.
 */
export const forgottenTexts = sqliteTable("forgotten_texts", {
	id: integer().primaryKey({ autoIncrement: true }),
	cleanedText: text("cleaned_text").notNull().unique(),
	// Only an answer changed after this brings the line back.
	forgottenAt: text("forgotten_at").notNull().default(sql`(datetime('now'))`),
	// The forgotten_at a second Forget replaced, so its Undo puts that back. NULL when the text was forgotten once.
	previousForgottenAt: text("previous_forgotten_at"),
	// The rule a Forget removed, so its Undo can put it back. NULL when the text had no rule.
	ruleCategoryId: integer("rule_category_id").references(() => categories.id, {
		onDelete: "set null",
	}),
});

/** ai_log.kind: the CHECK in migrations/0041_ai_log.sql. */
export const AI_LOG_KIND_VALUES = ["category", "income", "name"] as const;

/**
 * One row for each thing Tally's AI applied, for "What AI did" (migrations/0041_ai_log.sql). It holds no amounts. A
 * category or income row is one per transaction and kind; a name row is one per merchant.
 */
export const aiLog = sqliteTable(
	"ai_log",
	{
		id: integer().primaryKey(),
		kind: text({ enum: AI_LOG_KIND_VALUES }).notNull(),
		// The transaction, for category and income rows. Cleared when a bank correction clears Jev's category.
		transactionId: integer("transaction_id"),
		// The merchant's raw name, for name rows.
		merchantRawName: text("merchant_raw_name"),
		// The migration's CHECK here is (household_day GLOB 'YYYY-MM-DD'), not an IN list, so the drift test does not read it.
		householdDay: text("household_day").notNull(),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(t) => [
		index("ai_log_household_day").on(t.householdDay),
		uniqueIndex("ai_log_merchant_name")
			.on(t.merchantRawName)
			.where(sql`${t.kind} = 'name'`),
		uniqueIndex("ai_log_transaction_kind")
			.on(t.transactionId, t.kind)
			.where(sql`${t.transactionId} IS NOT NULL`),
	],
);

/**
 * A file a person uploaded: its key in R2, its name, its size and who uploaded it (migrations/0001_initial_schema.sql).
 */
export const documents = sqliteTable("documents", {
	id: integer().primaryKey(),
	r2Key: text("r2_key").notNull().unique(),
	filename: text().notNull(),
	// The migration's CHECK here is (size_bytes >= 0), not an IN list, so the drift test does not read it.
	sizeBytes: integer("size_bytes").notNull(),
	uploadedBy: text("uploaded_by").notNull(),
	uploadedAt: text("uploaded_at").notNull().default(sql`(datetime('now'))`),
	note: text(),
});

/**
 * A feedback report from the form, and its filing as a GitHub issue (migrations/0009_feedback.sql, with 0011 and 0036).
 * The row stays after it is filed; github_issue_number is set once GitHub has taken it. Its 16 columns, by what they
 * are for, are below.
 */
export const feedback = sqliteTable(
	"feedback",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		// When the report was sent.
		createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
		// Who sent it: the signed-in person's email, from the verified sign-in.
		actor: text().notNull(),
		// The kind the person picked on the form (Bug, Idea, Question or Other).
		type: text().notNull(),
		// The feeling the person picked on the form.
		feeling: text().notNull(),
		// What the person wrote.
		message: text().notNull(),
		// The page the form was opened from.
		page: text().notNull(),
		// The device and browser the form was sent from.
		device: text().notNull(),
		// The app version that was running when the report was sent.
		appVersion: text("app_version"),
		// The browser's diagnostics as JSON, from the feedback form's diagnostics (src/feedback/diagnostics.ts).
		clientContext: text("client_context"),
		// A session replay link. No code writes it today: replay links stay off (src/feedback/diagnostics.ts).
		replayUrl: text("replay_url"),
		// The GitHub issue number, once GitHub has taken the report. NULL until then.
		githubIssueNumber: integer("github_issue_number"),
		// When GitHub took the report.
		filedAt: text("filed_at"),
		// When a filing try claimed the report. Cleared when the try ends, so a stuck claim can be retried after ten minutes.
		filingAt: text("filing_at"),
		// How many filing tries have counted. A try that GitHub refuses over its token does not count.
		attempts: integer().notNull().default(0),
		// The HTTP status GitHub last answered the filing with.
		lastStatus: integer("last_status"),
	},
	(t) => [index("feedback_actor_created_at").on(t.actor, t.createdAt)],
);

/**
 * A person in the household, by email: when they were first and last seen, the session time their last sign-in was
 * issued, whether they were removed, and when their Home page last checked in (migrations/0018 and 0034, with 0059).
 */
export const householdMembers = sqliteTable("household_members", {
	email: text().primaryKey(),
	firstSeenAt: text("first_seen_at").notNull().default(sql`(datetime('now'))`),
	lastSeenAt: text("last_seen_at").notNull().default(sql`(datetime('now'))`),
	sessionIssuedAt: integer("session_issued_at").notNull().default(0),
	removedAt: text("removed_at"),
	homeSeenAt: text("home_seen_at"),
});

/** A household-wide setting, one row per key (migrations/0018_household_settings.sql). */
export const householdSettings = sqliteTable("household_settings", {
	key: text().primaryKey(),
	value: text().notNull(),
});

/** maybe_answers.kind: the CHECK in migrations/0062_maybe_answers.sql. */
export const MAYBE_ANSWER_KIND_VALUES = [
	"category",
	"income",
	"transfer",
] as const;

/** maybe_answers.answer: the CHECK in migrations/0062_maybe_answers.sql. */
export const MAYBE_ANSWER_ANSWER_VALUES = [
	"yes",
	"no",
	"something_else",
] as const;

/**
 * What a person answered to a "Maybe ..." question, for the record of how often Tally's guesses were right
 * (migrations/0062_maybe_answers.sql). It names no transaction, merchant or amount, on purpose.
 */
export const maybeAnswers = sqliteTable(
	"maybe_answers",
	{
		id: integer().primaryKey(),
		kind: text({ enum: MAYBE_ANSWER_KIND_VALUES }).notNull(),
		// The guess's stored confidence when the person answered.
		confidence: real().notNull(),
		answer: text({ enum: MAYBE_ANSWER_ANSWER_VALUES }).notNull(),
		// The migration's CHECK here is (household_day GLOB 'YYYY-MM-DD'), not an IN list, so the drift test does not read it.
		householdDay: text("household_day").notNull(),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(t) => [index("maybe_answers_household_day").on(t.householdDay)],
);

/**
 * When Workers AI last failed to name a bank text, so the names pass asks the failed ones after the never-tried ones
 * (migrations/0051_merchant_name_failures.sql). There is no foreign key, as a bank text often has no merchants row.
 */
export const merchantNameFailures = sqliteTable("merchant_name_failures", {
	rawName: text("raw_name").primaryKey(),
	failedAt: text("failed_at").notNull(),
});

/** never_suggest_rules.kind: the CHECK in migrations/0043_never_suggest_rules.sql. */
export const NEVER_SUGGEST_RULE_KIND_VALUES = [
	"new_category",
	"income",
	"transfer",
] as const;

/**
 * A "never suggest" rule: one suggestion a person said No to for a store, so Tally does not make it again until the
 * line is removed in Settings (migrations/0043_never_suggest_rules.sql). One rule per merchant key and kind.
 */
export const neverSuggestRules = sqliteTable(
	"never_suggest_rules",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		merchantKey: text("merchant_key").notNull(),
		kind: text({ enum: NEVER_SUGGEST_RULE_KIND_VALUES }).notNull(),
		// The household's day of the answer, which Settings shows ("You said No on Oct 3").
		decidedOn: text("decided_on").notNull(),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(t) => [uniqueIndex("never_suggest_rules_one").on(t.merchantKey, t.kind)],
);

/**
 * A device a person turned Web Push notifications on for (migrations/0060_push_subscriptions.sql). The endpoint is
 * unique, so a device that subscribes again replaces its row.
 */
export const pushSubscriptions = sqliteTable(
	"push_subscriptions",
	{
		id: integer().primaryKey(),
		memberEmail: text("member_email").notNull(),
		endpoint: text().notNull().unique(),
		// The subscription's keys (base64url, RFC 8291).
		p256dh: text().notNull(),
		auth: text().notNull(),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(t) => [index("push_subscriptions_member").on(t.memberEmail)],
);

/**
 * Every `col IN (...)` CHECK the described tables have in the live database, by table and column, as text. The drift
 * test reads each one from the live CREATE TABLE and compares it both ways with this list.
 */
export const CHECK_LISTS = {
	ai_log: {
		kind: AI_LOG_KIND_VALUES,
	},
	maybe_answers: {
		kind: MAYBE_ANSWER_KIND_VALUES,
		answer: MAYBE_ANSWER_ANSWER_VALUES,
	},
	never_suggest_rules: {
		kind: NEVER_SUGGEST_RULE_KIND_VALUES,
	},
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
	bills: {
		frequency: BILL_FREQUENCY_VALUES,
		merchant_raw_text: ["0", "1"],
		active: ["0", "1"],
	},
	bill_payments: {
		matched_by: BILL_PAYMENT_MATCHED_BY_VALUES,
		status: BILL_PAYMENT_STATUS_VALUES,
	},
	merchants: {
		suggestion_status: MERCHANT_STATUS_VALUES,
		not_a_bill: ["0", "1"],
		names_asked: ["0", "1"],
	},
	merchant_suggested_names: {
		position: ["0", "1", "2"],
	},
	planned_delete_holds: {
		had_payment: ["0", "1"],
	},
	category_suggestions: {
		status: CATEGORY_SUGGESTION_STATUS_VALUES,
	},
	transactions: {
		category_source: TRANSACTION_CATEGORY_SOURCE_VALUES,
		excluded_source: TRANSACTION_EXCLUDED_SOURCE_VALUES,
		income_source: TRANSACTION_INCOME_SOURCE_VALUES,
		credit_reviewed_by: TRANSACTION_CREDIT_REVIEWED_BY_VALUES,
		kind: TRANSACTION_KIND_VALUES,
		note_state: TRANSACTION_NOTE_STATE_VALUES,
		flag_transfer: ["0", "1"],
		flag_reimbursement: ["0", "1"],
		flag_income: ["0", "1"],
		excluded: ["0", "1"],
		is_split: ["0", "1"],
		credit_reviewed: ["0", "1"],
		note_worth_writing: ["0", "1"],
		pending: ["0", "1"],
		jev_none_fit: ["0", "1"],
		note_guessed: ["0", "1"],
		kind_guessed: ["0", "1"],
		for_person_guessed: ["0", "1"],
		details_asked: ["0", "1"],
		note_dismissed: ["0", "1"],
		kind_cleared: ["0", "1"],
		for_person_cleared: ["0", "1"],
		income_maybe_declined: ["0", "1"],
		transfer_maybe_declined: ["0", "1"],
	},
} as const;

export type MerchantRow = typeof merchants.$inferSelect;

export type CategorySuggestionRow = typeof categorySuggestions.$inferSelect;

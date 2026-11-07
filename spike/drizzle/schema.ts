// Spike: a hand-kept Drizzle description of three tables that already exist in migrations/*.sql.
// The migrations stay the source of truth; test/spike/drizzle.test.ts fails when this file and the live schema disagree.
// `transactions` started as `drizzle-kit pull` output and was then repaired by hand (see the report).
import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const SUGGESTION_STATUSES = ["pending", "created", "dismissed", "none"] as const;
export const MERCHANT_STATUSES = ["none", "pending", "accepted", "rejected"] as const;

export const categorySuggestions = sqliteTable(
	"category_suggestions",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		name: text().notNull(),
		status: text({ enum: SUGGESTION_STATUSES }).notNull(),
		createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
		decidedAt: text("decided_at"),
	},
	(t) => [
		check("category_suggestions_status", sql`${t.status} IN ('pending', 'created', 'dismissed', 'none')`),
		uniqueIndex("category_suggestions_pending_name")
			.on(sql`lower(${t.name})`)
			.where(sql`${t.status} = 'pending' AND ${t.name} <> ''`),
	],
);

export const merchants = sqliteTable(
	"merchants",
	{
		rawName: text("raw_name").primaryKey(),
		suggestedName: text("suggested_name"),
		displayName: text("display_name"),
		defaultCategoryId: integer("default_category_id"),
		suggestionStatus: text("suggestion_status", { enum: MERCHANT_STATUSES }).notNull().default("none"),
		notABill: integer("not_a_bill").notNull().default(0),
	},
	(t) => [
		check("merchants_suggestion_status", sql`${t.suggestionStatus} IN ('none', 'pending', 'accepted', 'rejected')`),
		check("merchants_not_a_bill", sql`${t.notABill} IN (0,1)`),
	],
);

export const transactions = sqliteTable("transactions", {
	id: integer().primaryKey(),
	plaidTransactionId: text("plaid_transaction_id"),
	accountId: integer("account_id").notNull(),
	date: text().notNull(),
	amountCents: integer("amount_cents").notNull(),
	rawName: text("raw_name").notNull(),
	categoryId: integer("category_id"),
	categorySource: text("category_source"),
	categoryConfidence: real("category_confidence"),
	flagTransfer: integer("flag_transfer").default(0).notNull(),
	flagReimbursement: integer("flag_reimbursement").default(0).notNull(),
	flagIncome: integer("flag_income").default(0).notNull(),
	excluded: integer().default(0).notNull(),
	parentId: integer("parent_id"),
	isSplit: integer("is_split").default(0).notNull(),
	note: text(),
	updatedBy: text("updated_by"),
	updatedAt: text("updated_at").default(sql`(datetime('now'))`).notNull(),
	jevCategoryId: integer("jev_category_id"),
	jevFailedAt: text("jev_failed_at"),
	excludedSource: text("excluded_source"),
	plaidCategory: text("plaid_category"),
	splitRemovedFromCents: integer("split_removed_from_cents"),
	refundOfId: integer("refund_of_id"),
	incomeSource: text("income_source"),
	creditReviewed: integer("credit_reviewed"),
	creditReviewedBy: text("credit_reviewed_by"),
	merchantName: text("merchant_name"),
	pending: integer().default(0).notNull(),
	entryKey: text("entry_key"),
	jevNoneFit: integer("jev_none_fit").default(0).notNull(),
	categorySuggestionId: integer("category_suggestion_id"),
	incomeConfidence: real("income_confidence"),
	transferConfidence: real("transfer_confidence"),
	kind: text(),
	forPersonId: integer("for_person_id"),
	noteGuessed: integer("note_guessed").default(0).notNull(),
	kindGuessed: integer("kind_guessed").default(0).notNull(),
	forPersonGuessed: integer("for_person_guessed").default(0).notNull(),
	detailsAsked: integer("details_asked").default(0).notNull(),
	noteTriedAt: text("note_tried_at"),
	noteDismissed: integer("note_dismissed").default(0).notNull(),
	refundUnlinkedPurchaseDate: text("refund_unlinked_purchase_date"),
	kindCleared: integer("kind_cleared").default(0).notNull(),
	forPersonCleared: integer("for_person_cleared").default(0).notNull(),
	ownName: text("own_name"),
	noteWorthWriting: integer("note_worth_writing"),
	incomeMaybeDeclined: integer("income_maybe_declined").default(0).notNull(),
	transferMaybeDeclined: integer("transfer_maybe_declined").default(0).notNull(),
	splitRemovedBills: text("split_removed_bills"),
	plaidDetailedCategory: text("plaid_detailed_category"),
	noteFailedAt: text("note_failed_at"),
	jevMixed: real("jev_mixed"),
	jevAlsoCategoryId: integer("jev_also_category_id"),
	appleCategory: text("apple_category"),
	uploadKey: text("upload_key"),
	uploadTwin: integer("upload_twin"),
	noteState: text("note_state").default("unasked").notNull(),
});

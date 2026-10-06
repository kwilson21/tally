// The demo's "Straight from the bank" list (spec §8.6, decision 79; P44 A): what the bank sent, with
// nothing Tally or a person decided. It only changes how a row is drawn; every number stays as it is.
import type { ListRow } from "../db/transactions";

/** The one muted line under the result count, naming what the raw list leaves out (decision 79: the demo's seed has a transfer to Savings, not a card payment). */
export const BANK_VIEW_NOTE =
	"No clean names or categories, and the transfer to Savings and the paycheck both count in Spent.";

/**
 * The row as the bank sends it: its own text, no category and no mark. Every row says Needs category,
 * the paycheck too, and the transfer and the paycheck look like spending, which is what the bank's
 * own data says. What is kept is what the bank sent: the date, the amount, the raw text and whether it
 * is still pending. A credit counts as reviewed so it reads Needs category, not Review credit.
 */
export function bankRow(row: ListRow): ListRow {
	return {
		id: row.id,
		date: row.date,
		amountCents: row.amountCents,
		rawName: row.rawName,
		displayName: row.rawName,
		note: null,
		excluded: false,
		income: false,
		creditReviewed: true,
		categoryId: null,
		categoryName: null,
		categoryIcon: null,
		categoryColor: null,
		pending: row.pending,
		nameSuggested: false,
	};
}

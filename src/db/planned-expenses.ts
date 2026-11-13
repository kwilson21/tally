/**
 * Planned one-time expenses (spec §5, §6, §8.4; decisions 74, 82 and 101): a known cost set aside in its month
 * until a payment is linked to it. A plan has no category; its payment keeps its own (decision 82).
 *
 * Every write here is one statement or one batch, so the never-both triggers (migration 0053) are the only guard
 * a link needs beyond these checks, and the link reports which one fired.
 */
import { tidyName } from "../transactions/tidy-name";
import { paysBillGroupSql, paysPlanGroupSql } from "./counted-month";
import { merchantColumnSql } from "./merchant-key";
import { ownNameSql } from "./own-name";

export type PlannedExpense = {
	id: number;
	name: string;
	amountCents: number;
	/** The month it is set aside in, `YYYY-MM`. */
	month: string;
	/** The payment linked to it, or null while it is still planned. */
	transactionId: number | null;
	/** The linked payment's date, name and amount, when it is paid. */
	paidDate: string | null;
	paidName: string | null;
	paidAmountCents: number | null;
};

/**
 * A payment a plan could be paid by, as a bill's picker lists one (decision 82): each one canPayPlanSql accepts, a split
 * part included (a split parent is not listed, since it is no longer one payment).
 */
export type PlanPaymentCandidate = {
	id: number;
	date: string;
	amountCents: number;
	displayName: string;
	excluded: boolean;
};

export type { PlanFields } from "../rules/plans";

const PAYER_NAME = `COALESCE(${ownNameSql("t")}, ${merchantColumnSql("t", "display_name")})`;

/**
 * The one rule that listing, linking and Undo all check (decision 82): money out, not split or income, in the plan's
 * month or the next, and paying neither a bill nor another plan. `alias` is the payment's table alias, `month` an SQL
 * expression for the plan's `YYYY-MM`. `exceptPlan` (an SQL expression for a plan id) is paysPlanGroupSql's: that plan's
 * own link doesn't count, so an edit of a paid plan can keep its payment. `splitOk` drops the not-split test, for re-checking
 * a link a plan already holds (sync, an edit, an Undo): a plan on the whole payment stays paid after the payment is split,
 * while the rest still fits (decision 82). A new link never takes a split parent, so linking and the picker keep it false.
 */
export const canPayPlanSql = (
	alias: string,
	month: string,
	exceptPlan?: string,
	splitOk = false,
) =>
	`(${alias}.amount_cents > 0 AND ${splitOk ? "" : `${alias}.is_split = 0 AND `}${alias}.flag_income = 0 AND substr(${alias}.date, 1, 7) IN (${month}, substr(date(${month} || '-01', '+1 month'), 1, 7)) AND NOT ${paysBillGroupSql(alias)} AND NOT ${paysPlanGroupSql(alias, exceptPlan)})`;

/** The payments a bank change named, by Plaid id (sync binds the JSON array of ids as `?1`): each one and its split parts. */
export const SYNCED_PAYMENTS_SQL = `SELECT t.id FROM transactions t WHERE t.plaid_transaction_id IN (SELECT value FROM json_each(?1))
			OR t.parent_id IN (SELECT p.id FROM transactions p WHERE p.plaid_transaction_id IN (SELECT value FROM json_each(?1)))`;

/** A cash entry and its split parts, by id (saveEdit binds the entry's id as `?1`). */
const CASH_PAYMENTS_SQL =
	"SELECT id FROM transactions WHERE id = ?1 OR parent_id = ?1";

/**
 * A statement for after a payment's date or amount changed: it unlinks each plan whose payment is in `touched` (a subquery
 * of payment ids) and that canPayPlanSql no longer accepts, so the plan is set aside again. This is the rule for a payment
 * that changed (decision 82): a link is kept only while it still fits. The plan's own link is left out of the check, as
 * updatePlan leaves it out, so a plan never counts against itself, and a split purchase keeps its link (splitOk). `guard`,
 * when given, is the SQL that ends the WHERE; it binds after `touched`'s own parameters.
 */
export function unlinkUnfitPlanPaymentsSql(touched: string, guard = "") {
	return `UPDATE planned_expenses SET transaction_id = NULL
		WHERE transaction_id IN (${touched})
		AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = planned_expenses.transaction_id AND ${canPayPlanSql("t", "planned_expenses.month", "planned_expenses.id", true)})${guard ? ` AND ${guard}` : ""}`;
}

/**
 * The cash edit's unlink (saveEdit): the entry and its parts, whose dates a cash edit moves. It names no guard of its own,
 * since the edit's gate is appended to it, so a refused save unlinks nothing.
 */
export function unlinkUnfitCashPlanPaymentsSql() {
	return unlinkUnfitPlanPaymentsSql(CASH_PAYMENTS_SQL);
}

/**
 * A payer's name as bills show it (bills.tsx): its own name or its merchant's, else the bank's text tidied. The bank's
 * text is read in TypeScript, since tidyName isn't SQL; `paidRawName` is that text, null with no payment.
 */
function withPayerName({
	paidRawName,
	...plan
}: PlannedExpense & { paidRawName: string | null }): PlannedExpense {
	return {
		...plan,
		paidName:
			plan.paidName ?? (paidRawName === null ? null : tidyName(paidRawName)),
	};
}

/** The set-aside for a month: this month's plans and any from an earlier month not yet paid, moved or dropped. */
export async function plansSetAsideCents(
	db: D1Database,
	month: string,
): Promise<number> {
	const row = await db
		.prepare(
			"SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM planned_expenses WHERE transaction_id IS NULL AND month <= ?",
		)
		.bind(month)
		.first<{ cents: number }>();

	return row?.cents ?? 0;
}

/** Every plan, in month order, with its payment's date and name when paid. */
export async function loadPlans(db: D1Database): Promise<PlannedExpense[]> {
	const { results } = await db
		.prepare(
			`SELECT pe.id, pe.name, pe.amount_cents AS amountCents, pe.month, pe.transaction_id AS transactionId,
					t.date AS paidDate, ${PAYER_NAME} AS paidName, t.raw_name AS paidRawName, t.amount_cents AS paidAmountCents
				FROM planned_expenses pe
				LEFT JOIN transactions t ON t.id = pe.transaction_id
				ORDER BY pe.month, pe.id`,
		)
		.all<PlannedExpense & { paidRawName: string | null }>();

	return results.map(withPayerName);
}

/** One plan, read for its sheet or its page; null when it doesn't exist. */
export async function loadPlan(
	db: D1Database,
	id: number,
): Promise<PlannedExpense | null> {
	const row = await db
		.prepare(
			`SELECT pe.id, pe.name, pe.amount_cents AS amountCents, pe.month, pe.transaction_id AS transactionId,
					t.date AS paidDate, ${PAYER_NAME} AS paidName, t.raw_name AS paidRawName, t.amount_cents AS paidAmountCents
				FROM planned_expenses pe
				LEFT JOIN transactions t ON t.id = pe.transaction_id
				WHERE pe.id = ?`,
		)
		.bind(id)
		.first<PlannedExpense & { paidRawName: string | null }>();

	return row ? withPayerName(row) : null;
}

/** The payments a plan could be paid by, closest amount first (decision 82, P101): every one that fits, not a first page. */
export async function planPaymentCandidates(
	db: D1Database,
	plan: Pick<PlannedExpense, "month" | "amountCents">,
): Promise<PlanPaymentCandidate[]> {
	const { results } = await db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, ${PAYER_NAME} AS name, t.raw_name AS rawName, t.excluded AS excluded
			 FROM transactions t
			 WHERE ${canPayPlanSql("t", "?1")}
			 ORDER BY ABS(t.amount_cents - ?2), t.date, t.id`,
		)
		.bind(plan.month, plan.amountCents)
		.all<{
			id: number;
			date: string;
			amountCents: number;
			name: string | null;
			rawName: string;
			excluded: number;
		}>();

	return results.map((row) => ({
		id: row.id,
		date: row.date,
		amountCents: row.amountCents,
		displayName: row.name ?? tidyName(row.rawName),
		excluded: row.excluded === 1,
	}));
}

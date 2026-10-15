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

/** How long a deleted plan's Undo stays open, in milliseconds (decision 101: ten seconds, like a cash entry). */
export const PLAN_UNDO_MS = 10_000;

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

/**
 * Links a payment to a plan, only if it is still unpaid and canPayPlanSql accepts it, the same rule the picker lists
 * by (planPaymentCandidates). Returns whether the link was made; the caller says why when it wasn't.
 */
export async function linkPlanPayment(
	db: D1Database,
	planId: number,
	transactionId: number,
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE planned_expenses SET transaction_id = ?1
			 WHERE id = ?2 AND transaction_id IS NULL
				AND EXISTS (SELECT 1 FROM transactions t WHERE t.id = ?1 AND ${canPayPlanSql("t", "planned_expenses.month")})`,
		)
		.bind(transactionId, planId)
		.run();
	return result.meta.changes === 1;
}

/**
 * What a payment already pays, if anything, for a link refusal to name (decision 82): the payment's group, the payment,
 * its split parent and its parts, pays a bill or a planned expense. Null when neither does.
 */
export async function paysBillOrPlan(
	db: D1Database,
	transactionId: number,
): Promise<"bill" | "plan" | null> {
	const paid = await db
		.prepare(
			`SELECT ${paysBillGroupSql("t")} AS bill, ${paysPlanGroupSql("t")} AS plan FROM transactions t WHERE t.id = ?`,
		)
		.bind(transactionId)
		.first<{ bill: number; plan: number }>();
	if (paid?.bill) return "bill";
	return paid?.plan ? "plan" : null;
}

/** Unlinks a plan's payment, which sets the plan aside again. */
export async function unlinkPlanPayment(
	db: D1Database,
	planId: number,
): Promise<boolean> {
	const result = await db
		.prepare(
			"UPDATE planned_expenses SET transaction_id = NULL WHERE id = ? AND transaction_id IS NOT NULL",
		)
		.bind(planId)
		.run();
	return result.meta.changes === 1;
}

/** Moves an unpaid plan from an earlier month to this one (the Band's Move to). */
export async function movePlanToMonth(
	db: D1Database,
	planId: number,
	month: string,
): Promise<boolean> {
	const result = await db
		.prepare(
			"UPDATE planned_expenses SET month = ?1 WHERE id = ?2 AND transaction_id IS NULL AND month < ?1",
		)
		.bind(month, planId)
		.run();
	return result.meta.changes === 1;
}

/** The plan fields a person sets in its sheet. */
export type PlanFields = { name: string; amountCents: number; month: string };

export async function insertPlan(
	db: D1Database,
	fields: PlanFields,
	createdBy: string,
): Promise<number | null> {
	const result = await db
		.prepare(
			"INSERT INTO planned_expenses (name, amount_cents, month, created_by) VALUES (?, ?, ?, ?)",
		)
		.bind(fields.name, fields.amountCents, fields.month, createdBy)
		.run();
	return result.meta.last_row_id ?? null;
}

/**
 * Saves a plan's name, amount and month, and keeps its payment only while canPayPlanSql accepts it for the new month, so
 * a month the payment no longer fits unlinks it (`unlinked`). The payment is re-checked, not linked, so a payment split
 * since the plan was paid still fits: the plan keeps the whole payment (splitOk). One batch, so the read of the payment
 * and the write land together; both answers are false when the plan doesn't exist.
 */
export async function updatePlan(
	db: D1Database,
	planId: number,
	fields: PlanFields,
): Promise<{ saved: boolean; unlinked: boolean }> {
	const [current, written] = await db.batch<{
		before?: number | null;
		after?: number | null;
	}>([
		db
			.prepare(
				"SELECT transaction_id AS before FROM planned_expenses WHERE id = ?1",
			)
			.bind(planId),
		db
			.prepare(
				`UPDATE planned_expenses SET name = ?1, amount_cents = ?2, month = ?3,
					transaction_id = CASE WHEN EXISTS (SELECT 1 FROM transactions t WHERE t.id = planned_expenses.transaction_id AND ${canPayPlanSql("t", "?3", "planned_expenses.id", true)}) THEN transaction_id END
				 WHERE id = ?4 RETURNING transaction_id AS after`,
			)
			.bind(fields.name, fields.amountCents, fields.month, planId),
	]);
	const before = current?.results[0]?.before ?? null;
	const after = written?.results[0]?.after ?? null;
	return {
		saved: written?.meta.changes === 1,
		unlinked: before !== null && after === null,
	};
}

/**
 * Deletes a plan and holds its values for ten seconds, so Undo can write it back (decision 101). Holds older than the
 * window are pruned here. Returns the Undo token, or null when there is no such plan.
 */
export async function holdPlanDelete(
	db: D1Database,
	planId: number,
	now: number = Date.now(),
): Promise<string | null> {
	const token = crypto.randomUUID();
	// One batch, so the hold and the delete land together or not at all; the hold reads the plan before it goes.
	const [, held] = await db.batch([
		db
			.prepare("DELETE FROM planned_delete_holds WHERE created_ms <= ?")
			.bind(now - PLAN_UNDO_MS),
		db
			.prepare(
				`INSERT INTO planned_delete_holds (token, created_ms, name, amount_cents, month, transaction_id, had_payment, created_by)
				 SELECT ?1, ?2, name, amount_cents, month, transaction_id, transaction_id IS NOT NULL, created_by FROM planned_expenses WHERE id = ?3`,
			)
			.bind(token, now, planId),
		db.prepare("DELETE FROM planned_expenses WHERE id = ?").bind(planId),
	]);
	if (!held?.meta.changes) return null;
	return token;
}

/**
 * Writes a deleted plan back, once, within its ten seconds. Returns the restored plan's name, or null when the token
 * is unknown, already used or too old. The payment comes back only while canPayPlanSql accepts it for the plan's month
 * (splitOk, as updatePlan's): if a bill, another plan or a deletion took it meanwhile, or it became a credit or income,
 * or moved outside the plan's month and the next, the plan comes back unpaid and set aside again, and `unlinked` says so
 * (true only when the deleted plan had a payment and lost it). A payment split since the delete still fits, so the plan
 * comes back on the whole payment.
 */
export async function restorePlanDelete(
	db: D1Database,
	token: string,
	now: number = Date.now(),
): Promise<{ name: string; unlinked: boolean } | null> {
	const hold = await db
		.prepare(
			"SELECT name, had_payment AS hadPayment FROM planned_delete_holds WHERE token = ? AND created_ms > ?",
		)
		.bind(token, now - PLAN_UNDO_MS)
		.first<{ name: string; hadPayment: number }>();
	if (!hold) return null;
	const [inserted] = await db.batch([
		db
			.prepare(
				`INSERT INTO planned_expenses (name, amount_cents, month, transaction_id, created_by)
				 SELECT h.name, h.amount_cents, h.month,
					CASE WHEN EXISTS (SELECT 1 FROM transactions pt WHERE pt.id = h.transaction_id AND ${canPayPlanSql("pt", "h.month", undefined, true)})
					THEN h.transaction_id END,
					h.created_by
				 FROM planned_delete_holds h WHERE h.token = ?1 AND h.created_ms > ?2`,
			)
			.bind(token, now - PLAN_UNDO_MS),
		db.prepare("DELETE FROM planned_delete_holds WHERE token = ?").bind(token),
	]);
	if (!inserted?.meta.changes) return null;
	const restored = await db
		.prepare(
			"SELECT transaction_id AS transactionId FROM planned_expenses WHERE id = ?",
		)
		.bind(inserted.meta.last_row_id)
		.first<{ transactionId: number | null }>();
	return {
		name: hold.name,
		unlinked: hold.hadPayment === 1 && restored?.transactionId === null,
	};
}

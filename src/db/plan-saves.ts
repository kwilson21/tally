// How the plans rules (src/rules/plans.ts) read their facts and save what they decide (decisions 190 and 206). The
// rule decides in TypeScript; the database only checks that what the rule read has not changed since, and raises an
// error when it has, so a plan is never saved, moved or paid on rows that changed a moment earlier.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
	type AddPlanWrite,
	type DeletePlanRequest,
	type DeletePlanWrite,
	deletePlan,
	type EditPlanFacts,
	type EditPlanRequest,
	type EditPlanWrite,
	type LinkPaymentFacts,
	type LinkPaymentRequest,
	type LinkPaymentWrite,
	linkPayment,
	type MovePlanRequest,
	type MovePlanWrite,
	type PlanFacts,
	type RestorePlanFacts,
	type RestorePlanRequest,
	type RestorePlanWrite,
	restorePlan,
	type UnlinkPaymentWrite,
} from "../rules/plans";
import { UNDO_MS } from "../undo";
import { paysBillGroupSql, paysPlanGroupSql } from "./counted-month";
import { Database, runWith } from "./database";
import { decideAndSave, guardedSave } from "./guarded-save";
import { canPayPlanSql } from "./planned-expenses";
import { leftEmpty } from "./refused";

/** The plan ?1 as one text: its month, its payment and its name (in hex). 'none' when it is gone. */
const PLAN_STATE = `COALESCE((SELECT month || ':' || COALESCE(transaction_id, '') || ':' || hex(name)
	FROM planned_expenses WHERE id = ?1), 'none')`;

/** Whether the plan ?1's own payment can still pay it in the month ?2, as SQL (the payment may have been split since). */
const PAYMENT_FITS_MONTH = `EXISTS (SELECT 1 FROM planned_expenses pe JOIN transactions t ON t.id = pe.transaction_id
	WHERE pe.id = ?1 AND ${canPayPlanSql("t", "?2", "pe.id", true)})`;

/** Whether the picker would list the payment ?2 for the plan ?1, as SQL. */
const PAYMENT_CAN_PAY = `EXISTS (SELECT 1 FROM planned_expenses pe JOIN transactions t ON t.id = ?2
	WHERE pe.id = ?1 AND ${canPayPlanSql("t", "pe.month")})`;

/** What the payment ?2 already pays, as SQL: two flags, bill then plan. No row when there is no such payment. */
const PAYMENT_PAYS = `SELECT ${paysBillGroupSql("t")} AS bill, ${paysPlanGroupSql("t")} AS plan FROM transactions t WHERE t.id = ?2`;

/** Whether the payment the held delete ?1 had can still pay the plan in its month, as SQL. */
const HELD_PAYMENT_FITS = `EXISTS (SELECT 1 FROM planned_delete_holds h JOIN transactions pt ON pt.id = h.transaction_id
	WHERE h.token = ?1 AND ${canPayPlanSql("pt", "h.month", undefined, true)})`;

// Each rule's version: everything it reads, as one text.
const PLAN_VERSION = `(${PLAN_STATE})`;
const EDIT_VERSION = `(${PLAN_STATE} || '/' || ${PAYMENT_FITS_MONTH})`;
const LINK_VERSION = `(${PLAN_STATE} || '/' || ${PAYMENT_CAN_PAY} || '/' || COALESCE((SELECT bill || ':' || plan FROM (${PAYMENT_PAYS})), 'none'))`;
const HOLD_VERSION = `(COALESCE((SELECT created_ms || ':' || had_payment FROM planned_delete_holds WHERE token = ?1), 'none') || '/' || ${HELD_PAYMENT_FITS})`;

type StoredPlan = { name: string; month: string; paid: number };

const PLAN_ROW =
	"SELECT name, month, transaction_id IS NOT NULL AS paid FROM planned_expenses WHERE id = ?1";

const asPlan = (row: StoredPlan | undefined): PlanFacts["plan"] =>
	row ? { name: row.name, month: row.month, paid: row.paid === 1 } : null;

/** What the move, delete and unlink rules read about a plan, with its version, in one batch. */
export async function planFacts(
	db: D1Database,
	id: number,
): Promise<PlanFacts> {
	// SAFETY: the batch below lists exactly two statements, so its results are the two D1Results typed here. A batch is
	// one transaction, so the version is of the very row read beside it.
	const [plan, state] = (await db.batch([
		db.prepare(PLAN_ROW).bind(id),
		db.prepare(`SELECT ${PLAN_VERSION} AS version`).bind(id),
	])) as [D1Result<StoredPlan>, D1Result<{ version: string }>];

	return {
		plan: asPlan(plan.results[0]),
		version: state.results[0]?.version ?? "",
	};
}

/** What the save rule reads: the plan, and whether its payment still fits the month the save names. */
export async function editPlanFacts(
	db: D1Database,
	id: number,
	month: string,
): Promise<EditPlanFacts> {
	// SAFETY: the batch below lists exactly two statements, so its results are the two D1Results typed here.
	const [plan, state] = (await db.batch([
		db.prepare(PLAN_ROW).bind(id),
		db
			.prepare(
				`SELECT ${PAYMENT_FITS_MONTH} AS fits, ${EDIT_VERSION} AS version`,
			)
			.bind(id, month),
	])) as [D1Result<StoredPlan>, D1Result<{ fits: number; version: string }>];

	return {
		plan: asPlan(plan.results[0]),
		paymentFits: state.results[0]?.fits === 1,
		version: state.results[0]?.version ?? "",
	};
}

/** What the link rule reads: the plan, whether the payment can pay it, and what the payment already pays. */
export async function linkPaymentFacts(
	db: D1Database,
	id: number,
	transactionId: number,
): Promise<LinkPaymentFacts> {
	// SAFETY: the batch below lists exactly three statements, so its results are the three D1Results typed here.
	const [plan, pays, state] = (await db.batch([
		db.prepare(PLAN_ROW).bind(id),
		db.prepare(PAYMENT_PAYS.replace("?2", "?1")).bind(transactionId),
		db
			.prepare(`SELECT ${PAYMENT_CAN_PAY} AS fits, ${LINK_VERSION} AS version`)
			.bind(id, transactionId),
	])) as [
		D1Result<StoredPlan>,
		D1Result<{ bill: number; plan: number }>,
		D1Result<{ fits: number; version: string }>,
	];

	const paid = pays.results[0];

	return {
		plan: asPlan(plan.results[0]),
		payment: {
			fits: state.results[0]?.fits === 1,
			pays: paid?.bill ? "bill" : paid?.plan ? "plan" : null,
		},
		version: state.results[0]?.version ?? "",
	};
}

/** What Undo's rule reads: the held delete for a token, and whether its payment still fits. */
export async function restorePlanFacts(
	db: D1Database,
	token: string,
): Promise<RestorePlanFacts> {
	// SAFETY: the batch below lists exactly two statements, so its results are the two D1Results typed here.
	const [hold, state] = (await db.batch([
		db
			.prepare(
				"SELECT name, created_ms AS createdMs, had_payment AS hadPayment FROM planned_delete_holds WHERE token = ?1",
			)
			.bind(token),
		db
			.prepare(
				`SELECT ${HELD_PAYMENT_FITS} AS fits, ${HOLD_VERSION} AS version`,
			)
			.bind(token),
	])) as [
		D1Result<{ name: string; createdMs: number; hadPayment: number }>,
		D1Result<{ fits: number; version: string }>,
	];

	const held = hold.results[0];

	return {
		hold: held
			? {
					name: held.name,
					createdMs: held.createdMs,
					hadPayment: held.hadPayment === 1,
					paymentFits: state.results[0]?.fits === 1,
				}
			: null,
		version: state.results[0]?.version ?? "",
	};
}

/**
 * The guard, the first statement of every save that read something: it adds nothing while the rows are still as the
 * rule read them, and tries to add a plan with no name when they are not. The name is NOT NULL, so that fails the
 * statement and the whole batch with an error planChangedSinceRead knows (SQLite's RAISE works only inside a trigger).
 * `version` is the rule's version SQL; its ?1 and ?2 are bound first, then the version the rule read.
 */
const guard = (
	db: D1Database,
	version: string,
	expectedVersion: string,
	...binds: (string | number)[]
) =>
	db
		.prepare(
			`INSERT INTO planned_expenses (name, amount_cents, month, created_by)
			SELECT NULL, 1, '2000-01', 'guard' WHERE ${version} IS NOT ?${binds.length + 1}`,
		)
		.bind(...binds, expectedVersion);

/** Whether a save failed because what the rule read had changed, and not for any other reason. Only the guard can try to add a plan with no name. */
export const planChangedSinceRead = leftEmpty("planned_expenses", "name");

export const addPlanStatements = (db: D1Database, save: AddPlanWrite) => [
	db
		.prepare(
			"INSERT INTO planned_expenses (name, amount_cents, month, created_by) VALUES (?, ?, ?, ?)",
		)
		.bind(save.name, save.amountCents, save.month, save.who),
];

/** Saves the fields, and drops the payment when the rule said it no longer fits. */
export const editPlanStatements = (db: D1Database, save: EditPlanWrite) => [
	guard(db, EDIT_VERSION, save.expectedVersion, save.id, save.fields.month),
	db
		.prepare(
			`UPDATE planned_expenses SET name = ?1, amount_cents = ?2, month = ?3,
				transaction_id = CASE WHEN ?4 THEN transaction_id END WHERE id = ?5`,
		)
		.bind(
			save.fields.name,
			save.fields.amountCents,
			save.fields.month,
			save.keepPayment ? 1 : 0,
			save.id,
		),
];

export const movePlanStatements = (db: D1Database, save: MovePlanWrite) => [
	guard(db, PLAN_VERSION, save.expectedVersion, save.id),
	db
		.prepare("UPDATE planned_expenses SET month = ? WHERE id = ?")
		.bind(save.toMonth, save.id),
];

/** Holds the plan's values, then deletes it. Holds older than the Undo's window are pruned here. */
export const deletePlanStatements = (db: D1Database, save: DeletePlanWrite) => [
	guard(db, PLAN_VERSION, save.expectedVersion, save.id),
	db
		.prepare("DELETE FROM planned_delete_holds WHERE created_ms <= ?")
		.bind(save.now - UNDO_MS),
	db
		.prepare(
			`INSERT INTO planned_delete_holds (token, created_ms, name, amount_cents, month, transaction_id, had_payment, created_by)
			 SELECT ?1, ?2, name, amount_cents, month, transaction_id, transaction_id IS NOT NULL, created_by FROM planned_expenses WHERE id = ?3`,
		)
		.bind(save.token, save.now, save.id),
	db.prepare("DELETE FROM planned_expenses WHERE id = ?").bind(save.id),
];

/** Writes the held plan back, with its payment when the rule kept it, and ends the Undo. */
export const restorePlanStatements = (
	db: D1Database,
	save: RestorePlanWrite,
) => [
	guard(db, HOLD_VERSION, save.expectedVersion, save.token),
	db
		.prepare(
			`INSERT INTO planned_expenses (name, amount_cents, month, transaction_id, created_by)
			 SELECT h.name, h.amount_cents, h.month, CASE WHEN ?2 THEN h.transaction_id END, h.created_by
			 FROM planned_delete_holds h WHERE h.token = ?1`,
		)
		.bind(save.token, save.keepPayment ? 1 : 0),
	db
		.prepare("DELETE FROM planned_delete_holds WHERE token = ?")
		.bind(save.token),
];

export const linkPaymentStatements = (
	db: D1Database,
	save: LinkPaymentWrite,
) => [
	guard(db, LINK_VERSION, save.expectedVersion, save.id, save.transactionId),
	db
		.prepare("UPDATE planned_expenses SET transaction_id = ?2 WHERE id = ?1")
		.bind(save.id, save.transactionId),
];

export const unlinkPaymentStatements = (
	db: D1Database,
	save: UnlinkPaymentWrite,
) => [
	guard(db, PLAN_VERSION, save.expectedVersion, save.id),
	db
		.prepare("UPDATE planned_expenses SET transaction_id = NULL WHERE id = ?")
		.bind(save.id),
];

/**
 * Reads a plan rule's facts, asks the rule and saves what it decides in one batch, asking again on fresh facts when
 * the guard raises (decideAndSave). Answers with the facts it decided on and what the rule decided (nothing, when what
 * was asked is already true).
 */
export const decidePlan = <Request, F, W, E>(
	planRule: {
		decide: (request: Request, facts: F) => Effect.Effect<Option.Option<W>, E>;
	},
	request: Request,
	facts: (db: D1Database) => Promise<F>,
	statements: (db: D1Database, save: W) => D1PreparedStatement[],
) =>
	Effect.gen(function* () {
		const db = yield* Database;

		return yield* decideAndSave({
			facts: Effect.promise(() => facts(db)),
			decide: (read) => planRule.decide(request, read),
			save: (write) =>
				guardedSave(
					() => db.batch(statements(db, write)),
					planChangedSinceRead,
				),
			gaveUp: "A planned expense kept changing while it was being saved.",
		});
	});

// Each rule with its own read and save.

export const decideEditPlan = <E>(
	rule: {
		decide: (
			request: EditPlanRequest,
			facts: EditPlanFacts,
		) => Effect.Effect<Option.Option<EditPlanWrite>, E>;
	},
	request: EditPlanRequest,
) =>
	decidePlan(
		rule,
		request,
		(db) => editPlanFacts(db, request.id, request.fields.month),
		editPlanStatements,
	);

export const decideMovePlan = <E>(
	rule: {
		decide: (
			request: MovePlanRequest,
			facts: PlanFacts,
		) => Effect.Effect<Option.Option<MovePlanWrite>, E>;
	},
	request: MovePlanRequest,
) =>
	decidePlan(
		rule,
		request,
		(db) => planFacts(db, request.id),
		movePlanStatements,
	);

export const decideDeletePlan = <E>(
	rule: {
		decide: (
			request: DeletePlanRequest,
			facts: PlanFacts,
		) => Effect.Effect<Option.Option<DeletePlanWrite>, E>;
	},
	request: DeletePlanRequest,
) =>
	decidePlan(
		rule,
		request,
		(db) => planFacts(db, request.id),
		deletePlanStatements,
	);

export const decideRestorePlan = <E>(
	rule: {
		decide: (
			request: RestorePlanRequest,
			facts: RestorePlanFacts,
		) => Effect.Effect<Option.Option<RestorePlanWrite>, E>;
	},
	request: RestorePlanRequest,
) =>
	decidePlan(
		rule,
		request,
		(db) => restorePlanFacts(db, request.token),
		restorePlanStatements,
	);

export const decideLinkPayment = <E>(
	rule: {
		decide: (
			request: LinkPaymentRequest,
			facts: LinkPaymentFacts,
		) => Effect.Effect<Option.Option<LinkPaymentWrite>, E>;
	},
	request: LinkPaymentRequest,
) =>
	decidePlan(
		rule,
		request,
		(db) => linkPaymentFacts(db, request.id, request.transactionId),
		linkPaymentStatements,
	);

export const decideUnlinkPayment = <E>(
	rule: {
		decide: (
			request: { id: number },
			facts: PlanFacts,
		) => Effect.Effect<Option.Option<UnlinkPaymentWrite>, E>;
	},
	request: { id: number },
) =>
	decidePlan(
		rule,
		request,
		(db) => planFacts(db, request.id),
		unlinkPaymentStatements,
	);

// The same three saves in the words their older callers read.

/** Deletes a plan and holds it for Undo, as the rule decides it: the Undo's token, or null when there is no such plan. */
export const holdPlanDelete = (
	db: D1Database,
	planId: number,
	now: number = Date.now(),
): Promise<string | null> => {
	const token = crypto.randomUUID();

	return runWith(
		db,
		decideDeletePlan(deletePlan, { id: planId, token, now }).pipe(
			Effect.as<string | null>(token),
			Effect.catchTag("PlanGone", () => Effect.succeed(null)),
		),
	);
};

/** Undo, as the rule decides it: the restored plan's name and whether it lost its payment, or null when the rule refuses. */
export const restorePlanDelete = (
	db: D1Database,
	token: string,
	now: number = Date.now(),
): Promise<{ name: string; unlinked: boolean } | null> =>
	runWith(
		db,
		decideRestorePlan(restorePlan, { token, now }).pipe(
			Effect.map(({ decided }) => {
				const write = Option.getOrThrow(decided);

				return { name: write.name, unlinked: write.unlinked };
			}),
			Effect.catchTag("PlanUndoExpired", () => Effect.succeed(null)),
		),
	);

/** Links a payment to a plan, as the rule decides it: whether the link was made. */
export const linkPlanPayment = (
	db: D1Database,
	planId: number,
	transactionId: number,
): Promise<boolean> =>
	runWith(
		db,
		decideLinkPayment(linkPayment, { id: planId, transactionId }).pipe(
			Effect.match({ onSuccess: () => true, onFailure: () => false }),
		),
	);

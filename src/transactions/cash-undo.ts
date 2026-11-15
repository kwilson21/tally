import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as Schema from "effect/Schema";
import { canPayPlanSql } from "../db/planned-expenses";
import { refundFitsSql } from "../db/refunded";
import { cashDeleteHolds } from "../db/schema";
import { parseStoredWith } from "../db/stored-shape";
import type { Json } from "../json";
import { UNDO_MS, undoLeftMs } from "../undo";

type Row = { [key: string]: Json };

export type Snapshot = {
	transaction: Row;
	parts: Row[];
	payments: Row[];
	refunds: Row[];
	plans: { id: number; transaction_id: number }[];
};

/**
 * A stored row: a plain object, whose keys are the column names and stay as stored (the restore writes each key as a column),
 * and whose values are not checked, since the restore binds them as JSON. Schema.Unknown does not recurse, so a deeply
 * nested value is kept whole.
 */
const StoredRow = Schema.Record(Schema.String, Schema.Unknown);

const StoredRows = Schema.mutable(Schema.Array(StoredRow));

const StoredPlans = Schema.mutable(
	Schema.Array(
		Schema.Struct({ id: Schema.Number, transaction_id: Schema.Number }),
	),
);

const jsonColumn = (column: string, alias = "") =>
	`json_extract(${alias}value, '$."${column}"')`;

/** Save and delete one cash entry from the same D1 snapshot. */
export async function holdCashDelete(
	db: D1Database,
	id: number,
	displayName: string,
) {
	// Stays raw: PRAGMA table_info takes the table name itself, which a bound query cannot.
	const columns = async (table: string) =>
		(
			await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
		).results.map(({ name }) => name);

	const [transactionColumns, paymentColumns] = await Promise.all([
		columns("transactions"),
		columns("bill_payments"),
	]);

	const jsonObject = (names: string[], alias = "") =>
		`json_object(${names.map((name) => `'${name}', ${alias}${name}`).join(",")})`;

	const paymentJson = `json_object(${[
		...paymentColumns.map((name) => `'${name}', bp.${name}`),
		"'bill_name', b.name",
	].join(",")})`;

	const arrayOf = (query: string) =>
		`COALESCE((SELECT json_group_array(json(row)) FROM (${query})), '[]')`;

	const token = crypto.randomUUID();

	// Stays raw: the insert's json_object and json_group_array strings come from the PRAGMA column lists, and a raw statement cannot share a D1 batch with a builder query.
	const result = await db.batch([
		db
			.prepare(`INSERT INTO cash_delete_holds (token,created_at,display_name,transaction_row,split_rows,payment_rows,refund_rows,plan_rows)
				SELECT ?, ?, ?, ${jsonObject(transactionColumns)},
				${arrayOf(`SELECT ${jsonObject(transactionColumns)} AS row FROM transactions WHERE parent_id=? ORDER BY id`)},
				${arrayOf(`SELECT ${paymentJson} AS row FROM bill_payments bp JOIN bills b ON b.id=bp.bill_id WHERE bp.transaction_id IN (SELECT id FROM transactions WHERE id=? OR parent_id=?) ORDER BY bp.id`)},
				${arrayOf(`SELECT ${jsonObject(transactionColumns)} AS row FROM transactions WHERE refund_of_id IN (SELECT id FROM transactions WHERE id=? OR parent_id=?) ORDER BY id`)},
				${arrayOf(`SELECT json_object('id', pe.id, 'transaction_id', pe.transaction_id) AS row FROM planned_expenses pe WHERE pe.transaction_id IN (SELECT id FROM transactions WHERE id=? OR parent_id=?) ORDER BY pe.id`)}
				FROM transactions WHERE id=? AND parent_id IS NULL AND account_id IN (SELECT id FROM accounts WHERE type='cash')`)
			.bind(token, Date.now(), displayName, id, id, id, id, id, id, id, id),
		// Stays raw: the delete batches with the raw insert above, which a builder query cannot join.
		db
			.prepare(
				"DELETE FROM transactions WHERE id=? AND parent_id IS NULL AND account_id IN (SELECT id FROM accounts WHERE type='cash')",
			)
			.bind(id),
	]);

	return result[0]?.meta.changes === 1 ? token : null;
}

/** The server clock determines how long the client may keep the Undo action visible. */
export async function cashDeleteUndoExpiresInMs(db: D1Database, token: string) {
	const hold = await drizzle(db)
		.select({ createdAt: cashDeleteHolds.createdAt })
		.from(cashDeleteHolds)
		.where(
			and(
				eq(cashDeleteHolds.token, token),
				isNull(cashDeleteHolds.restoreMarker),
			),
		)
		.get();

	return hold ? undoLeftMs(hold.createdAt, Date.now()) : 0;
}

/**
 * The snapshot the five stored columns hold, as they are stored. Text that is not JSON throws its SyntaxError (as JSON.parse
 * always did), and every column is parsed before any shape is judged. A column of the wrong shape makes the whole snapshot
 * null, which the restore answers as "cannot restore", so nothing is written (#1120, decision 233).
 */
export function snapshotOf(hold: {
	transaction_row: string;
	split_rows: string;
	payment_rows: string;
	refund_rows: string;
	plan_rows: string;
}): Snapshot | null {
	const transaction = parseStoredWith(StoredRow, hold.transaction_row);
	const parts = parseStoredWith(StoredRows, hold.split_rows);
	const payments = parseStoredWith(StoredRows, hold.payment_rows);
	const refunds = parseStoredWith(StoredRows, hold.refund_rows);
	const plans = parseStoredWith(StoredPlans, hold.plan_rows);

	if (
		transaction === null ||
		parts === null ||
		payments === null ||
		refunds === null ||
		plans === null
	)
		return null;

	// SAFETY: each text was JSON.parse'd above, so every value in these is a Json value; the Schemas checked only the shape.
	return {
		transaction: transaction as Row,
		parts: parts as Row[],
		payments: payments as Row[],
		refunds: refunds as Row[],
		plans,
	};
}

/** Restores once, only while the token is younger than the Undo window (src/undo.ts). */
export async function restoreCashDelete(db: D1Database, token: string) {
	const hold = await drizzle(db)
		.select()
		.from(cashDeleteHolds)
		.where(eq(cashDeleteHolds.token, token))
		.get();

	if (!hold) return null;

	if (hold.restoreMarker !== null)
		return { alreadyRestored: true as const, name: hold.displayName };
	const now = Date.now();

	if (hold.createdAt <= now - UNDO_MS || hold.createdAt > now) return null;

	// snapshotOf reads the stored columns under their column names: a column of the wrong shape refuses the restore (#1120).
	const snapshot = snapshotOf({
		transaction_row: hold.transactionRow,
		split_rows: hold.splitRows,
		payment_rows: hold.paymentRows,
		refund_rows: hold.refundRows,
		plan_rows: hold.planRows,
	});

	if (snapshot === null) return null;

	const transaction = snapshot.transaction;
	const columns = Object.keys(transaction);

	const links: {
		row_id: number;
		partner_id: number;
		name: string;
		move_cents: number;
		only_if_unlinked: boolean;
	}[] = [];

	const addLink = (row: Row, onlyIfUnlinked = false) => {
		if (row.refund_of_id === null) return;
		links.push({
			row_id: Number(row.id),
			partner_id: Number(row.refund_of_id),
			name: String(row.merchant_name ?? row.raw_name),
			move_cents: row.is_split === 1 ? 0 : Math.abs(Number(row.amount_cents)),
			only_if_unlinked: onlyIfUnlinked,
		});
	};

	addLink(transaction);

	for (const row of snapshot.parts) addLink(row);

	for (const row of snapshot.refunds) addLink(row, true);
	const marker = crypto.randomUUID();

	try {
		// Predict the same fresh ids as the insert so payment conflicts never use snapshot ids.
		// Stays raw: a CTE with json_each and a ROW_NUMBER window.
		const paymentCheck = await db
			.prepare(
				`WITH source AS (
					SELECT value, CAST(json_extract(value, '$.id') AS INTEGER) AS old_id FROM json_each(?)
				), maximum AS (
					SELECT MAX((SELECT COALESCE(MAX(id), 0) FROM transactions), COALESCE(MAX(old_id), 0),
						COALESCE(MAX(CAST(json_extract(value, '$.parent_id') AS INTEGER)), 0),
						COALESCE(MAX(CAST(json_extract(value, '$.refund_of_id') AS INTEGER)), 0)) AS base
					FROM source
				), targets AS (
					SELECT old_id, maximum.base + ROW_NUMBER() OVER (ORDER BY old_id) AS new_id
					FROM source CROSS JOIN maximum
				)
				SELECT json_extract(payments.value, '$.bill_name') AS name FROM json_each(?) AS payments
				WHERE json_extract(payments.value, '$.status') = 'linked' AND EXISTS (SELECT 1 FROM bill_payments WHERE transaction_id=COALESCE(
					(SELECT new_id FROM targets WHERE old_id=CAST(json_extract(payments.value, '$.transaction_id') AS INTEGER)),
					CAST(json_extract(payments.value, '$.transaction_id') AS INTEGER)) AND status='linked')`,
			)
			.bind(
				JSON.stringify([transaction, ...snapshot.parts]),
				JSON.stringify(snapshot.payments),
			)
			.all<{ name: string }>();

		const lostLinks = paymentCheck.results.map(({ name }) => `${name} payment`);
		// A person removed since the entry was deleted is gone: the entry comes back with no one, and no guess.
		const personKept = `(${jsonColumn("for_person_id", "mapped.")} IS NULL OR ${jsonColumn("for_person_id", "mapped.")} IN (SELECT id FROM household_people))`;

		const insertTransactions = `WITH source AS (
				SELECT value, CAST(json_extract(value, '$.id') AS INTEGER) AS old_id FROM json_each(?)
			), maximum AS (
				SELECT MAX((SELECT COALESCE(MAX(id), 0) FROM transactions), COALESCE(MAX(old_id), 0),
					COALESCE(MAX(CAST(json_extract(value, '$.parent_id') AS INTEGER)), 0),
					COALESCE(MAX(CAST(json_extract(value, '$.refund_of_id') AS INTEGER)), 0)) AS base
				FROM source
			), mapped AS (
				SELECT source.value, source.old_id, maximum.base + ROW_NUMBER() OVER (ORDER BY source.old_id) AS new_id
				FROM source CROSS JOIN maximum
			)
			INSERT INTO transactions (${columns.join(",")})
			SELECT ${columns
				.map((column) => {
					if (column === "id") return "new_id";

					if (column === "parent_id")
						return "COALESCE((SELECT new_id FROM mapped parent WHERE parent.old_id=CAST(json_extract(mapped.value, '$.parent_id') AS INTEGER)), json_extract(mapped.value, '$.parent_id'))";

					if (column === "for_person_id")
						return `CASE WHEN ${personKept} THEN ${jsonColumn(column, "mapped.")} END`;

					if (column === "for_person_guessed")
						return `CASE WHEN ${personKept} THEN ${jsonColumn(column, "mapped.")} ELSE 0 END`;

					return column === "refund_of_id"
						? "NULL"
						: jsonColumn(column, "mapped.");
				})
				.join(",")}
			FROM mapped WHERE EXISTS (SELECT 1 FROM cash_delete_holds WHERE token=? AND restore_marker=?)`;

		const paymentColumns = Object.keys(snapshot.payments[0] ?? {}).filter(
			(key) => key !== "bill_name" && key !== "id",
		);

		const targets = [transaction, ...snapshot.parts];

		// Stays raw: this batch mixes raw JSON and window statements, which a builder query cannot join in one D1 batch.
		const writes = [
			db
				.prepare(
					"UPDATE cash_delete_holds SET restore_marker=? WHERE token=? AND restore_marker IS NULL AND created_at>? AND created_at<=?",
				)
				.bind(marker, token, now - UNDO_MS, now),
			db
				.prepare(insertTransactions)
				.bind(JSON.stringify(targets), token, marker),
		];

		if (snapshot.payments.length > 0)
			writes.push(
				db
					.prepare(
						`WITH targets AS (
							SELECT CAST(json_extract(value, '$.id') AS INTEGER) AS old_id,
								(SELECT MAX(id) FROM transactions) - (SELECT COUNT(*) FROM json_each(?)) + ROW_NUMBER() OVER (ORDER BY CAST(json_extract(value, '$.id') AS INTEGER)) AS new_id
							FROM json_each(?)
						)
						INSERT INTO bill_payments (${paymentColumns.join(",")})
						 SELECT ${paymentColumns
								.map((column) =>
									column === "transaction_id"
										? "COALESCE((SELECT new_id FROM targets WHERE old_id=json_extract(payments.value, '$.transaction_id')), json_extract(payments.value, '$.transaction_id'))"
										: jsonColumn(column, "payments."),
								)
								.join(",")}
						 FROM json_each(?) AS payments WHERE (json_extract(value, '$.status') != 'linked' OR
						 NOT EXISTS (SELECT 1 FROM bill_payments WHERE transaction_id=COALESCE(
							(SELECT new_id FROM targets WHERE old_id=json_extract(payments.value, '$.transaction_id')),
							json_extract(payments.value, '$.transaction_id')) AND status='linked'))
						 AND EXISTS (SELECT 1 FROM cash_delete_holds WHERE token=? AND restore_marker=?)`,
					)
					.bind(
						JSON.stringify(targets),
						JSON.stringify(targets),
						JSON.stringify(snapshot.payments),
						token,
						marker,
					),
			);
		writes.push(
			db
				// Stays raw: a CTE with json_each and a ROW_NUMBER window, batched with the raw writes.
				.prepare(`WITH targets AS (
						SELECT CAST(json_extract(value, '$.id') AS INTEGER) AS old_id,
							(SELECT MAX(id) FROM transactions) - (SELECT COUNT(*) FROM json_each(?)) + ROW_NUMBER() OVER (ORDER BY CAST(json_extract(value, '$.id') AS INTEGER)) AS new_id
						FROM json_each(?)
					), links AS (SELECT value FROM json_each(?)),
					candidate AS (SELECT COALESCE((SELECT new_id FROM targets WHERE old_id=json_extract(links.value, '$.row_id')), json_extract(links.value, '$.row_id')) AS row_id,
						COALESCE((SELECT new_id FROM targets WHERE old_id=json_extract(links.value, '$.partner_id')), json_extract(links.value, '$.partner_id')) AS partner_id,
						json_extract(links.value, '$.move_cents') AS move_cents,
						json_extract(links.value, '$.only_if_unlinked') AS only_if_unlinked,
						EXISTS (SELECT 1 FROM transactions p WHERE p.id=COALESCE((SELECT new_id FROM targets WHERE old_id=json_extract(links.value, '$.partner_id')), json_extract(links.value, '$.partner_id'))) AS partner_exists,
						(SELECT amount_cents FROM transactions WHERE id=COALESCE((SELECT new_id FROM targets WHERE old_id=json_extract(links.value, '$.partner_id')), json_extract(links.value, '$.partner_id'))) AS purchase_cents,
						COALESCE((SELECT SUM(ABS(r.amount_cents)) FROM transactions r WHERE r.refund_of_id=COALESCE((SELECT new_id FROM targets WHERE old_id=json_extract(links.value, '$.partner_id')), json_extract(links.value, '$.partner_id'))
							AND r.is_split=0 AND r.amount_cents<0 AND r.flag_income=0 AND r.id!=COALESCE((SELECT new_id FROM targets WHERE old_id=json_extract(links.value, '$.row_id')), json_extract(links.value, '$.row_id'))), 0) AS refunded_cents,
						(SELECT refund_of_id IS NULL FROM transactions WHERE id=COALESCE((SELECT new_id FROM targets WHERE old_id=json_extract(links.value, '$.row_id')), json_extract(links.value, '$.row_id'))) AS unlinked
						FROM links), eligible AS (SELECT * FROM candidate WHERE partner_exists
						AND (only_if_unlinked=0 OR unlinked=1)), ordered AS (SELECT *,
						SUM(move_cents) OVER (PARTITION BY partner_id ORDER BY row_id ROWS UNBOUNDED PRECEDING) AS running_cents
						FROM eligible)
					UPDATE transactions SET refund_of_id=ordered.partner_id FROM ordered
					WHERE transactions.id=ordered.row_id AND ordered.running_cents<=MAX(0, ordered.purchase_cents-ordered.refunded_cents)
					AND ${refundFitsSql("transactions.id", "ordered.partner_id")}
					AND EXISTS (SELECT 1 FROM cash_delete_holds WHERE token=? AND restore_marker=?)`)
				.bind(
					JSON.stringify(targets),
					JSON.stringify(targets),
					JSON.stringify(links),
					token,
					marker,
				),
		);

		// A plan the entry or a part paid is paid again by the restored row, if canPayPlanSql accepts it for the plan's month
		// as it is now, as restorePlanDelete does (splitOk). Its id is the plan's own, since the delete only unlinked it.
		if (snapshot.plans.length > 0)
			// Stays raw: a CTE with json_each and a ROW_NUMBER window, batched with the raw writes.
			writes.push(
				db
					.prepare(
						`WITH targets AS (
							SELECT CAST(json_extract(value, '$.id') AS INTEGER) AS old_id,
								(SELECT MAX(id) FROM transactions) - (SELECT COUNT(*) FROM json_each(?)) + ROW_NUMBER() OVER (ORDER BY CAST(json_extract(value, '$.id') AS INTEGER)) AS new_id
							FROM json_each(?)
						)
						UPDATE planned_expenses SET transaction_id = (SELECT new_id FROM targets WHERE old_id = json_extract(plans.value, '$.transaction_id'))
						FROM json_each(?) AS plans
						WHERE planned_expenses.id = json_extract(plans.value, '$.id') AND planned_expenses.transaction_id IS NULL
						AND EXISTS (SELECT 1 FROM transactions nt WHERE nt.id = (SELECT new_id FROM targets WHERE old_id = json_extract(plans.value, '$.transaction_id'))
							AND ${canPayPlanSql("nt", "planned_expenses.month", undefined, true)})
						AND EXISTS (SELECT 1 FROM cash_delete_holds WHERE token=? AND restore_marker=?)`,
					)
					.bind(
						JSON.stringify(targets),
						JSON.stringify(targets),
						JSON.stringify(snapshot.plans),
						token,
						marker,
					),
			);
		const results = await db.batch(writes);

		if (results[0]?.meta.changes !== 1) return null;

		// Stays raw: a CTE with json_each and a ROW_NUMBER window over the restored rows.
		const restoredLinks = new Set(
			(
				await db
					.prepare(
						`WITH targets AS (
							SELECT CAST(json_extract(value, '$.id') AS INTEGER) AS old_id,
								(SELECT MAX(id) FROM transactions) - (SELECT COUNT(*) FROM json_each(?)) + ROW_NUMBER() OVER (ORDER BY CAST(json_extract(value, '$.id') AS INTEGER)) AS new_id
							FROM json_each(?)
						)
						SELECT id, refund_of_id FROM transactions WHERE id IN (
							SELECT COALESCE((SELECT new_id FROM targets WHERE old_id=json_extract(value, '$.row_id')), json_extract(value, '$.row_id')) FROM json_each(?)
						)`,
					)
					.bind(
						JSON.stringify(targets),
						JSON.stringify(targets),
						JSON.stringify(links),
					)
					.all<{ id: number; refund_of_id: number | null }>()
			).results
				.filter((row) => row.refund_of_id !== null)
				.map((row) => `${row.id}:${row.refund_of_id}`),
		);

		const mappedId = (id: number) =>
			targets.some((row) => Number(row.id) === id)
				? Number(results[1]?.meta.last_row_id) -
					targets.length +
					targets
						.map((row) => Number(row.id))
						.sort((a, b) => a - b)
						.indexOf(id) +
					1
				: id;

		for (const link of links)
			if (
				!restoredLinks.has(
					`${mappedId(link.row_id)}:${mappedId(link.partner_id)}`,
				)
			)
				lostLinks.push(link.name);

		// A plan the Undo didn't pay again (its month moved, or another payment took it) is named the way a refund link is.
		// A plan deleted during the window has no row, so it is not named.
		if (snapshot.plans.length > 0) {
			// Stays raw: an IN over a bound json_each list.
			const plans = await db
				.prepare(
					"SELECT id, name, transaction_id AS transactionId FROM planned_expenses WHERE id IN (SELECT value FROM json_each(?))",
				)
				.bind(JSON.stringify(snapshot.plans.map(({ id }) => id)))
				.all<{ id: number; name: string; transactionId: number | null }>();

			for (const plan of plans.results) {
				const paid = snapshot.plans.find(({ id }) => id === plan.id);

				if (paid && plan.transactionId !== mappedId(paid.transaction_id))
					lostLinks.push(plan.name);
			}
		}

		return {
			name: hold.displayName,
			lostLinks,
			alreadyRestored: false as const,
			// The entry's new id, so its row in the list can take focus (#397).
			id: mappedId(Number(transaction.id)),
		};
	} catch {
		return null;
	}
}

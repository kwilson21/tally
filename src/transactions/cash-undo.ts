import { refundFitsSql } from "../db/refunded";

type Row = Record<string, unknown>;
type Snapshot = {
	transaction: Row;
	parts: Row[];
	payments: Row[];
	refunds: Row[];
};

/** Keep the full SQLite rows so undo preserves fields added by future cash-entry edits. */
export async function holdCashDelete(
	db: D1Database,
	id: number,
	displayName: string,
) {
	const transaction = await db
		.prepare("SELECT * FROM transactions WHERE id=?")
		.bind(id)
		.first<Row>();
	if (!transaction) return null;
	const [parts, payments, refunds] = await Promise.all([
		db
			.prepare("SELECT * FROM transactions WHERE parent_id=? ORDER BY id")
			.bind(id)
			.all<Row>(),
		db
			.prepare(
				"SELECT * FROM bill_payments WHERE transaction_id IN (SELECT id FROM transactions WHERE id=? OR parent_id=?) ORDER BY id",
			)
			.bind(id, id)
			.all<Row>(),
		db
			.prepare(
				"SELECT * FROM transactions WHERE refund_of_id IN (SELECT id FROM transactions WHERE id=? OR parent_id=?) ORDER BY id",
			)
			.bind(id, id)
			.all<Row>(),
	]);
	const token = crypto.randomUUID();
	await db.batch([
		db
			.prepare("INSERT INTO cash_delete_holds VALUES(?, ?, ?, ?, ?, ?, ?)")
			.bind(
				token,
				Date.now(),
				displayName,
				JSON.stringify(transaction),
				JSON.stringify(parts.results),
				JSON.stringify(payments.results),
				JSON.stringify(refunds.results),
			),
		db
			.prepare(
				"DELETE FROM transactions WHERE id=? AND parent_id IS NULL AND account_id IN (SELECT id FROM accounts WHERE type='cash')",
			)
			.bind(id),
	]);
	return token;
}

const restoreRow = (db: D1Database, table: string, row: Row) => {
	const columns = Object.keys(row);
	return db
		.prepare(
			`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
		)
		.bind(...columns.map((column) => row[column] ?? null));
};

/** Restores once, only while the token is younger than ten seconds. */
export async function restoreCashDelete(db: D1Database, token: string) {
	const hold = await db
		.prepare(
			"SELECT * FROM cash_delete_holds WHERE token=? AND created_at>? AND created_at<=?",
		)
		.bind(token, Date.now() - 10_000, Date.now())
		.first<{
			transaction_row: string;
			display_name: string;
			split_rows: string;
			payment_rows: string;
			refund_rows: string;
		}>();
	if (!hold) return null;
	const snapshot: Snapshot = {
		transaction: JSON.parse(hold.transaction_row),
		parts: JSON.parse(hold.split_rows),
		payments: JSON.parse(hold.payment_rows),
		refunds: JSON.parse(hold.refund_rows),
	};
	const transaction = snapshot.transaction;
	const originalLink = transaction.refund_of_id as number | null;
	const writes = [
		restoreRow(db, "transactions", { ...transaction, refund_of_id: null }),
	];
	const guardedLinks: { index: number; name: string }[] = [];
	if (originalLink !== null) {
		const linked = await db
			.prepare("SELECT merchant_name, raw_name FROM transactions WHERE id=?")
			.bind(originalLink)
			.first<{ merchant_name: string | null; raw_name: string }>();
		guardedLinks.push({
			index: writes.length,
			name: linked?.merchant_name ?? linked?.raw_name ?? "refund",
		});
		writes.push(
			db
				.prepare(
					`UPDATE transactions SET refund_of_id=?1 WHERE id=?2 AND ${refundFitsSql("?2", "?1")}`,
				)
				.bind(originalLink, transaction.id),
		);
	}
	for (const row of snapshot.parts) {
		const originalPartLink = row.refund_of_id as number | null;
		writes.push(restoreRow(db, "transactions", { ...row, refund_of_id: null }));
		if (originalPartLink !== null) {
			const linked = await db
				.prepare("SELECT merchant_name, raw_name FROM transactions WHERE id=?")
				.bind(originalPartLink)
				.first<{ merchant_name: string | null; raw_name: string }>();
			guardedLinks.push({
				index: writes.length,
				name: linked?.merchant_name ?? linked?.raw_name ?? "refund",
			});
			writes.push(
				db
					.prepare(
						`UPDATE transactions SET refund_of_id=?1 WHERE id=?2 AND ${refundFitsSql("?2", "?1")}`,
					)
					.bind(originalPartLink, row.id),
			);
		}
	}
	for (const row of snapshot.refunds) {
		const purchaseId = row.refund_of_id as number;
		guardedLinks.push({
			index: writes.length,
			name: String(row.merchant_name ?? row.raw_name),
		});
		writes.push(
			db
				.prepare(
					`UPDATE transactions SET refund_of_id=?1 WHERE id=?2 AND refund_of_id IS NULL AND ${refundFitsSql("?2", "?1")}`,
				)
				.bind(purchaseId, row.id),
		);
	}
	for (const row of snapshot.payments) {
		const bill = await db
			.prepare("SELECT name FROM bills WHERE id=?")
			.bind(row.bill_id)
			.first<{ name: string }>();
		const columns = Object.keys(row);
		const placeholders = columns.map(() => "?").join(",");
		guardedLinks.push({
			index: writes.length,
			name: `${bill?.name ?? "Bill"} payment`,
		});
		writes.push(
			db
				.prepare(
					`INSERT INTO bill_payments (${columns.join(",")}) SELECT ${placeholders} WHERE ? != 'linked' OR (NOT EXISTS (SELECT 1 FROM bill_payments WHERE bill_id=? AND period=? AND status='linked') AND NOT EXISTS (SELECT 1 FROM bill_payments WHERE transaction_id=? AND status='linked'))`,
				)
				.bind(
					...columns.map((column) => row[column] ?? null),
					row.status,
					row.bill_id,
					row.period,
					row.transaction_id,
				),
		);
	}
	writes.push(
		db.prepare("DELETE FROM cash_delete_holds WHERE token=?").bind(token),
	);
	try {
		const results = await db.batch(writes);
		return {
			name: hold.display_name,
			lostLinks: guardedLinks
				.filter(({ index }) => (results[index]?.meta.changes ?? 0) === 0)
				.map(({ name }) => name),
		};
	} catch {
		return null;
	}
}

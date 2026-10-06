import { refundFitsSql } from "../db/refunded";

type Row = Record<string, unknown>;
type Snapshot = {
	transaction: Row;
	parts: Row[];
	payments: (Row & { bill_name: string })[];
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
				"SELECT bp.*, b.name AS bill_name FROM bill_payments bp JOIN bills b ON b.id=bp.bill_id WHERE bp.transaction_id IN (SELECT id FROM transactions WHERE id=? OR parent_id=?) ORDER BY bp.id",
			)
			.bind(id, id)
			.all<Row & { bill_name: string }>(),
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

const jsonColumn = (column: string) => `json_extract(value, '$."${column}"')`;
const insertRows = (table: string, columns: string[]) =>
	`INSERT INTO ${table} (${columns.join(",")}) SELECT ${columns.map(jsonColumn).join(",")} FROM json_each(?)`;

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
	const columns = Object.keys(transaction);
	const links: {
		row_id: number;
		partner_id: number;
		name: string;
		only_if_unlinked: boolean;
	}[] = [];
	if (transaction.refund_of_id !== null)
		links.push({
			row_id: Number(transaction.id),
			partner_id: Number(transaction.refund_of_id),
			name: String(transaction.raw_name),
			only_if_unlinked: false,
		});
	for (const row of snapshot.parts)
		if (row.refund_of_id !== null)
			links.push({
				row_id: Number(row.id),
				partner_id: Number(row.refund_of_id),
				name: String(row.raw_name),
				only_if_unlinked: false,
			});
	for (const row of snapshot.refunds)
		links.push({
			row_id: Number(row.id),
			partner_id: Number(row.refund_of_id),
			name: String(row.merchant_name ?? row.raw_name),
			only_if_unlinked: true,
		});
	const lostLinks: string[] = [];
	try {
		const paymentCheck = await db
			.prepare(
				`SELECT json_extract(value, '$.bill_name') AS name FROM json_each(?)
			 WHERE json_extract(value, '$.status') = 'linked' AND (
			 EXISTS (SELECT 1 FROM bill_payments WHERE bill_id=json_extract(value, '$.bill_id') AND period=json_extract(value, '$.period') AND status='linked')
			 OR EXISTS (SELECT 1 FROM bill_payments WHERE transaction_id=json_extract(value, '$.transaction_id') AND status='linked'))`,
			)
			.bind(JSON.stringify(snapshot.payments))
			.all<{ name: string }>();
		lostLinks.push(
			...paymentCheck.results.map(({ name }) => `${name} payment`),
		);
		const insertTransaction = `INSERT INTO transactions (${columns.join(",")}) SELECT ${columns.map((column) => (column === "refund_of_id" ? "NULL" : jsonColumn(column))).join(",")} FROM json_each(?) WHERE json_extract(value, '$.id') = ?`;
		const insertParts = insertRows("transactions", columns);
		const writes = [
			db
				.prepare(insertTransaction)
				.bind(JSON.stringify([transaction]), transaction.id),
			db.prepare(insertParts).bind(JSON.stringify(snapshot.parts)),
		];
		if (snapshot.payments.length > 0)
			writes.push(
				db
					.prepare(
						`INSERT INTO bill_payments (${Object.keys(
							snapshot.payments[0] ?? {},
						)
							.filter((key) => key !== "bill_name")
							.join(",")})
				 SELECT ${Object.keys(snapshot.payments[0] ?? {})
						.filter((key) => key !== "bill_name")
						.map(jsonColumn)
						.join(",")}
				 FROM json_each(?) WHERE json_extract(value, '$.status') != 'linked' OR (
				 NOT EXISTS (SELECT 1 FROM bill_payments WHERE bill_id=json_extract(value, '$.bill_id') AND period=json_extract(value, '$.period') AND status='linked')
				 AND NOT EXISTS (SELECT 1 FROM bill_payments WHERE transaction_id=json_extract(value, '$.transaction_id') AND status='linked'))`,
					)
					.bind(JSON.stringify(snapshot.payments)),
			);
		await db.batch(writes);
		const linkCheck = await db
			.prepare(
				`SELECT json_extract(value, '$.row_id') AS row_id, json_extract(value, '$.partner_id') AS partner_id,
				 json_extract(value, '$.name') AS name,
				EXISTS (SELECT 1 FROM transactions partner WHERE partner.id=json_extract(value, '$.partner_id'))
				 AND (json_extract(value, '$.only_if_unlinked') = 0 OR transactions.refund_of_id IS NULL)
				 AND ${refundFitsSql("transactions.id", "json_extract(value, '$.partner_id')")} AS fits
				 FROM json_each(?) JOIN transactions ON transactions.id=json_extract(value, '$.row_id')`,
			)
			.bind(JSON.stringify(links))
			.all<{
				row_id: number;
				partner_id: number;
				name: string;
				fits: number;
			}>();
		const fitLinks = linkCheck.results.filter((link) => link.fits);
		const found = new Set(
			fitLinks.map((link) => `${link.row_id}:${link.partner_id}`),
		);
		for (const link of links)
			if (!found.has(`${link.row_id}:${link.partner_id}`))
				lostLinks.push(link.name);
		await db.batch([
			db
				.prepare(
					`UPDATE transactions SET refund_of_id=json_extract(value, '$.partner_id') FROM json_each(?)
				 WHERE transactions.id=json_extract(value, '$.row_id')
				 AND (json_extract(value, '$.only_if_unlinked') = 0 OR transactions.refund_of_id IS NULL)
				 AND ${refundFitsSql("transactions.id", "json_extract(value, '$.partner_id')")}`,
				)
				.bind(JSON.stringify(fitLinks)),
			db.prepare("DELETE FROM cash_delete_holds WHERE token=?").bind(token),
		]);
		return { name: hold.display_name, lostLinks };
	} catch {
		return null;
	}
}

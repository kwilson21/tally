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
		const insertParts = `INSERT INTO transactions (${columns.join(",")}) SELECT ${columns
			.map((column) =>
				column === "refund_of_id" ? "NULL" : jsonColumn(column),
			)
			.join(
				",",
			)} FROM json_each(?) WHERE EXISTS (SELECT 1 FROM cash_delete_holds WHERE token=?)`;
		const targets = [transaction, ...snapshot.parts].map((row) => ({
			id: row.id,
			amount_cents: row.amount_cents,
		}));
		const projectedLinks = links.map((link) => {
			const row = [transaction, ...snapshot.parts, ...snapshot.refunds].find(
				(candidate) => candidate.id === link.row_id,
			);
			return {
				...link,
				move_cents:
					row?.is_split === 1 ? 0 : Math.abs(Number(row?.amount_cents ?? 0)),
			};
		});
		const linkCheck = await db
			.prepare(
				`WITH links AS (SELECT value FROM json_each(?)), targets AS (SELECT value FROM json_each(?))
				 SELECT json_extract(links.value, '$.row_id') AS row_id,
				 json_extract(links.value, '$.partner_id') AS partner_id,
				 json_extract(links.value, '$.name') AS name,
				 EXISTS (SELECT 1 FROM transactions partner WHERE partner.id=json_extract(links.value, '$.partner_id'))
				 OR EXISTS (SELECT 1 FROM targets WHERE json_extract(value, '$.id')=json_extract(links.value, '$.partner_id')) AS partner_exists,
				 COALESCE((SELECT amount_cents FROM transactions WHERE id=json_extract(links.value, '$.partner_id')),
				 (SELECT json_extract(value, '$.amount_cents') FROM targets WHERE json_extract(value, '$.id')=json_extract(links.value, '$.partner_id'))) AS purchase_cents,
				 COALESCE((SELECT SUM(ABS(linked.amount_cents)) FROM transactions linked
					WHERE linked.refund_of_id=json_extract(links.value, '$.partner_id') AND linked.is_split=0
					AND linked.amount_cents<0 AND linked.flag_income=0 AND linked.id!=json_extract(links.value, '$.row_id')), 0) AS refunded_cents,
				 json_extract(links.value, '$.move_cents') AS move_cents,
				 json_extract(links.value, '$.only_if_unlinked') AS only_if_unlinked,
				 (SELECT refund_of_id IS NULL FROM transactions WHERE id=json_extract(links.value, '$.row_id')) AS unlinked
				 FROM links`,
			)
			.bind(JSON.stringify(projectedLinks), JSON.stringify(targets))
			.all<{
				row_id: number;
				partner_id: number;
				name: string;
				partner_exists: number;
				purchase_cents: number | null;
				refunded_cents: number;
				move_cents: number;
				only_if_unlinked: number;
				unlinked: number | null;
			}>();
		const fitLinks = linkCheck.results.filter(
			(link) =>
				link.partner_exists &&
				(link.only_if_unlinked === 0 || link.unlinked === 1) &&
				link.move_cents <=
					Math.max(0, (link.purchase_cents ?? 0) - link.refunded_cents),
		);
		const found = new Set(
			fitLinks.map((link) => `${link.row_id}:${link.partner_id}`),
		);
		for (const link of links)
			if (!found.has(`${link.row_id}:${link.partner_id}`))
				lostLinks.push(link.name);
		const paymentColumns = Object.keys(snapshot.payments[0] ?? {}).filter(
			(key) => key !== "bill_name",
		);
		const writes = [
			db
				.prepare(
					insertTransaction.replace(
						"WHERE json_extract(value, '$.id') = ?",
						"WHERE json_extract(value, '$.id') = ? AND EXISTS (SELECT 1 FROM cash_delete_holds WHERE token=?)",
					),
				)
				.bind(JSON.stringify([transaction]), transaction.id, token),
			db.prepare(insertParts).bind(JSON.stringify(snapshot.parts), token),
		];
		if (snapshot.payments.length > 0)
			writes.push(
				db
					.prepare(
						`INSERT INTO bill_payments (${paymentColumns.join(",")})
					 SELECT ${paymentColumns.map(jsonColumn).join(",")}
					 FROM json_each(?) WHERE (json_extract(value, '$.status') != 'linked' OR (
					 NOT EXISTS (SELECT 1 FROM bill_payments WHERE bill_id=json_extract(value, '$.bill_id') AND period=json_extract(value, '$.period') AND status='linked')
					 AND NOT EXISTS (SELECT 1 FROM bill_payments WHERE transaction_id=json_extract(value, '$.transaction_id') AND status='linked')))
					 AND EXISTS (SELECT 1 FROM cash_delete_holds WHERE token=?)`,
					)
					.bind(JSON.stringify(snapshot.payments), token),
			);
		writes.push(
			db
				.prepare(
					`UPDATE transactions SET refund_of_id=json_extract(value, '$.partner_id') FROM json_each(?)
					 WHERE transactions.id=json_extract(value, '$.row_id')
					 AND (json_extract(value, '$.only_if_unlinked') = 0 OR transactions.refund_of_id IS NULL)
					 AND ${refundFitsSql("transactions.id", "json_extract(value, '$.partner_id')")}
					 AND EXISTS (SELECT 1 FROM cash_delete_holds WHERE token=?)`,
				)
				.bind(JSON.stringify(links), token),
			db.prepare("DELETE FROM cash_delete_holds WHERE token=?").bind(token),
		);
		const results = await db.batch(writes);
		if (results.at(-1)?.meta.changes !== 1) return null;
		return { name: hold.display_name, lostLinks };
	} catch {
		return null;
	}
}

import { refundFitsSql } from "../db/refunded";

type Row = Record<string, unknown>;
type Snapshot = {
	transaction: Row;
	parts: Row[];
	payments: (Row & { bill_name: string })[];
	refunds: Row[];
};

const jsonColumn = (column: string, alias = "") =>
	`json_extract(${alias}value, '$."${column}"')`;

/** Save and delete one cash entry from the same D1 snapshot. */
export async function holdCashDelete(
	db: D1Database,
	id: number,
	displayName: string,
) {
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
	const result = await db.batch([
		db
			.prepare(`INSERT INTO cash_delete_holds (token,created_at,display_name,transaction_row,split_rows,payment_rows,refund_rows)
				SELECT ?, ?, ?, ${jsonObject(transactionColumns)},
				${arrayOf(`SELECT ${jsonObject(transactionColumns)} AS row FROM transactions WHERE parent_id=? ORDER BY id`)},
				${arrayOf(`SELECT ${paymentJson} AS row FROM bill_payments bp JOIN bills b ON b.id=bp.bill_id WHERE bp.transaction_id IN (SELECT id FROM transactions WHERE id=? OR parent_id=?) ORDER BY bp.id`)},
				${arrayOf(`SELECT ${jsonObject(transactionColumns)} AS row FROM transactions WHERE refund_of_id IN (SELECT id FROM transactions WHERE id=? OR parent_id=?) ORDER BY id`)}
				FROM transactions WHERE id=? AND parent_id IS NULL AND account_id IN (SELECT id FROM accounts WHERE type='cash')`)
			.bind(token, Date.now(), displayName, id, id, id, id, id, id),
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
	const hold = await db
		.prepare(
			"SELECT created_at FROM cash_delete_holds WHERE token=? AND restore_marker IS NULL",
		)
		.bind(token)
		.first<{ created_at: number }>();
	return hold
		? Math.min(10_000, Math.max(0, hold.created_at + 10_000 - Date.now()))
		: 0;
}

/** Restores once, only while the token is younger than ten seconds. */
export async function restoreCashDelete(db: D1Database, token: string) {
	const hold = await db
		.prepare("SELECT * FROM cash_delete_holds WHERE token=?")
		.bind(token)
		.first<{
			created_at: number;
			restore_marker: string | null;
			transaction_row: string;
			display_name: string;
			split_rows: string;
			payment_rows: string;
			refund_rows: string;
		}>();
	if (!hold) return null;
	if (hold.restore_marker !== null)
		return { alreadyRestored: true as const, name: hold.display_name };
	const now = Date.now();
	if (hold.created_at <= now - 10_000 || hold.created_at > now) return null;
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
				WHERE json_extract(payments.value, '$.status') = 'linked' AND (
					EXISTS (SELECT 1 FROM bill_payments WHERE bill_id=json_extract(payments.value, '$.bill_id') AND period=json_extract(payments.value, '$.period') AND status='linked')
					OR EXISTS (SELECT 1 FROM bill_payments WHERE transaction_id=COALESCE(
						(SELECT new_id FROM targets WHERE old_id=CAST(json_extract(payments.value, '$.transaction_id') AS INTEGER)),
						CAST(json_extract(payments.value, '$.transaction_id') AS INTEGER)) AND status='linked'))`,
			)
			.bind(
				JSON.stringify([transaction, ...snapshot.parts]),
				JSON.stringify(snapshot.payments),
			)
			.all<{ name: string }>();
		const lostLinks = paymentCheck.results.map(({ name }) => `${name} payment`);
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
		const writes = [
			db
				.prepare(
					"UPDATE cash_delete_holds SET restore_marker=? WHERE token=? AND restore_marker IS NULL AND created_at>? AND created_at<=?",
				)
				.bind(marker, token, now - 10_000, now),
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
						 FROM json_each(?) AS payments WHERE (json_extract(value, '$.status') != 'linked' OR (
						 NOT EXISTS (SELECT 1 FROM bill_payments WHERE bill_id=json_extract(value, '$.bill_id') AND period=json_extract(value, '$.period') AND status='linked')
						 AND NOT EXISTS (SELECT 1 FROM bill_payments WHERE transaction_id=COALESCE(
							(SELECT new_id FROM targets WHERE old_id=json_extract(payments.value, '$.transaction_id')),
							json_extract(payments.value, '$.transaction_id')) AND status='linked')))
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
		const results = await db.batch(writes);
		if (results[0]?.meta.changes !== 1) return null;
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
		return {
			name: hold.display_name,
			lostLinks,
			alreadyRestored: false as const,
		};
	} catch {
		return null;
	}
}

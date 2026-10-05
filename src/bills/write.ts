// The writes that make a bill's name count (spec §8.5): no two active bills share a name, ignoring
// case and surrounding spaces. The form checks first, for a friendly message, but two saves can both
// pass that check, so each write here checks again as part of the same statement: it changes nothing
// when another active bill already has the name, and says so by returning false. There's no unique
// index: a bank-synced family may already hold duplicates, and an index would fail to apply.
//
// SQLite's lower() only folds ASCII capitals, so for "Café" against "CAFÉ" this check is weaker than
// the form's; the form's check still catches those unless two saves race on exactly such a name.

export type BillFields = {
	name: string;
	amountCents: number;
	dueDay: number;
	frequency: "monthly" | "yearly";
	anchorMonth: number | null;
	categoryId: number;
	merchantRawName: string;
};

/** True when no other active bill has the name; binds the bill's own id (null for a new bill), then the name. */
const FREE =
	"NOT EXISTS (SELECT 1 FROM bills other WHERE other.active=1 AND other.id IS NOT ? AND lower(trim(other.name))=lower(trim(?)))";

/** Adds a bill. False, with nothing written, when an active bill already has its name. */
export async function insertBill(
	db: D1Database,
	f: BillFields,
): Promise<boolean> {
	const { meta } = await db
		.prepare(
			`INSERT INTO bills(name,amount_cents,due_day,frequency,anchor_month,category_id,merchant_raw_name)
			 SELECT ?,?,?,?,?,?,? WHERE ${FREE}`,
		)
		.bind(
			f.name,
			f.amountCents,
			f.dueDay,
			f.frequency,
			f.anchorMonth,
			f.categoryId,
			f.merchantRawName,
			null,
			f.name,
		)
		.run();
	return meta.changes > 0;
}

/**
 * Changes a bill. False, with nothing written, when another active bill has the new name.
 * `dropDismissals` is for a changed schedule: old dismissals no longer apply (period keys have
 * different shapes, YYYY-MM against YYYY), and they go in the same batch, under the same check.
 */
export async function updateBill(
	db: D1Database,
	id: number,
	f: BillFields,
	dropDismissals: boolean,
): Promise<boolean> {
	const update = db
		.prepare(
			`UPDATE bills SET name=?,amount_cents=?,due_day=?,frequency=?,anchor_month=?,category_id=?,merchant_raw_name=?
			 WHERE id=? AND ${FREE}`,
		)
		.bind(
			f.name,
			f.amountCents,
			f.dueDay,
			f.frequency,
			f.anchorMonth,
			f.categoryId,
			f.merchantRawName,
			id,
			id,
			f.name,
		);
	if (!dropDismissals) return (await update.run()).meta.changes > 0;
	const [result] = await db.batch([
		update,
		db
			.prepare(`DELETE FROM bill_payments WHERE bill_id=? AND ${FREE}`)
			.bind(id, id, f.name),
	]);
	return (result?.meta.changes ?? 0) > 0;
}

/**
 * Makes a bill active under `name`, which is its own name or a new one typed to get past a repeat.
 * False, with nothing written, when another active bill has that name or there is no such bill.
 */
export async function activateBill(
	db: D1Database,
	id: number,
	name: string,
): Promise<boolean> {
	const { meta } = await db
		.prepare(`UPDATE bills SET active=1,name=? WHERE id=? AND ${FREE}`)
		.bind(name, id, id, name)
		.run();
	return meta.changes > 0;
}

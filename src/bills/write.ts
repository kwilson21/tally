// The writes that make a bill's name count (spec §8.5): no two active bills share a name, ignoring
// case and surrounding spaces. The form checks first, for a friendly message, but two saves can both
// pass that check, so each write here checks again as part of the same statement: it changes nothing
// when another active bill already has the name, and says so by returning false. There's no unique
// index: a bank-synced family may already hold duplicates, and an index would fail to apply.
//
// "The same name" is exactly SQLite's `lower(trim(name))`: only spaces trimmed from the ends and only
// A to Z folded, so "Café" and "CAFÉ" are different names. The form's check (guards.ts, sameName)
// compares the very same way, so whatever the form lets through the write lets through, and no race
// can leave two active bills the form would call duplicates. Change one and change the other.
//
// Only a name that is new is checked: adding, reactivating and renaming. Editing a bill under the
// name it already has isn't, so two bills that already share a name stay editable.

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

/**
 * Adds a bill. False, with nothing written, when an active bill already has its name. Its merchant text
 * is a key, not the bank's raw text from before Phase 3.5, so `merchant_raw_text` is 0 (spec §6.1).
 */
export async function insertBill(
	db: D1Database,
	f: BillFields,
): Promise<boolean> {
	const { meta } = await db
		.prepare(
			`INSERT INTO bills(name,amount_cents,due_day,frequency,anchor_month,category_id,merchant_raw_name,merchant_raw_text)
			 SELECT ?,?,?,?,?,?,?,0 WHERE ${FREE}`,
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
 * Changes a bill. False, with nothing written, when another active bill has the new name. A name
 * that is the bill's own, as it is stored (spaces and A to Z case aside), is never checked, so a
 * bill that already shares its name with another one (the data may hold such pairs from before this
 * rule) can still have its amount or day changed; only a new name has to be free.
 * A changed merchant text is a new write, saved as a key (`merchant_raw_text` 0); an unchanged one keeps
 * its flag, so a bill from before Phase 3.5 keeps matching on the bank's raw text (spec §6.1).
 * `dropDismissals` is for a changed schedule: old dismissals no longer apply (period keys have
 * different shapes, YYYY-MM against YYYY), and they go in the same batch, once the update applied.
 */
export async function updateBill(
	db: D1Database,
	id: number,
	f: BillFields,
	dropDismissals: boolean,
): Promise<boolean> {
	// In an UPDATE's WHERE, `name` is the row's name as it is now, before the SET.
	const update = db
		.prepare(
			`UPDATE bills SET name=?,amount_cents=?,due_day=?,frequency=?,anchor_month=?,category_id=?,
			   merchant_raw_text=CASE WHEN merchant_raw_name=? THEN merchant_raw_text ELSE 0 END,merchant_raw_name=?
			 WHERE id=? AND (lower(trim(name))=lower(trim(?)) OR ${FREE})`,
		)
		.bind(
			f.name,
			f.amountCents,
			f.dueDay,
			f.frequency,
			f.anchorMonth,
			f.categoryId,
			f.merchantRawName,
			f.merchantRawName,
			id,
			f.name,
			id,
			f.name,
		);
	if (!dropDismissals) return (await update.run()).meta.changes > 0;
	// The bill has its new name exactly when the update just applied (it set it, and a refused update
	// leaves a name that differs), so the dismissals go only then.
	const [result] = await db.batch([
		update,
		db
			.prepare(
				"DELETE FROM bill_payments WHERE bill_id=? AND EXISTS (SELECT 1 FROM bills WHERE id=? AND name=?)",
			)
			.bind(id, id, f.name),
	]);
	return (result?.meta.changes ?? 0) > 0;
}

/**
 * The statement that goes right before a payment is linked to a bill occurrence (spec §6.1 rule 4,
 * decision 67): an excluded payment can pay a bill, and linking it puts it back in the budget as a
 * person's choice (`excluded = 0`, `excluded_source = 'user'`), so the bill stops being set aside only
 * because its payment now counts as spending, and Jev or a sync never takes it out again.
 *
 * It runs first, in the same batch as the link's insert, and only when that insert will be new: no
 * linked row for the transaction, and none for the occurrence. So a refused link (already linked, or the
 * occurrence taken) changes nothing, and an excluded payment can't be put back without the link that
 * explains why. A split is one bank transaction (the edit panel excludes it whole), so its parent and
 * parts come back together. `actor` is who is linking by hand; the matcher passes null and leaves
 * `updated_by` as it was.
 *
 * `also` is a further condition for a caller whose link is conditional too (accepting a price change,
 * which must put nothing back when the offer has gone stale). Its SQL may use ?1 to ?3 as above and
 * numbers its own parameters from ?5, after `actor` (?4); its `binds` are those values, in order.
 */
export function putBackInBudget(
	db: D1Database,
	billId: number,
	period: string,
	transactionId: number,
	actor: string | null,
	also?: { sql: string; binds: (string | number)[] },
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE transactions SET excluded = 0, excluded_source = 'user', updated_by = COALESCE(?4, updated_by), updated_at = datetime('now')
			 WHERE excluded = 1 AND (
				id = ?1
				OR parent_id = ?1
				OR id = (SELECT parent_id FROM transactions WHERE id = ?1)
				OR parent_id = (SELECT parent_id FROM transactions WHERE id = ?1)
			 )
			 AND NOT EXISTS (
				SELECT 1 FROM bill_payments linked WHERE linked.status = 'linked'
				  AND (linked.transaction_id = ?1 OR (linked.bill_id = ?2 AND linked.period = ?3))
			 )${also ? ` AND (${also.sql})` : ""}`,
		)
		.bind(transactionId, billId, period, actor, ...(also?.binds ?? []));
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

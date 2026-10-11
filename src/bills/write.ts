import { householdMonth } from "../dates";

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

// Amounts by month (spec §5 `bill_amounts`, decision 101): a changed amount writes this month's row, so
// earlier months keep theirs, and a second change in the same month replaces that row. `bills.amount_cents`
// always holds the current amount.

export type BillFields = {
	name: string;
	amountCents: number;
	dueDay: number;
	frequency: "monthly" | "yearly" | "weekly" | "biweekly" | "quarterly";
	anchorMonth: number | null;
	anchorDate?: string | null;
	categoryId: number;
	merchantRawName: string;
};

/** True when no other active bill has the name; binds the bill's own id (null for a new bill), then the name. */
const FREE =
	"NOT EXISTS (SELECT 1 FROM bills other WHERE other.active=1 AND other.id IS NOT ? AND lower(trim(other.name))=lower(trim(?)))";

/**
 * Adds a bill. False, with nothing written, when an active bill already has its name. Its merchant text
 * is a key, not the bank's raw text from before Phase 3.5, so `merchant_raw_text` is 0 (spec §6.1). Its
 * first `bill_amounts` row is this month's (the household's), so the amount applies from this month on.
 */
export async function insertBill(
	db: D1Database,
	f: BillFields,
	/** The household's month (YYYY-MM) when the caller has it; read here otherwise. */
	month?: string,
): Promise<boolean> {
	const { meta } = await db
		.prepare(
			`INSERT INTO bills(name,amount_cents,due_day,frequency,anchor_month,anchor_date,category_id,merchant_raw_name,merchant_raw_text)
			 SELECT ?,?,?,?,?,?,?,?,0 WHERE ${FREE}`,
		)
		.bind(
			f.name,
			f.amountCents,
			f.dueDay,
			f.frequency,
			f.anchorMonth,
			f.anchorDate ?? null,
			f.categoryId,
			f.merchantRawName,
			null,
			f.name,
		)
		.run();
	if (!meta.changes) return false;
	// A second statement, because a batch can't pass the new bill's id to the one after it. It is written
	// right after the bill; were it missing, the bill's amount would still show, but a later change would
	// reach back to months before it, so it is never left out.
	await db
		.prepare(
			"INSERT INTO bill_amounts (bill_id, effective_month, amount_cents) VALUES (?, ?, ?)",
		)
		.bind(meta.last_row_id, month ?? (await householdMonth(db)), f.amountCents)
		.run();
	return true;
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
	/** The household's month (YYYY-MM) when the caller has it, which a changed amount applies from. */
	month?: string,
): Promise<boolean> {
	// In an UPDATE's WHERE, `name` is the row's name as it is now, before the SET.
	const update = db
		.prepare(
			`UPDATE bills SET name=?,amount_cents=?,due_day=?,frequency=?,anchor_month=?,anchor_date=?,category_id=?,
			   merchant_raw_text=CASE WHEN merchant_raw_name=? THEN merchant_raw_text ELSE 0 END,merchant_raw_name=?
			 WHERE id=? AND (lower(trim(name))=lower(trim(?)) OR ${FREE})`,
		)
		.bind(
			f.name,
			f.amountCents,
			f.dueDay,
			f.frequency,
			f.anchorMonth,
			f.anchorDate ?? null,
			f.categoryId,
			f.merchantRawName,
			f.merchantRawName,
			id,
			f.name,
			id,
			f.name,
		);
	// A changed amount writes this month's row. It is guarded like the dismissals below: it is written
	// only when the update just applied (the bill then has the new name and amount), so a refused save
	// leaves no row behind.
	const current = await db
		.prepare("SELECT amount_cents FROM bills WHERE id=?")
		.bind(id)
		.first<{ amount_cents: number }>();
	const statements = [update];
	if (current && current.amount_cents !== f.amountCents)
		statements.push(
			db
				.prepare(
					`INSERT INTO bill_amounts (bill_id, effective_month, amount_cents)
					 SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM bills WHERE id=?1 AND name=?4 AND amount_cents=?3)
					 ON CONFLICT (bill_id, effective_month) DO UPDATE SET amount_cents = excluded.amount_cents`,
				)
				.bind(id, month ?? (await householdMonth(db)), f.amountCents, f.name),
		);
	// The bill has its new name exactly when the update just applied (it set it, and a refused update
	// leaves a name that differs), so the dismissals go only then.
	if (dropDismissals)
		statements.push(
			db
				.prepare(
					"DELETE FROM bill_payments WHERE bill_id=? AND EXISTS (SELECT 1 FROM bills WHERE id=? AND name=?)",
				)
				.bind(id, id, f.name),
		);
	// A lone update runs on its own, as it always has; with a row or dismissals to go with it, they go in one batch.
	const [result] =
		statements.length > 1 ? await db.batch(statements) : [await update.run()];
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

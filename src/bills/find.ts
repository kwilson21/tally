/** Rules for finding monthly bills from recent charges (spec §8.2, P18). */
export const BILL_FIND_MONTHS = 3;
export const BILL_FIND_MIN_DAYS = 25;
export const BILL_FIND_MAX_DAYS = 35;
export const BILL_FIND_AMOUNT_PERCENT = 10;

export type BillFindingCharge = {
	rawName: string;
	displayName: string;
	date: string;
	amountCents: number;
	categoryId: number | null;
	defaultCategoryId?: number | null;
};
export type BillSuggestion = {
	rawName: string;
	displayName: string;
	amountCents: number;
	dueDay: number;
	categoryId: number | null;
	chargeCount: number;
};

const epochDay = (date: string) =>
	Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
export function findBillSuggestions(
	charges: BillFindingCharge[],
): BillSuggestion[] {
	const groups = new Map<string, BillFindingCharge[]>();
	for (const charge of charges) {
		const list = groups.get(charge.rawName) ?? [];
		list.push(charge);
		groups.set(charge.rawName, list);
	}
	const suggestions: BillSuggestion[] = [];
	for (const list of groups.values()) {
		list.sort((a, b) => a.date.localeCompare(b.date));
		if (list.length < 2) continue;
		// The newest charge must repeat an earlier one (other purchases may fall between),
		// so a store that once matched by chance doesn't show up.
		const latest = list[list.length - 1] as BillFindingCharge;
		const partner = list.slice(0, -1).some((previous) => {
			const days = epochDay(latest.date) - epochDay(previous.date);
			return (
				days >= BILL_FIND_MIN_DAYS &&
				days <= BILL_FIND_MAX_DAYS &&
				Math.abs(latest.amountCents - previous.amountCents) * 100 <=
					previous.amountCents * BILL_FIND_AMOUNT_PERCENT
			);
		});
		if (!partner) continue;
		const counts = new Map<number, number>();
		for (const row of list)
			if (row.categoryId != null)
				counts.set(row.categoryId, (counts.get(row.categoryId) ?? 0) + 1);
		const categoryId =
			latest.defaultCategoryId ??
			[...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ??
			null;
		suggestions.push({
			rawName: latest.rawName,
			displayName: latest.displayName,
			amountCents: latest.amountCents,
			dueDay: Number(latest.date.slice(8)),
			categoryId,
			chargeCount: list.length,
		});
	}
	return suggestions.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function threeMonthsBack(today: string) {
	const source = new Date(`${today}T00:00:00Z`);
	const day = source.getUTCDate();
	const date = new Date(
		Date.UTC(
			source.getUTCFullYear(),
			source.getUTCMonth() - BILL_FIND_MONTHS,
			1,
		),
	);
	const lastDay = new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
	).getUTCDate();
	date.setUTCDate(Math.min(day, lastDay));
	return date.toISOString().slice(0, 10);
}
export async function loadBillSuggestions(
	db: D1Database,
	today: string,
): Promise<BillSuggestion[]> {
	const { results } = await db
		.prepare(`SELECT COALESCE(p.raw_name,t.raw_name) AS rawName,
	  COALESCE(m.display_name,m.suggested_name,p.raw_name,t.raw_name) AS displayName,
	  t.date, t.amount_cents AS amountCents,
	  CASE WHEN tc.archived=0 THEN t.category_id END AS categoryId,
	  CASE WHEN dc.archived=0 THEN m.default_category_id END AS defaultCategoryId
	  FROM transactions t LEFT JOIN transactions p ON p.id=t.parent_id
	  LEFT JOIN merchants m ON m.raw_name=COALESCE(p.raw_name,t.raw_name)
	  LEFT JOIN categories tc ON tc.id=t.category_id
	  LEFT JOIN categories dc ON dc.id=m.default_category_id
	  WHERE t.date >= ? AND t.date <= ? AND t.amount_cents > 0 AND t.excluded=0 AND t.flag_income=0
	   AND t.is_split=0 AND COALESCE(m.not_a_bill,0)=0
	   AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.merchant_raw_name=COALESCE(p.raw_name,t.raw_name))
	  ORDER BY COALESCE(p.raw_name,t.raw_name),t.date`)
		.bind(threeMonthsBack(today), today)
		.all<BillFindingCharge>();
	return findBillSuggestions(results);
}

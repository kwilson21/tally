// A bill's amount by month (spec §5 `bill_amounts`, §8.4; decisions 74, 79 and 101). Editing a bill's
// amount writes a row from this month on, so an occurrence keeps the amount of its own month: the row
// with the latest effective month on or before the occurrence's month (its due date's month). A month
// before the first row uses the first row, so a bill's history starts wherever its first row does. A bill
// with no rows at all uses its own amount (`bills.amount_cents`, which always holds the current amount).

export type AmountRow = { effectiveMonth: string; amountCents: number };

/** The amount an occurrence due in `month` (YYYY-MM) is judged at. Order of `rows` does not matter. */
export function amountForMonth(
	rows: readonly AmountRow[],
	month: string,
	fallbackCents: number,
): number {
	let latest: AmountRow | undefined;
	let earliest: AmountRow | undefined;
	for (const row of rows) {
		if (
			row.effectiveMonth <= month &&
			(!latest || row.effectiveMonth > latest.effectiveMonth)
		)
			latest = row;
		if (!earliest || row.effectiveMonth < earliest.effectiveMonth)
			earliest = row;
	}
	return (latest ?? earliest)?.amountCents ?? fallbackCents;
}

export type PriceChange = {
	effectiveMonth: string;
	amountCents: number;
	direction: "up" | "down";
};

/**
 * The newest change of price: the latest row whose amount differs from the row before it, or undefined
 * when every row agrees (an edit to the same amount is not a change). Bills' page says it in one line.
 */
export function latestPriceChange(
	rows: readonly AmountRow[],
): PriceChange | undefined {
	const ordered = [...rows].sort((a, b) =>
		a.effectiveMonth.localeCompare(b.effectiveMonth),
	);
	let change: PriceChange | undefined;
	for (let i = 1; i < ordered.length; i++) {
		const before = ordered[i - 1];
		const after = ordered[i];
		if (!before || !after || before.amountCents === after.amountCents) continue;
		change = {
			effectiveMonth: after.effectiveMonth,
			amountCents: after.amountCents,
			direction: after.amountCents > before.amountCents ? "up" : "down",
		};
	}
	return change;
}

/**
 * What earlier months keep when the amount changes from `month` on: the latest row before `month`, or
 * undefined when the bill has no earlier row (its price never had a history before this month). The
 * edit sheet says "Earlier months keep $X" only when this is defined (decision 101).
 */
export function earlierAmount(
	rows: readonly AmountRow[],
	month: string,
): number | undefined {
	let latest: AmountRow | undefined;
	for (const row of rows)
		if (
			row.effectiveMonth < month &&
			(!latest || row.effectiveMonth > latest.effectiveMonth)
		)
			latest = row;
	return latest?.amountCents;
}

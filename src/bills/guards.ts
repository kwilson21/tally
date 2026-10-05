// Two checks before a bill is saved (spec §8.5, decision 72): no two active bills share a name, and
// an amount over $100,000.00 is saved only when the person has confirmed that exact amount. Pure, so
// the route only has to ask them.

/** A bill may be this much without asking; one cent more has to be confirmed. */
export const BIG_BILL_CENTS = 10_000_000;

/**
 * What is compared: exactly what the database's `lower(trim(name))` makes of it (src/bills/write.ts),
 * so what the form turns away and what the write turns away are the same names. That is only spaces
 * trimmed from the ends and only A to Z folded, so "Café" and "CAFÉ" are different names, as they
 * are for categories (a NOCASE index).
 */
const sameName = (name: string) =>
	name.replace(/^ +| +$/g, "").replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * The name of the other active bill that `name` repeats, ignoring case and surrounding spaces, or
 * undefined. `ignoreId` is the bill being edited, which may keep its own name.
 */
export function duplicateBillName(
	bills: { id: number; name: string; active: number | boolean }[],
	name: string,
	ignoreId?: number,
): string | undefined {
	const wanted = sameName(name);
	return bills
		.find((b) => b.active && b.id !== ignoreId && sameName(b.name) === wanted)
		?.name.trim();
}

/**
 * Whether an amount still has to be confirmed. `confirmed` is what the ticked chip sent: the cents
 * it was drawn for. It counts only when it is exactly this amount in cents, so changing the amount
 * after ticking asks again.
 */
export function needsBigAmountConfirm(
	cents: number,
	confirmed: string,
): boolean {
	return cents > BIG_BILL_CENTS && confirmed !== String(cents);
}

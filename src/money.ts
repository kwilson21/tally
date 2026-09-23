// Money is integer cents everywhere. Convert at the edges only: form input, Plaid, display.

const DOLLARS = /^-?\d+(\.\d{1,2})?$/;

/** Parses a typed dollar amount ("$1,284.50") into integer cents. Throws on anything else. */
export function toCents(input: string): number {
	const cleaned = input.trim().replace(/[$,]/g, "");
	if (!DOLLARS.test(cleaned)) throw new Error(`Not a dollar amount: ${input}`);
	const negative = cleaned.startsWith("-");
	const [whole = "0", fraction = ""] = cleaned.replace("-", "").split(".");
	const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
	return negative ? -cents : cents;
}

/** Converts Plaid's float amount to integer cents via its decimal string, so 1.005 → 101, not 100. */
export function plaidAmountToCents(amount: number): number {
	const [whole, fraction = ""] = Math.abs(amount).toFixed(3).split(".");
	const thousandths = Number(whole) * 1000 + Number(fraction);
	const cents = Math.round(thousandths / 10);
	return amount < 0 ? -cents : cents;
}

type FormatOptions = {
	/** "$1,284" instead of "$1,284.00" (headline amounts). */
	wholeDollars?: boolean;
	/** Show money in (negative, per Plaid) as "+$…" and money out with no sign. */
	signed?: boolean;
};

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const wholeDollars = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	maximumFractionDigits: 0,
});

/** Formats integer cents for display. */
export function formatCents(cents: number, options: FormatOptions = {}): string {
	const formatter = options.wholeDollars ? wholeDollars : dollars;
	const text = formatter.format(Math.abs(cents) / 100);
	if (options.signed) return cents < 0 ? `+${text}` : text;
	return cents < 0 ? `-${text}` : text;
}

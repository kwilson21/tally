// Money is integer cents everywhere. Convert at the edges only: form input, Plaid, display.

// Requires comma grouping in threes ("1,000", "12,345.67") when commas are present; a bare
// run of digits is also fine ("1000"). Rejects "12,34", "1,00", "1,2345", and a leading ",100".
const DOLLARS = /^-?\$?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/;

/** Parses a typed dollar amount ("$1,284.50") into integer cents. Throws on anything else. */
export function toCents(input: string): number {
	const trimmed = input.trim();
	if (!DOLLARS.test(trimmed)) throw new Error(`Not a dollar amount: ${input}`);
	const cleaned = trimmed.replace(/[$,]/g, "");
	const negative = cleaned.startsWith("-");
	const [whole = "0", fraction = ""] = cleaned.replace("-", "").split(".");
	const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
	return negative ? -cents : cents;
}

/**
 * Converts Plaid's float amount to integer cents without trusting toFixed's decimal
 * reconstruction. toPrecision(15) recovers the decimal a double was actually parsed from
 * (doubles carry ~15-17 significant digits, and 15 is safely inside that without picking up
 * binary-representation noise); the thousandths digit is then rounded half-up by hand to get
 * cents. Amounts under half a cent (abs < 0.005) are zero, including -0, which real Plaid data
 * never produces but which floating-point subtraction (e.g. 0.1 - 0.1) can.
 */
export function plaidAmountToCents(amount: number): number {
	if (!Number.isFinite(amount) || Math.abs(amount) >= 1e13) {
		throw new Error(`Not a Plaid amount: ${amount}`);
	}
	const abs = Math.abs(amount);
	if (abs < 0.005) return 0;
	const [whole = "0", fraction = ""] = abs.toPrecision(15).split(".");
	const digits = fraction.padEnd(3, "0");
	const cents =
		Number(whole) * 100 +
		Number(digits.slice(0, 2)) +
		(Number(digits[2]) >= 5 ? 1 : 0);
	return amount < 0 ? -cents : cents;
}

type FormatOptions = {
	/** "$1,284" instead of "$1,284.00" (headline amounts). */
	wholeDollars?: boolean;
	/** Show money in (negative, per Plaid) as "+$…" and money out with no sign. */
	signed?: boolean;
};

const dollars = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
});
const wholeDollars = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	maximumFractionDigits: 0,
});

/** Integer cents as a form field's value: "600" or "612.50", no symbol or commas. toCents reads it back. */
export function centsToInput(cents: number): string {
	if (!Number.isSafeInteger(cents))
		throw new Error(`Not integer cents: ${cents}`);
	const sign = cents < 0 ? "-" : "";
	const whole = Math.floor(Math.abs(cents) / 100);
	const rest = Math.abs(cents) % 100;
	return rest === 0
		? `${sign}${whole}`
		: `${sign}${whole}.${String(rest).padStart(2, "0")}`;
}

/** Formats integer cents for display. */
export function formatCents(
	cents: number,
	options: FormatOptions = {},
): string {
	const formatter = options.wholeDollars ? wholeDollars : dollars;
	const text = formatter.format(Math.abs(cents) / 100);
	if (options.signed) return cents < 0 ? `+${text}` : text;
	return cents < 0 ? `-${text}` : text;
}

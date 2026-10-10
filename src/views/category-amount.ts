import { formatCents } from "../money";

const centsWhenAny = (cents: number) =>
	formatCents(cents, {
		wholeDollars: cents === 0 || (Math.abs(cents) >= 100 && cents % 100 === 0),
	});

/** One signed amount and color for a category's row: Home, a Not budgeted row and finished-month rows. */
export function categoryRowAmount(cents: number) {
	return cents < 0
		? {
				text: `+${centsWhenAny(-cents)}`,
				className: "text-right text-lg text-ok",
			}
		: { text: centsWhenAny(cents), className: "text-right text-lg" };
}

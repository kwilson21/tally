// The demo's Apple Card sample (spec §8.10, #766): a made-up file in Apple's layout, as if the Riveras had exported it. Its
// stores are the demo seed's own, and its dates are counted back from the seeded bank's latest transaction (the anchor),
// so a second "Add the sample" finds every row already held. Tests read it as Apple's file; no family's export is here.

import { daysBefore } from "../dates";

/** The sample's balance owed, in cents: what the demo's card counts in net worth (spec §8.10). */
export const APPLE_CARD_SAMPLE_BALANCE_CENTS = 124018;

const HEADER = [
	"Transaction Date",
	"Clearing Date",
	"Description",
	"Merchant",
	"Category",
	"Type",
	"Amount (USD)",
	"Purchased By",
];

/** Apple's own quoting: every field in quotes, a quote doubled inside one. */
const quote = (text: string) => `"${text.replaceAll('"', '""')}"`;

/** YYYY-MM-DD as Apple writes a date: MM/DD/YYYY, zero-padded. */
const apple = (day: string) =>
	`${day.slice(5, 7)}/${day.slice(8, 10)}/${day.slice(0, 4)}`;

/**
 * The sample for an anchor day (YYYY-MM-DD): 14 rows, 13 of them cleared. Each row's dates are counted back from the
 * anchor (`cleared` and `sent` are days before it), so every cleared row is within 22 days of the anchor. The rows hold a
 * pair of identical purchases (twins), a Payment, a bounced payment (an Other row that says REVERSAL and takes money
 * out), a Credit refund, an Interest row, and one row with no Clearing Date yet.
 */
export function appleCardSample(anchor: string): string {
	const row = (
		cleared: number | null,
		sent: number,
		description: string,
		merchant: string,
		category: string,
		type: string,
		amount: string,
	) =>
		[
			apple(daysBefore(anchor, sent)),
			cleared === null ? "" : apple(daysBefore(anchor, cleared)),
			...[description, merchant, category, type, amount, "Pat Rivera"].map(
				quote,
			),
		].join(",");
	const rows = [
		row(
			20,
			22,
			"SQ *FARMERS MKT 5 OAK ST SPRINGFIELD 00000 XX USA",
			"Farmers Market",
			"Grocery",
			"Purchase",
			"38.40",
		),
		row(
			14,
			15,
			"BLUE BOTTLE COFFEE 12 MAIN ST SPRINGFIELD 00000 XX USA",
			"Blue Bottle Coffee",
			"Food & Drink",
			"Purchase",
			"6.50",
		),
		row(
			14,
			15,
			"BLUE BOTTLE COFFEE 12 MAIN ST SPRINGFIELD 00000 XX USA",
			"Blue Bottle Coffee",
			"Food & Drink",
			"Purchase",
			"6.50",
		),
		row(
			11,
			12,
			"THAI PALACE 8 ELM AVE SPRINGFIELD 00000 XX USA",
			"Thai Palace",
			"Food & Drink",
			"Purchase",
			"72.00",
		),
		row(
			9,
			10,
			"COSTCO WHSE #0431 40 PINE RD SPRINGFIELD 00000 XX USA",
			"Costco",
			"Grocery",
			"Purchase",
			"164.22",
		),
		row(
			7,
			8,
			"TST* CORNER DELI 3 BIRCH LN SPRINGFIELD 00000 XX USA",
			"Corner Deli Cafe",
			"Food & Drink",
			"Purchase",
			"8.25",
		),
		row(
			6,
			6,
			"GOOGLE *YOUTUBE PREMIUM SPRINGFIELD 00000 XX USA",
			"Google",
			"Entertainment",
			"Purchase",
			"13.99",
		),
		row(
			4,
			5,
			"DD *DOORDASH TACO SPRINGFIELD 00000 XX USA",
			"DoorDash",
			"Food & Drink",
			"Purchase",
			"15.08",
		),
		row(
			3,
			4,
			"THE HOME DEPOT #6612 2 ELM AVE SPRINGFIELD 00000 XX USA",
			"The Home Depot",
			"Shopping",
			"Purchase",
			"54.17",
		),
		row(
			2,
			2,
			"ONLINE PAYMENT THANK YOU",
			"Apple Card",
			"Payment",
			"Payment",
			"-180.00",
		),
		row(2, 3, "REVERSAL ONLINE PAYMENT THANK YOU", "", "", "Other", "180.00"),
		row(
			1,
			1,
			"CORNER DELI REFUND 3 BIRCH LN SPRINGFIELD 00000 XX USA",
			"Corner Deli Cafe",
			"Food & Drink",
			"Credit",
			"-8.25",
		),
		row(
			1,
			1,
			"INTEREST CHARGED ON PURCHASES",
			"Apple Card",
			"Interest",
			"Interest",
			"4.12",
		),
		row(
			null,
			0,
			"THAI PALACE 8 ELM AVE SPRINGFIELD 00000 XX USA",
			"Thai Palace",
			"Food & Drink",
			"Purchase",
			"24.00",
		),
	];
	return [HEADER.map(quote).join(","), ...rows].join("\n");
}

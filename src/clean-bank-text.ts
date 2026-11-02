// The bank's text for a purchase, cleaned so that purchases from one place read the same (decision 156).
// It is never the store's display name: it comes only from the bank's raw text, and it is what the re-sort
// groups by (decision 157). Pure, no I/O.
//
// What goes, in this order:
// - a "POS DEBIT", "POS CREDIT", "POS PURCHASE", "CHECKCARD" or "DEBIT CARD PURCHASE" prefix at the start, and the
//   terminal code after "POS" or "CHECKCARD" when there is one ("CHECKCARD 0921 CVS" keeps "cvs"); a bare "POS" stays,
//   since it can be part of a store's name;
// - a reference ID after "*" when it contains a digit ("Kindle Unltd*TE3E10I7" keeps "Kindle Unltd"; "GOOGLE *YOUTUBE"
//   keeps its word, since it has no digit);
// - a month/day date, "MM/DD" or "M/D", anywhere in the text;
// - a US state or DC code as the last word, only when something comes before it and only in capitals
//   (so "ca" or "Me" inside a name is never cut).
//
// What stays on purpose: a trailing city. A city can't be told from the end of a store's name without a list
// of cities, and a wrong cut would merge two different stores. So "Museum of the Bible Washington DC 08/04"
// cleans to "museum of the bible washington". Over-cleaning merges stores; under-cleaning only leaves two rows
// apart, so the rules err toward leaving text alone.
//
// Casing: the result is lowercase, always. Matching a state code is done on the capitals before lowercasing.

const US_STATE_CODES = new Set([
	"AL",
	"AK",
	"AZ",
	"AR",
	"CA",
	"CO",
	"CT",
	"DE",
	"FL",
	"GA",
	"HI",
	"ID",
	"IL",
	"IN",
	"IA",
	"KS",
	"KY",
	"LA",
	"ME",
	"MD",
	"MA",
	"MI",
	"MN",
	"MS",
	"MO",
	"MT",
	"NE",
	"NV",
	"NH",
	"NJ",
	"NM",
	"NY",
	"NC",
	"ND",
	"OH",
	"OK",
	"OR",
	"PA",
	"RI",
	"SC",
	"SD",
	"TN",
	"TX",
	"UT",
	"VT",
	"VA",
	"WA",
	"WV",
	"WI",
	"WY",
	"DC",
]);

// A prefix a card terminal adds before the merchant, with its transaction code when it has one ("CHECKCARD 0921",
// "POS 4417"). The code alternative comes first, so the bare CHECKCARD does not win and leave the code behind.
// The lookahead needs a space or the end after it, so "POS DEBITS" or a store called "POS DEBITING" is not cut.
const PREFIX =
	/^(?:(?:POS|CHECKCARD)\s+\d+|POS\s+(?:DEBIT|CREDIT|PURCHASE)|CHECKCARD|DEBIT\s+CARD\s+PURCHASE)(?=\s|$)\s*/i;
// "*" then letters and digits, with at least one digit: a reference ID, not a word after a processor's "*".
const REFERENCE_ID = /\*[A-Z0-9]*\d[A-Z0-9]*/gi;
// A month/day date, "09/30" or "9/3". The lookarounds keep it from cutting inside a URL path or a longer number.
const DATE = /(?<![\w./])\d{1,2}\/\d{1,2}(?![\w/])/g;

/**
 * The cleaned bank text of a raw bank string. Returns "" when nothing is left (for example "POS DEBIT" alone);
 * a caller must not group empty text.
 */
export function cleanBankText(raw: string): string {
	let text = raw.replace(/\s+/g, " ").trim();
	text = text.replace(PREFIX, "");
	text = text.replace(REFERENCE_ID, "");
	text = text.replace(DATE, "");
	text = collapse(text);

	const words = text.split(" ");
	const last = words[words.length - 1];
	if (words.length > 1 && last !== undefined && US_STATE_CODES.has(last)) {
		words.pop();
		text = words.join(" ");
	}

	return text.toLowerCase();
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

// Until a person names a merchant, the list shows the bank's raw text (spec §7), which reads
// like a bank statement. tidyName is display only: `raw_name` in the database is never touched.

/** Stays in capitals wherever it appears as a whole word, even after sentence-casing (decision 46). */
const KEEP_ACRONYMS = ["AT&T", "H&M", "CVS", "ATM", "USPS", "UPS", "BP", "KFC"];

// Card and processor prefixes a bank puts in front of the merchant, with or without a following space.
const PREFIX = /^(SQ|TST|DD|SP|PAYPAL)\s?\*\s*/;
// A terminal's own prefix, followed by its (varying) transaction code.
const TERMINAL_PREFIX = /^(POS|CHECKCARD)\s+\d+\s*/;
// A reference code joined on with * ("AMAZON.COM*RT4K2", "US*2K4").
const STAR_CODE = /\*[A-Z0-9]*\d[A-Z0-9]*$/;
// A trailing store number: the last space-separated token, if it has a # or three digits in a row
// ("#552", "4432", "T-1432"), so a number that's part of the name stays ("PIER 39", "MOTEL 6").
// The leading \s means it never strips the only token there is.
const TRAILING_CODE = /\s\S*(#|\d{3})\S*$/;

function keptAcronym(word: string): string | null {
	return (
		KEEP_ACRONYMS.find((a) => a.toLowerCase() === word.toLowerCase()) ?? null
	);
}

/** Re-uppercases every whole-word match of KEEP_ACRONYMS, whatever case sentence-casing left it in. */
function applyAcronyms(text: string): string {
	return text.replace(
		/(^|[^A-Za-z])([A-Za-z&]+)(?=$|[^A-Za-z])/g,
		(match, before: string, word: string) => {
			const acronym = keptAcronym(word);
			return acronym ? before + acronym : match;
		},
	);
}

/**
 * Turns a bank's raw, all-capitals merchant text into something a person can read: card and
 * processor prefixes and codes removed, a code joined on with * removed and any other * read as a
 * space, store numbers removed, sentence case, with a short list of acronyms (KEEP_ACRONYMS) kept in capitals. Text that already has a
 * lowercase letter is left alone, since it isn't a raw bank string (Plaid's names are often already
 * mixed case, and those skip tidying). Never returns an empty
 * string: text that's nothing but a prefix or a number falls back to the raw text itself.
 */
export function tidyName(raw: string): string {
	const trimmed = raw.trim().replace(/\s+/g, " ");
	if (/\p{Ll}/u.test(trimmed)) return trimmed;

	let tidied = trimmed
		.replace(PREFIX, "")
		.replace(TERMINAL_PREFIX, "")
		.replace(STAR_CODE, "")
		.replace(TRAILING_CODE, "");
	// Any * left only joins a processor to a merchant ("GOOGLE *YOUTUBE"): it reads as a space.
	tidied = tidied.replace(/\*/g, " ").replace(/\s+/g, " ").trim();
	// Nothing left to tidy (just a prefix, or just a number): the raw text, trimmed, is the best we have.
	if (tidied === "") return trimmed;

	const lower = tidied.toLowerCase();
	const sentenced = lower.charAt(0).toUpperCase() + lower.slice(1);
	return applyAcronyms(sentenced);
}

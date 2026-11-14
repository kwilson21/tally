// The text a store is looked up by, and when a store's text is private so that it is never searched (spec §7, "Store
// lookup"). Pure: no database, no network. The web search (src/ai/lookup-store.ts) receives only what this returns.

import {
	foldBankText,
	readsAsInstruction,
	redactBankTextForAi,
} from "../ai/suggest-name";
import { cleanBankText } from "../clean-bank-text";
import { PLAID_INCOME_CATEGORY } from "../db/income";
import { TRANSFER_CATEGORIES } from "../db/plaid-transfers";

/** The payment apps whose text names a person or a card rather than a store (a whole word, any capitals). */
export const PAYMENT_APP_NAMES = [
	"Venmo",
	"Zelle",
	"Cash App",
	"PayPal",
	"Apple Cash",
	// Privacy.com's virtual cards print one of these.
	"PwP",
	"Privacycom",
	"Privacy.com",
] as const;

/** The bank's own ways of moving money to or from a person or an account (a whole word or phrase, any capitals). */
export const BANK_RAIL_TERMS = [
	"ACH",
	"wire",
	"check",
	"cheque",
	"payment to",
	"transfer to",
	"transfer from",
] as const;

/** Plaid's category for bank fees: money the bank takes, not a store's sale. */
const PLAID_BANK_FEES_CATEGORY = "BANK_FEES";

/** The Plaid categories whose text is private: transfers, loan payments, income and bank fees. */
export const PRIVATE_PLAID_CATEGORIES: readonly string[] = [
	...TRANSFER_CATEGORIES,
	PLAID_INCOME_CATEGORY,
	PLAID_BANK_FEES_CATEGORY,
];

/** Why a text is private: a payment app, a bank rail, text that reads as an instruction, or nothing left to search. */
export type PrivateReason =
	| "payment_app"
	| "bank_rail"
	| "instruction"
	| "empty";

/** A term as a whole-word pattern: its spaces match any run of spaces, and no letter or digit may touch it. */
const wholeWords = (terms: readonly string[]) =>
	new RegExp(
		`(?<![\\p{L}\\p{N}])(?:${terms
			.map((term) =>
				term
					.split(" ")
					.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
					.join("\\s+"),
			)
			.join("|")})(?![\\p{L}\\p{N}])`,
		"iu",
	);

const PAYMENT_APP = wholeWords(PAYMENT_APP_NAMES);
const BANK_RAIL = wholeWords(BANK_RAIL_TERMS);

/**
 * The text a store is searched by: the merchant key cleaned (cleanBankText), redacted for the model
 * (redactBankTextForAi: amounts and number runs out), then every word with a digit dropped. May be empty.
 */
export function lookupTextOf(merchantKey: string): string {
	return redactBankTextForAi(cleanBankText(merchantKey))
		.split(" ")
		.filter((word) => !/\p{Nd}/u.test(word))
		.join(" ")
		.trim();
}

/**
 * Why a text is private, or null when it may be searched. Run on a merchant key as stored, and on a raw bank text,
 * before any cleaning or cutting. Every check reads the text folded (NFKC), and matches whole words in any capitals.
 * Checked in this order: payment_app, bank_rail, instruction, empty.
 */
export function privateTextReason(text: string): PrivateReason | null {
	const folded = foldBankText(text);

	if (PAYMENT_APP.test(folded)) return "payment_app";

	if (BANK_RAIL.test(folded)) return "bank_rail";

	if (readsAsInstruction(folded)) return "instruction";

	if (lookupTextOf(text) === "") return "empty";

	return null;
}

/** True when a Plaid category makes its text private (PRIVATE_PLAID_CATEGORIES). No category is not private. */
export function isPrivatePlaidCategory(category: string | null): boolean {
	return category !== null && PRIVATE_PLAID_CATEGORIES.includes(category);
}

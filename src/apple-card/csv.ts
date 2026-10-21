// Reads the CSV Apple exports for Apple Card (spec §8.10, decision 138): a small RFC 4180 reader of its own, so no
// dependency. It returns the rows as they are read; planning and storing them is in plan.ts and import.ts.

import { toCents } from "../money";

/** Apple's columns, in order. The header is these, with or without `Purchased By` at the end (Apple adds it for some cards). */
export const APPLE_COLUMNS = [
	"Transaction Date",
	"Clearing Date",
	"Description",
	"Merchant",
	"Category",
	"Type",
	"Amount (USD)",
];
const PURCHASED_BY = "Purchased By";

export const NOT_APPLE =
	"This isn't an Apple Card CSV. In Wallet or on card.apple.com, choose Export Transactions and pick CSV.";

/** One transaction in Apple's file. Dates are YYYY-MM-DD; money is integer cents, positive for money out. */
export type AppleRow = {
	/** The record's number as a spreadsheet counts records: the header is 1, the first transaction is 2. */
	line: number;
	transactionDate: string;
	/** Null while the row hasn't cleared (its Clearing Date is blank). */
	clearingDate: string | null;
	description: string;
	merchant: string | null;
	category: string | null;
	type: string;
	amountCents: number;
};

/** The longest a field may be after cleaning. A longer one makes its row unreadable (D1's row limits). */
const MAX_FIELD = 1000;

/** Unicode NFC, with leading and trailing spaces removed: the form every text from the file takes, the upload key included. */
export function cleanText(text: string): string {
	return text.normalize("NFC").trim();
}

/**
 * Splits CSV text into records of fields. A quoted field may hold commas, line breaks and doubled quotes, and a quote
 * may only open a field, as its first character. Text after a field's closing quote, or a quote in the middle of a
 * field, makes its record malformed: `malformed` holds those records' indexes in `out`. Such a record is still read
 * on, so the record boundaries stay where they are. When the text ends inside a quoted field, `open` is that record's
 * number (counted as a spreadsheet counts records, the header 1), and the record is left out of `out`: its text can't
 * be read.
 */
function records(text: string): {
	out: string[][];
	open: number | null;
	malformed: Set<number>;
} {
	const out: string[][] = [];
	const malformed = new Set<number>();
	let record: string[] = [];
	let field = "";
	let quoted = false;
	// The field's quoted text has closed: only a comma, a line break or the end of the text may follow.
	let closed = false;
	// Nothing has been read for the field yet, so a quote here opens it.
	let atStart = true;
	for (let i = 0; i < text.length; i++) {
		const char = text.charAt(i);
		if (quoted) {
			if (char === '"') {
				if (text.charAt(i + 1) === '"') {
					field += '"';
					i++;
				} else {
					quoted = false;
					closed = true;
				}
			} else field += char;
		} else if (char === ",") {
			record.push(field);
			field = "";
			closed = false;
			atStart = true;
		} else if (char === "\r" || char === "\n") {
			record.push(field);
			out.push(record);
			record = [];
			field = "";
			closed = false;
			atStart = true;
			if (char === "\r" && text.charAt(i + 1) === "\n") i++;
		} else {
			if (atStart && char === '"') quoted = true;
			else {
				if (closed || char === '"') malformed.add(out.length);
				field += char;
			}
			atStart = false;
		}
	}
	if (quoted) return { out, open: out.length + 1, malformed };
	if (field !== "" || record.length > 0) {
		record.push(field);
		out.push(record);
	}
	return { out, open: null, malformed };
}

/** Integer cents for Apple's amount text, or null. A dollar sign is refused, and so is anything toCents rejects. */
function centsOf(text: string): number | null {
	if (text.includes("$")) return null;
	try {
		const cents = toCents(text);
		if (!Number.isSafeInteger(cents)) return null;
		return cents === 0 ? 0 : cents;
	} catch {
		// toCents names the text it refused. That text is money, so it is dropped here, never rethrown or logged.
		return null;
	}
}

const DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** Apple's M/D/YYYY, month first, as YYYY-MM-DD when it is a real calendar day; null otherwise. */
function isoDate(text: string): string | null {
	const match = DATE.exec(text);
	if (!match) return null;
	const month = Number(match[1]);
	const day = Number(match[2]);
	if (month < 1 || month > 12) return null;
	const daysInMonth = new Date(
		Date.UTC(Number(match[3]), month, 0),
	).getUTCDate();
	if (day < 1 || day > daysInMonth) return null;
	return `${match[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

type RowResult = { ok: true; row: AppleRow } | { ok: false; error: string };

/** The words for a record that can't be read. Nothing from it is saved, and the upload says which record it was. */
function unreadableWords(line: number): string {
	return `Row ${line} can't be read. Nothing was added.`;
}

function readRow(fields: string[], line: number, width: number): RowResult {
	const unreadable = { ok: false as const, error: unreadableWords(line) };
	if (fields.length !== width) return unreadable;
	// A U+FFFD means the file was re-saved in another encoding; a field over the cap can't be stored safely.
	if (fields.some((field) => field.includes("�"))) return unreadable;
	const [
		transactionText = "",
		clearingText = "",
		descriptionText = "",
		merchantText = "",
		categoryText = "",
		typeText = "",
		amountText = "",
	] = fields.map(cleanText);
	if (fields.some((field) => cleanText(field).length > MAX_FIELD))
		return unreadable;

	const amountCents = centsOf(amountText);
	const amountError = {
		ok: false as const,
		error: `Row ${line}'s amount can't be read. Nothing was added.`,
	};
	if (amountCents === null) return amountError;

	const dateError = {
		ok: false as const,
		error: `Row ${line}'s date can't be read. Nothing was added.`,
	};
	const transactionDate = isoDate(transactionText);
	if (transactionDate === null) return dateError;
	let clearingDate: string | null = null;
	if (clearingText !== "") {
		clearingDate = isoDate(clearingText);
		if (clearingDate === null) return dateError;
	}

	if (descriptionText === "" || typeText === "") return unreadable;
	return {
		ok: true,
		row: {
			line,
			transactionDate,
			clearingDate,
			description: descriptionText,
			merchant: merchantText || null,
			category: categoryText || null,
			type: typeText,
			amountCents,
		},
	};
}

/**
 * Reads Apple's CSV text. The first record must be Apple's header, exactly, with no quote in the wrong place (a malformed
 * header is not Apple's). Every later record must have no quote in the wrong place, have the header's number of fields
 * and read cleanly; the first one that doesn't refuses the whole file, and the error names its row. A quote left open at
 * the end of the text refuses the file too, naming the record it was in. A byte-order mark is removed, and blank records
 * (a trailing blank line, or a record of empty fields) are skipped.
 */
export function parseAppleCsv(
	text: string,
): { ok: true; rows: AppleRow[] } | { ok: false; error: string } {
	const { out: all, open, malformed } = records(text.replace(/^﻿/, ""));
	const header = (all[0] ?? []).map(cleanText);
	const withPurchasedBy = [...APPLE_COLUMNS, PURCHASED_BY];
	const isApple =
		!malformed.has(0) &&
		((header.length === APPLE_COLUMNS.length &&
			header.every((name, i) => name === APPLE_COLUMNS[i])) ||
			(header.length === withPurchasedBy.length &&
				header.every((name, i) => name === withPurchasedBy[i])));
	if (!isApple) return { ok: false, error: NOT_APPLE };

	const rows: AppleRow[] = [];
	for (let index = 1; index < all.length; index++) {
		const fields = all[index] ?? [];
		// A malformed record is refused before the blank check, so a malformed record of empty-looking fields isn't skipped.
		if (malformed.has(index))
			return { ok: false, error: unreadableWords(index + 1) };
		// A blank record, or one of empty fields (a spreadsheet's re-save can leave those), is skipped, not refused.
		if (fields.every((field) => cleanText(field) === "")) continue;
		const result = readRow(fields, index + 1, header.length);
		if (!result.ok) return { ok: false, error: result.error };
		rows.push(result.row);
	}
	// A quote still open at the end of the text took the rest of the file into its record, so that record can't be read,
	// even when its fields count right (its last field is the one left open).
	if (open !== null) return { ok: false, error: unreadableWords(open) };
	return { ok: true, rows };
}

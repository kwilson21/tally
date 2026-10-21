import { describe, expect, it } from "vitest";
import { NOT_APPLE, parseAppleCsv } from "../src/apple-card/csv";

// Made-up rows in Apple's layout, for the Rivera family. Never the owner's export.
const HEADER8 =
	"Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By";
const HEADER7 =
	"Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD)";
const GREENLEAF =
	'10/03/2026,10/04/2026,"GREENLEAF MARKET #12 100 MAIN ST SPRINGFIELD 00000 XX USA","Greenleaf Market #12","Grocery","Purchase","38.40","Pat Rivera"';

const file = (...lines: string[]) => `${lines.join("\n")}\n`;

function rowsOf(text: string) {
	const result = parseAppleCsv(text);
	if (!result.ok) throw new Error(`expected rows, got: ${result.error}`);
	return result.rows;
}

function errorOf(text: string) {
	const result = parseAppleCsv(text);
	if (result.ok) throw new Error("expected an error, got rows");
	return result.error;
}

/** A file of twelve good rows, then one bad row, which is row 14 (the header is row 1). */
const withBadRow14 = (bad: string) =>
	file(HEADER8, ...Array.from({ length: 12 }, () => GREENLEAF), bad);

describe("parseAppleCsv", () => {
	it("reads one purchase", () => {
		expect(rowsOf(file(HEADER8, GREENLEAF))).toEqual([
			{
				line: 2,
				transactionDate: "2026-10-03",
				clearingDate: "2026-10-04",
				description:
					"GREENLEAF MARKET #12 100 MAIN ST SPRINGFIELD 00000 XX USA",
				merchant: "Greenleaf Market #12",
				category: "Grocery",
				type: "Purchase",
				amountCents: 3840,
			},
		]);
	});

	it("reads both headers, and ignores Purchased By", () => {
		const with8 = rowsOf(file(HEADER8, GREENLEAF));
		const with7 = rowsOf(
			file(HEADER7, GREENLEAF.slice(0, GREENLEAF.lastIndexOf(","))),
		);
		expect(with7).toEqual(with8);
	});

	it("keeps a comma inside quotes", () => {
		const row =
			'09/25/2026,09/26/2026,"GREENLEAF MARKET, UNIT 3 EXAMPLE TOWN","Greenleaf Market","Dining","Purchase","8.50","Pat Rivera"';
		expect(rowsOf(file(HEADER8, row))[0]?.description).toBe(
			"GREENLEAF MARKET, UNIT 3 EXAMPLE TOWN",
		);
	});

	it("keeps a doubled quote", () => {
		const row =
			'09/25/2026,09/26/2026,"PAT ""THE"" CAFE","Pat The Cafe","Dining","Purchase","4.00","Pat Rivera"';
		expect(rowsOf(file(HEADER8, row))[0]?.description).toBe('PAT "THE" CAFE');
	});

	it("reads a spreadsheet's re-save: a byte-order mark, CRLF, every field quoted, a trailing blank line, and 9/5/2026 dates", () => {
		const text =
			'﻿"Transaction Date","Clearing Date","Description","Merchant","Category","Type","Amount (USD)","Purchased By"\r\n' +
			'"9/5/2026","9/6/2026","PAT CAFE #12","Pat Cafe","Dining","Purchase","12.00","Pat Rivera"\r\n' +
			"\r\n";
		expect(rowsOf(text)).toEqual([
			{
				line: 2,
				transactionDate: "2026-09-05",
				clearingDate: "2026-09-06",
				description: "PAT CAFE #12",
				merchant: "Pat Cafe",
				category: "Dining",
				type: "Purchase",
				amountCents: 1200,
			},
		]);
	});

	it("skips trailing records of empty fields, as a spreadsheet's re-save can leave them", () => {
		const text = `${HEADER8}\n${GREENLEAF}\n,,,,,,,\n , , , , , , , \n`;
		expect(rowsOf(text).map((row) => row.line)).toEqual([2]);
	});

	it("reads money in", () => {
		const row =
			'09/25/2026,09/26/2026,"Payment Thank You","Apple","Payment","Payment","-12.00","Pat Rivera"';
		expect(rowsOf(file(HEADER8, row))[0]?.amountCents).toBe(-1200);
	});

	it("reads thousands", () => {
		const row =
			'09/25/2026,09/26/2026,"BIG TICKET","Big Ticket","Shopping","Purchase","1,234.56","Pat Rivera"';
		expect(rowsOf(file(HEADER8, row))[0]?.amountCents).toBe(123456);
	});

	it("reads zero, and -0.00 as a plain zero", () => {
		const zero =
			'09/25/2026,09/26/2026,"ZERO","Zero","Other","Other","0.00","Pat Rivera"';
		const negativeZero =
			'09/25/2026,09/26/2026,"ZERO","Zero","Other","Other","-0.00","Pat Rivera"';
		for (const row of [zero, negativeZero]) {
			const cents = rowsOf(file(HEADER8, row))[0]?.amountCents;
			expect(cents).toBe(0);
			expect(Object.is(cents, -0)).toBe(false);
		}
	});

	it("allows a blank Clearing Date", () => {
		const row =
			'09/25/2026,,"PENDING STORE","Pending Store","Shopping","Purchase","9.99","Pat Rivera"';
		expect(rowsOf(file(HEADER8, row))[0]?.clearingDate).toBeNull();
	});

	it("stores blank Merchant and Category as null", () => {
		const row =
			'09/25/2026,09/26/2026,"UNNAMED","","","Purchase","9.99","Pat Rivera"';
		const [parsed] = rowsOf(file(HEADER8, row));
		expect(parsed?.merchant).toBeNull();
		expect(parsed?.category).toBeNull();
	});

	it("refuses another file", () => {
		const ofx = "OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n<OFX>\n";
		const otherCsv = "Date,Payee,Amount\n2026-09-25,Corner Shop,-4.50\n";
		for (const text of [ofx, otherCsv, ""]) {
			expect(errorOf(text)).toBe(NOT_APPLE);
		}
	});

	it("names the first row it can't read: a bad amount", () => {
		for (const amount of [
			'"$45.25"',
			'"45.2.5"',
			'"12345678901234567890.00"',
		]) {
			const bad = `09/25/2026,09/26/2026,"BAD AMOUNT","Bad","Gas","Purchase",${amount},"Pat Rivera"`;
			expect(errorOf(withBadRow14(bad))).toBe(
				"Row 14's amount can't be read. Nothing was added.",
			);
		}
	});

	it("names the first row it can't read: a bad date", () => {
		const bads = [
			'"02/30/2026","09/26/2026","BAD DATE","Bad","Gas","Purchase","1.00","Pat Rivera"',
			'"","09/26/2026","BAD DATE","Bad","Gas","Purchase","1.00","Pat Rivera"',
			'"09/25/2026","9/31/2026","BAD DATE","Bad","Gas","Purchase","1.00","Pat Rivera"',
			'"13/01/2026","09/26/2026","BAD DATE","Bad","Gas","Purchase","1.00","Pat Rivera"',
		];
		for (const bad of bads) {
			expect(errorOf(withBadRow14(bad))).toBe(
				"Row 14's date can't be read. Nothing was added.",
			);
		}
	});

	it("names the first row it can't read: a blank Description or Type, or a field count other than the header's", () => {
		const bads = [
			'09/25/2026,09/26/2026,"","Bad","Gas","Purchase","1.00","Pat Rivera"',
			'09/25/2026,09/26/2026,"BAD TYPE","Bad","Gas","","1.00","Pat Rivera"',
			'09/25/2026,09/26/2026,"SHORT ROW","Bad","Gas","Purchase","1.00"',
		];
		for (const bad of bads) {
			expect(errorOf(withBadRow14(bad))).toBe(
				"Row 14 can't be read. Nothing was added.",
			);
		}
	});

	it("reads a file with no newline after its last row", () => {
		const text = `${HEADER8}\n${GREENLEAF}\n${GREENLEAF.replace("38.40", "3.10")}`;
		expect(text.endsWith("\n")).toBe(false);
		expect(rowsOf(text).map((row) => row.amountCents)).toEqual([3840, 310]);
	});

	it("reads a Description with a non-ASCII character as written", () => {
		const row =
			'09/25/2026,09/26/2026,"CAFÉ ¦ NORTH","Cafe North","Dining","Purchase","6.00","Pat Rivera"';
		expect(rowsOf(file(HEADER8, row))[0]?.description).toBe("CAFÉ ¦ NORTH");
	});

	it("reads Apple's own form: every non-date field quoted, the dates not", () => {
		const row =
			'10/03/2026,10/04/2026,"GREENLEAF MARKET","Greenleaf Market","Grocery","Purchase","38.40","Pat Rivera"';
		expect(rowsOf(file(HEADER8, row))).toEqual([
			{
				line: 2,
				transactionDate: "2026-10-03",
				clearingDate: "2026-10-04",
				description: "GREENLEAF MARKET",
				merchant: "Greenleaf Market",
				category: "Grocery",
				type: "Purchase",
				amountCents: 3840,
			},
		]);
	});

	it("reads Other and Interest rows like any other", () => {
		const other =
			'09/25/2026,09/26/2026,"ACH DEPOSIT INTERNET TRANSFER FROM ACCOUNT ENDING IN 1234 (REVERSAL - INSUFFICIENT FUNDS)","Apple","Other","Other","12.00","Pat Rivera"';
		const interest =
			'09/25/2026,09/26/2026,"Interest Charged","Apple","Interest","Interest","3.21","Pat Rivera"';
		const [first, second] = rowsOf(file(HEADER8, other, interest));
		expect(first).toMatchObject({ type: "Other", amountCents: 1200 });
		expect(second).toMatchObject({ type: "Interest", amountCents: 321 });
	});

	it("counts records, not physical lines, so a quoted line break doesn't shift the numbering", () => {
		const multiline =
			'09/25/2026,09/26/2026,"LINE ONE\nLINE TWO","Multi","Gas","Purchase","1.00","Pat Rivera"';
		const rows = rowsOf(file(HEADER8, multiline, GREENLEAF));
		expect(rows.map((row) => row.line)).toEqual([2, 3]);
	});

	it("refuses a file that ends inside a quoted field: its last amount, or its last column, has no closing quote", () => {
		// Seven columns, so the amount is the last field: "12.00 reads as 12.00 unless the open quote is refused.
		const good7 = GREENLEAF.slice(0, GREENLEAF.lastIndexOf(","));
		const openAmount =
			'09/25/2026,09/26/2026,"OPEN AMOUNT","Open","Gas","Purchase","12.00';
		expect(errorOf(`${HEADER7}\n${good7}\n${openAmount}`)).toBe(
			"Row 3 can't be read. Nothing was added.",
		);
		expect(errorOf(`${HEADER7}\n${good7}\n${openAmount}\n`)).toBe(
			"Row 3 can't be read. Nothing was added.",
		);
		const openColumn =
			'09/25/2026,09/26/2026,"OPEN COLUMN","Open","Gas","Purchase","1.00","Pat Rivera';
		expect(errorOf(`${HEADER8}\n${GREENLEAF}\n${openColumn}`)).toBe(
			"Row 3 can't be read. Nothing was added.",
		);
	});

	it("refuses an unclosed quote in the middle of a file, which swallows the rest of it into one field", () => {
		const openColumn =
			'09/25/2026,09/26/2026,"OPEN ROW","Open","Gas","Purchase","1.00","Pat Rivera';
		expect(
			errorOf(file(HEADER8, GREENLEAF, openColumn, GREENLEAF, GREENLEAF)),
		).toBe("Row 3 can't be read. Nothing was added.");
	});

	it("refuses a row with a U+FFFD (a file re-saved in another encoding)", () => {
		const bad =
			'09/25/2026,09/26/2026,"BAD � TEXT","Bad","Gas","Purchase","1.00","Pat Rivera"';
		expect(errorOf(file(HEADER8, bad))).toBe(
			"Row 2 can't be read. Nothing was added.",
		);
	});

	it("refuses a row with a field over 1,000 characters", () => {
		const long = "A".repeat(1001);
		const bad = `09/25/2026,09/26/2026,"${long}","Bad","Gas","Purchase","1.00","Pat Rivera"`;
		expect(errorOf(file(HEADER8, bad))).toBe(
			"Row 2 can't be read. Nothing was added.",
		);
	});

	it("keeps a field of exactly 1,000 characters", () => {
		const longest = "A".repeat(1000);
		const row = `09/25/2026,09/26/2026,"${longest}","Long","Gas","Purchase","1.00","Pat Rivera"`;
		expect(rowsOf(file(HEADER8, row))[0]?.description).toBe(longest);
	});

	it("refuses a quote that doesn't open its field: text after a closing quote, or a quote in the middle of a field", () => {
		const bads = [
			// Text after the closing quote of Type: "Payment"x would read as Paymentx, a payment counted as spending.
			'09/25/2026,09/26/2026,"BAD TYPE","Bad","Gas","Payment"x,"-12.00","Pat Rivera"',
			// A quote in the middle of an unquoted Type: x"Payment" would read as xPayment.
			'09/25/2026,09/26/2026,"BAD TYPE","Bad","Gas",x"Payment","-12.00","Pat Rivera"',
			// A space after the closing quote, before the comma.
			'09/25/2026,09/26/2026,"BAD SPACE","Bad","Gas" ,"Purchase","1.00","Pat Rivera"',
			// A space before the opening quote: the quote is no longer the field's first character.
			'09/25/2026,09/26/2026,"BAD LEAD","Bad", "Gas","Purchase","1.00","Pat Rivera"',
		];
		for (const bad of bads) {
			expect(errorOf(withBadRow14(bad))).toBe(
				"Row 14 can't be read. Nothing was added.",
			);
		}
	});

	it("names the malformed row's number when a good row comes before it", () => {
		const bad =
			'09/25/2026,09/26/2026,"BAD TYPE","Bad","Gas","Payment"x,"-12.00","Pat Rivera"';
		expect(errorOf(file(HEADER8, GREENLEAF, bad))).toBe(
			"Row 3 can't be read. Nothing was added.",
		);
	});

	it("refuses a malformed row of empty-looking fields, rather than skipping it as blank", () => {
		const emptyLooking = `"" ${",".repeat(7)}`;
		expect(errorOf(withBadRow14(emptyLooking))).toBe(
			"Row 14 can't be read. Nothing was added.",
		);
	});

	it("names the first row that can't be read in file order, whichever check it fails", () => {
		const malformed =
			'09/25/2026,09/26/2026,"BAD TYPE","Bad","Gas","Payment"x,"-12.00","Pat Rivera"';
		const badAmount =
			'09/25/2026,09/26/2026,"BAD AMOUNT","Bad","Gas","Purchase","$45.25","Pat Rivera"';
		expect(errorOf(file(HEADER8, GREENLEAF, malformed, badAmount))).toBe(
			"Row 3 can't be read. Nothing was added.",
		);
		expect(errorOf(file(HEADER8, GREENLEAF, badAmount, malformed))).toBe(
			"Row 3's amount can't be read. Nothing was added.",
		);
	});

	it("refuses a malformed header as not Apple's, even when its names read right", () => {
		const spacedHeader = HEADER8.replace(
			"Transaction Date,",
			'"Transaction Date" ,',
		);
		expect(errorOf(file(spacedHeader, GREENLEAF))).toBe(NOT_APPLE);
	});

	it("reads a closing quote followed by CRLF, LF, a comma, or the end of the text", () => {
		const lf = file(HEADER8, GREENLEAF);
		const crlf = `${HEADER8}\r\n${GREENLEAF}\r\n${GREENLEAF}`;
		const end = `${HEADER8}\n${GREENLEAF}`;
		expect(rowsOf(lf).map((row) => row.amountCents)).toEqual([3840]);
		expect(rowsOf(crlf).map((row) => row.amountCents)).toEqual([3840, 3840]);
		expect(rowsOf(end).map((row) => row.amountCents)).toEqual([3840]);
	});

	it("reads doubled quotes inside a quoted field, including at its start and end", () => {
		const row =
			'09/25/2026,09/26/2026,"""QUOTED""","Quoted","Dining","Purchase","4.00","Pat Rivera"';
		expect(rowsOf(file(HEADER8, row))[0]?.description).toBe('"QUOTED"');
	});
});

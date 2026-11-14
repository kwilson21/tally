import { describe, expect, it } from "vitest";
import { readAtEdge } from "../src/edge";
import {
	BillAmount,
	CardPlace,
	DigitsUpTo15,
	numberOf,
	PersonName,
	RowId,
	rowIdOrZero,
	rowIdsOf,
	SignInAddress,
	Token,
	textOf,
	UndoName,
	WholeCentsText,
} from "../src/edge-kinds";

const read = (text: string | undefined) => readAtEdge(RowId, text);

describe("WholeCentsText", () => {
	it.each([
		["zero", "0", 0],
		["a leading zero, as the form always read it", "0007", 7],
		["a price", "10000", 10_000],
		["fifteen digits", "999999999999999", 999_999_999_999_999],
	])("reads %s, %j, as %d", (_label, text, value) => {
		expect(readAtEdge(WholeCentsText, text)).toEqual({ ok: true, value });
	});

	it.each([
		["empty", ""],
		["padded with spaces", " 100"],
		["trailing newline", "100\n"],
		["negative", "-100"],
		["plus sign", "+100"],
		["a point", "100.5"],
		["an exponent", "1e3"],
		["hex", "0x1f"],
		["sixteen digits", "1000000000000000"],
		["far past the safe range", "99999999999999999999"],
		["non-numeric", "abc"],
		["full-width digits", "１００"],
	])("refuses %s", (_label, text) => {
		expect(readAtEdge(WholeCentsText, text).ok).toBe(false);
	});

	it("refuses a missing price", () => {
		expect(readAtEdge(WholeCentsText, undefined).ok).toBe(false);
	});
});

describe("UndoName", () => {
	const UUID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

	it.each([
		["lower case", `9401.${UUID}`],
		["upper case", `9401.${UUID.toUpperCase()}`],
	])("reads a payment id and a UUID, in %s", (_label, name) => {
		expect(readAtEdge(UndoName, name)).toEqual({
			ok: true,
			value: { transactionId: 9401, token: name },
		});
	});

	it.each([
		["empty", ""],
		["no dot", `9401${UUID}`],
		["a leading zero on the payment id", `009401.${UUID}`],
		["a zero payment id", `0.${UUID}`],
		["a payment id with a sign", `-9401.${UUID}`],
		["a payment id past fifteen digits", `1000000000000000.${UUID}`],
		["a non-numeric payment id", `abc.${UUID}`],
		["a short UUID", `9401.${UUID.slice(0, 35)}`],
		["a UUID with a space", `9401.${UUID} `],
		["a trailing newline", `9401.${UUID}\n`],
		["a payment id alone", "9401"],
	])("refuses %s", (_label, name) => {
		expect(readAtEdge(UndoName, name).ok).toBe(false);
	});

	it("refuses a missing name", () => {
		expect(readAtEdge(UndoName, undefined).ok).toBe(false);
	});
});

describe("RowId", () => {
	it.each([
		["1", 1],
		["42", 42],
		["999999999999999", 999_999_999_999_999],
	])("reads %j as the number %d", (text, value) => {
		expect(read(text)).toEqual({ ok: true, value });
	});

	it.each([
		["empty", ""],
		["padded with spaces", " 1"],
		["trailing space", "1 "],
		["negative", "-1"],
		["plus sign", "+1"],
		["decimal", "1.5"],
		["exponent", "1e3"],
		["leading zero", "007"],
		["zero", "0"],
		["hex", "0x1f"],
		["16 digits", "1000000000000000"],
		["far past the safe range", "99999999999999999999"],
		["non-numeric", "abc"],
		["a unit after the number", "1abc"],
		["full-width digits", "１"],
		["a trailing newline", "1\n"],
	])("refuses %s", (_label, text) => {
		expect(read(text).ok).toBe(false);
	});

	it("refuses a missing part of the address", () => {
		expect(read(undefined).ok).toBe(false);
	});

	it("keeps every accepted id a safe integer", () => {
		const largest = read("999999999999999");

		expect(largest.ok && Number.isSafeInteger(largest.value)).toBe(true);
	});
});

describe("Token", () => {
	const UUID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

	it.each([
		["lower case", UUID],
		["upper case", UUID.toUpperCase()],
		["36 dashes", "-".repeat(36)],
	])("reads a 36-character name in %s", (_label, text) => {
		expect(readAtEdge(Token, text)).toEqual({ ok: true, value: text });
	});

	it.each([
		["35 characters", UUID.slice(0, 35)],
		["37 characters", `${UUID}0`],
		["a space in place of a dash", UUID.replace("-", " ")],
		["a trailing newline", `${UUID}\n`],
		["non-hex letters", UUID.replace("3f2b", "zzzz")],
		["empty", ""],
		["missing", undefined],
	])("refuses %s", (_label, text) => {
		expect(readAtEdge(Token, text).ok).toBe(false);
	});
});

describe("CardPlace", () => {
	it.each([
		["zero", "0", 0],
		["a place", "3", 3],
		["a leading zero, as the place always read it", "007", 7],
		[
			"a huge place, which splice draws after the last card",
			"99999999999999999999",
			1e20,
		],
	])("reads %s, %j, as %d", (_label, text, value) => {
		expect(readAtEdge(CardPlace, text)).toEqual({ ok: true, value });
	});

	it.each([
		["empty", ""],
		["padded with spaces", " 3"],
		["minus one", "-1"],
		["a point", "1.5"],
		["an exponent", "1e3"],
		["hex", "0x1f"],
		["non-numeric", "abc"],
		["missing", undefined],
	])("refuses %s", (_label, text) => {
		expect(readAtEdge(CardPlace, text).ok).toBe(false);
	});
});

describe("SignInAddress: a bank sign-in address the form names to remove", () => {
	it.each([
		["lower case", "pat@example.com", "pat@example.com"],
		["capitals", "PAT@Example.COM", "pat@example.com"],
		["padded with spaces", "  pat@example.com  ", "pat@example.com"],
		["a dot in the name", "pat.s@ex.co.uk", "pat.s@ex.co.uk"],
	])(
		"reads %s, as the address lower-cased and trimmed",
		(_label, text, value) => {
			expect(readAtEdge(SignInAddress, text)).toEqual({ ok: true, value });
		},
	);

	it.each([
		["empty", ""],
		["only spaces", "   "],
		["no at sign", "nobody"],
		["no dot after the at sign", "a@b"],
		["a space inside", "a b@c.com"],
		["nothing before the at sign", "@c.com"],
		["a dot straight after the at sign", "a@.com"],
		["255 characters", `${"a".repeat(250)}@b.co`],
	])("refuses %s with the sentence", (_label, text) => {
		expect(readAtEdge(SignInAddress, text)).toEqual({
			ok: false,
			say: "Choose an address to remove.",
		});
	});

	it("reads an address of 254 characters", () => {
		const text = `${"a".repeat(249)}@b.co`;

		expect(readAtEdge(SignInAddress, text)).toEqual({ ok: true, value: text });
	});
});

describe("PersonName: a person's name from a form", () => {
	it("reads the name trimmed", () => {
		expect(readAtEdge(PersonName, "  Sam  ")).toEqual({
			ok: true,
			value: "Sam",
		});
	});

	it("reads a name of exactly 40 characters", () => {
		const name = "x".repeat(40);

		expect(readAtEdge(PersonName, name)).toEqual({ ok: true, value: name });
	});

	it.each([
		["empty", ""],
		["only spaces", "   "],
		["41 characters", "x".repeat(41)],
	])("refuses %s with the sentence", (_label, text) => {
		expect(readAtEdge(PersonName, text)).toEqual({
			ok: false,
			say: "Enter a name up to 40 characters.",
		});
	});
});

describe("rowIdOrZero and rowIdsOf: a refused id is 0, and a list drops what it refuses", () => {
	it("gives the id for a row id, and 0 for anything RowId refuses", () => {
		expect(rowIdOrZero("12")).toBe(12);
		expect(rowIdOrZero("0")).toBe(0);
		expect(rowIdOrZero("007")).toBe(0);
		expect(rowIdOrZero("abc")).toBe(0);
		expect(rowIdOrZero(undefined)).toBe(0);
	});

	it("keeps the row ids of a list in order, and drops every other entry, a file part included", () => {
		expect(
			rowIdsOf([
				"3",
				"abc",
				"0",
				"-1",
				"1e3",
				"12",
				new File(["9"], "n.txt"),
				"3",
			]),
		).toEqual([3, 12, 3]);
	});

	it("reads a file part as the empty text", () => {
		expect(textOf(new File(["x"], "x.txt"))).toBe("");
		expect(textOf(null)).toBe("");
		expect(textOf("text")).toBe("text");
	});
});

describe("DigitsUpTo15: a purchase or category number in digits, zeros in front kept (suggestions, #1006)", () => {
	it.each([
		["one digit", "7", 7],
		["a leading zero, as the More card always read it", "007", 7],
		["zero", "0", 0],
		["fifteen digits", "999999999999999", 999_999_999_999_999],
	])("reads %s, %j, as %d", (_label, text, value) => {
		expect(readAtEdge(DigitsUpTo15, text)).toEqual({ ok: true, value });
	});

	it.each([
		["the empty text", ""],
		["sixteen digits", "1234567890123456"],
		["an exponent", "1e3"],
		["a space", " 7"],
		["a decimal point", "7.0"],
		["a sign", "-7"],
		["a plus sign", "+7"],
		["hex", "0x7"],
		["a newline", "7\n"],
	])("refuses %s, %j", (_label, text) => {
		expect(readAtEdge(DigitsUpTo15, text).ok).toBe(false);
	});
});

describe("numberOf: a number typed in a form, read as Number reads it (bills, #1006)", () => {
	// Every text here must read exactly as Number(text) does, NaN and 0 included: the money form's day, month and
	// category answers depend on it.
	it.each([
		"",
		" ",
		"0",
		"07",
		"5",
		"5.0",
		"5.",
		"+5",
		"-1",
		"1e1",
		"0x5",
		"0b101",
		"1.0",
		"Infinity",
		"NaN",
		"abc",
		"1 000",
		"99999999999999999999",
	])("reads %j as Number(%j)", (text) => {
		expect(numberOf(text)).toBe(Number(text));
	});

	it("reads text that is no number as NaN", () => {
		expect(Number.isNaN(numberOf("abc"))).toBe(true);
	});
});

describe("BillAmount: a dollar amount typed on the bill sheet, as cents (bills, #1006)", () => {
	const amountOf = (text: string) => readAtEdge(BillAmount, text);

	it.each([
		["5", 500],
		["0005", 500],
		["$5", 500],
		[" 5 ", 500],
		["1,240.18", 124018],
		["1,000,000", 100000000],
		["100000", 10000000],
		["100000000", 10000000000],
	])("reads %j as %d cents when it is no more than the cap", (text, cents) => {
		expect(amountOf(text)).toEqual({ ok: true, value: cents });
	});

	it.each([
		["", "Enter an amount greater than $0."],
		["0", "Enter an amount greater than $0."],
		["0.00", "Enter an amount greater than $0."],
		["-0", "Enter an amount greater than $0."],
		["abc", "Enter an amount greater than $0."],
		["0x5", "Enter an amount greater than $0."],
		["1e3", "Enter an amount greater than $0."],
		["5.", "Enter an amount greater than $0."],
		["12.345", "Enter an amount greater than $0."],
		["1,2345", "Enter an amount greater than $0."],
		["Infinity", "Enter an amount greater than $0."],
		["100000000.01", "Enter an amount of $100,000,000 or less."],
		["99999999999", "Enter an amount of $100,000,000 or less."],
	])("refuses %j with %j", (text, say) => {
		expect(amountOf(text)).toEqual({ ok: false, say });
	});
});

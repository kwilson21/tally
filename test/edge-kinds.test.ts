import { describe, expect, it } from "vitest";
import { readAtEdge } from "../src/edge";
import {
	CardPlace,
	RowId,
	Token,
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

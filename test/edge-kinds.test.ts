import { describe, expect, it } from "vitest";
import { readAtEdge } from "../src/edge";
import { RowId, Token } from "../src/edge-kinds";

const read = (text: string | undefined) => readAtEdge(RowId, text);

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

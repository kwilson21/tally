import { describe, expect, it } from "vitest";
import { readAtEdge } from "../src/edge";
import { RowId } from "../src/edge-kinds";

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

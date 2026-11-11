import { describe, expect, it } from "vitest";
import {
	isArrayOf,
	isBoolean,
	isNullable,
	isNumber,
	isOptional,
	isRecordOf,
	isShape,
	isString,
	readStored,
} from "../src/db/stored-shape";

// The guards a stored JSON value is checked with before the code trusts its type (audit finding 11).

describe("the basic guards", () => {
	it("accept their own kind and nothing else", () => {
		expect(isNumber(3)).toBe(true);
		expect(isNumber("3")).toBe(false);
		expect(isNumber(Number.NaN)).toBe(false);
		expect(isString("a")).toBe(true);
		expect(isString(1)).toBe(false);
		expect(isBoolean(false)).toBe(true);
		expect(isBoolean(0)).toBe(false);
	});

	it("nullable and optional let null, or a missing value, through", () => {
		expect(isNullable(isNumber)(null)).toBe(true);
		expect(isNullable(isNumber)(undefined)).toBe(false);
		expect(isOptional(isNumber)(undefined)).toBe(true);
		expect(isOptional(isNumber)(null)).toBe(false);
		expect(isOptional(isNumber)(2)).toBe(true);
	});

	it("array and record guards check every element", () => {
		expect(isArrayOf(isNumber)([1, 2])).toBe(true);
		expect(isArrayOf(isNumber)([1, "2"])).toBe(false);
		expect(isArrayOf(isNumber)({})).toBe(false);
		expect(isRecordOf(isNumber)({ a: 1 })).toBe(true);
		expect(isRecordOf(isNumber)({ a: "1" })).toBe(false);
		expect(isRecordOf(isNumber)([1])).toBe(false);
	});
});

describe("isShape", () => {
	type Thing = { id: number; name: string | null; tags?: string[] };

	const isThing = isShape<Thing>({
		id: isNumber,
		name: isNullable(isString),
		tags: isOptional(isArrayOf(isString)),
	});

	it("accepts an object with every key right, extra keys and a missing optional one included", () => {
		expect(isThing({ id: 1, name: null })).toBe(true);
		expect(isThing({ id: 1, name: "a", tags: ["x"], other: true })).toBe(true);
	});

	it("rejects a wrong type, a missing required key and anything that is not an object", () => {
		expect(isThing({ id: "1", name: null })).toBe(false);
		expect(isThing({ name: null })).toBe(false);
		expect(isThing({ id: 1, name: null, tags: [1] })).toBe(false);

		for (const value of [null, 1, "a", [], undefined])
			expect(isThing(value)).toBe(false);
	});
});

describe("readStored", () => {
	const isPair = isShape<{ a: number }>({ a: isNumber });

	it("returns the value when the text is JSON of the right shape", () => {
		expect(readStored('{"a":1}', isPair)).toEqual({ a: 1 });
	});

	it("returns null when the text is not JSON or is not shaped like the type", () => {
		expect(readStored("not json", isPair)).toBeNull();
		expect(readStored('{"a":"1"}', isPair)).toBeNull();
		expect(readStored("null", isPair)).toBeNull();
	});
});

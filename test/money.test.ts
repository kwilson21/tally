import { describe, expect, it } from "vitest";
import {
	ceilToDollars,
	centsToAmount,
	floorToDollars,
	formatCents,
	plaidAmountToCents,
	toCents,
} from "../src/money";

describe("toCents (form input → cents)", () => {
	it.each([
		["12", 1200],
		["12.3", 1230],
		["12.34", 1234],
		["$1,284.50", 128450],
		[" 0.99 ", 99],
		["-45.10", -4510],
		["1,000", 100000],
		["$12,345.67", 1234567],
		["-$5", -500],
	])("%s → %i", (input, cents) => {
		expect(toCents(input)).toBe(cents);
	});

	it.each([
		"",
		"abc",
		"12.345",
		"1.2.3",
		"$",
		"--5",
		"12,34",
		"1,00",
		"1,2345",
		",100",
	])("rejects %j", (input) => {
		expect(() => toCents(input)).toThrow();
	});
});

describe("plaidAmountToCents (Plaid float → cents, never float math on stored values)", () => {
	it.each([
		[12.34, 1234],
		[0.29, 29],
		[1.005, 101],
		[-2450, -245000],
		[64.18, 6418],
		[2.675, 268],
		[0.105, 11],
		[1.015, 102],
		[0.1 + 0.2, 30],
		[1234567.89, 123456789],
		[-0.005, -1],
		[0.004, 0],
		[1e-7, 0],
	])("%d → %i", (amount, cents) => {
		expect(plaidAmountToCents(amount)).toBe(cents);
	});

	it.each([1e-7, 0.004, -1e-7, -0.004])("%d → exactly 0, not -0", (amount) => {
		expect(Object.is(plaidAmountToCents(amount), 0)).toBe(true);
	});
});

describe("formatCents (cents → display)", () => {
	it.each([
		[128400, {}, "$1,284.00"],
		[128400, { wholeDollars: true }, "$1,284"],
		[650, {}, "$6.50"],
		[-245000, {}, "-$2,450.00"],
		[-245000, { signed: true }, "+$2,450.00"],
		[6418, { signed: true }, "$64.18"],
		[0, {}, "$0.00"],
	] as const)("%i %j → %s", (cents, options, text) => {
		expect(formatCents(cents, options)).toBe(text);
	});
});

describe("centsToAmount (cents → the money input's text)", () => {
	it.each([
		[70000, "700.00"],
		[61240, "612.40"],
		[5, "0.05"],
		[0, "0.00"],
	])("%i → %s", (cents, text) => {
		expect(centsToAmount(cents)).toBe(text);
		expect(toCents(text)).toBe(cents);
	});

	it("refuses anything that isn't a non-negative integer", () => {
		expect(() => centsToAmount(-1)).toThrow();
		expect(() => centsToAmount(1.5)).toThrow();
	});
});

describe("floorToDollars (cents → the whole dollar below, toward negative infinity)", () => {
	it.each([
		[150, 100],
		[100, 100],
		[99, 0],
		[50, 0],
		[0, 0],
		[-50, -100],
		[-150, -200],
		[-199, -200],
		[-200, -200],
		[12345, 12300],
	])("%i → %i", (cents, whole) => {
		expect(floorToDollars(cents)).toBe(whole);
	});

	it("never returns -0 (a zero cent amount is +0)", () => {
		expect(Object.is(floorToDollars(0), 0)).toBe(true);
		expect(Object.is(floorToDollars(-0), 0)).toBe(true);
	});

	it("matches Math.floor(cents / 100) * 100 for every integer in a sweep", () => {
		for (let cents = -1000; cents <= 1000; cents++) {
			expect(floorToDollars(cents)).toBe(Math.floor(cents / 100) * 100 || 0);
		}
	});

	it("refuses anything that isn't a safe integer, as centsToAmount does", () => {
		expect(() => floorToDollars(1.5)).toThrow();
		expect(() => floorToDollars(Number.NaN)).toThrow();
		expect(() => floorToDollars(Number.MAX_SAFE_INTEGER + 1)).toThrow();
	});
});

describe("ceilToDollars (cents → the whole dollar above, toward positive infinity)", () => {
	it.each([
		[150, 200],
		[100, 100],
		[101, 200],
		[199, 200],
		[50, 100],
		[1, 100],
		[0, 0],
		[-50, 0],
		[-150, -100],
		[-199, -100],
		[-200, -200],
		[12345, 12400],
	])("%i → %i", (cents, whole) => {
		expect(ceilToDollars(cents)).toBe(whole);
	});

	it("never returns -0 (a negative amount under a dollar rounds to +0)", () => {
		expect(Object.is(ceilToDollars(-50), 0)).toBe(true);
		expect(Object.is(ceilToDollars(-1), 0)).toBe(true);
		expect(Object.is(ceilToDollars(0), 0)).toBe(true);
	});

	it("matches Math.ceil(cents / 100) * 100 (never -0) for every integer in a sweep", () => {
		for (let cents = -1000; cents <= 1000; cents++) {
			expect(ceilToDollars(cents)).toBe(Math.ceil(cents / 100) * 100 || 0);
		}
	});

	it("refuses anything that isn't a safe integer, as centsToAmount does", () => {
		expect(() => ceilToDollars(1.5)).toThrow();
		expect(() => ceilToDollars(Number.NaN)).toThrow();
		expect(() => ceilToDollars(Number.MIN_SAFE_INTEGER - 1)).toThrow();
	});
});

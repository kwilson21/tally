import { describe, expect, it } from "vitest";
import { formatCents, plaidAmountToCents, toCents } from "../src/money";

describe("toCents (form input → cents)", () => {
	it.each([
		["12", 1200],
		["12.3", 1230],
		["12.34", 1234],
		["$1,284.50", 128450],
		[" 0.99 ", 99],
		["-45.10", -4510],
	])("%s → %i", (input, cents) => {
		expect(toCents(input)).toBe(cents);
	});

	it.each(["", "abc", "12.345", "1.2.3", "$", "--5"])("rejects %j", (input) => {
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
	])("%d → %i", (amount, cents) => {
		expect(plaidAmountToCents(amount)).toBe(cents);
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

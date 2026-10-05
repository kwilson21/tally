import { describe, expect, it } from "vitest";
import {
	BIG_BILL_CENTS,
	duplicateBillName,
	needsBigAmountConfirm,
} from "../src/bills/guards";

const bills = [
	{ id: 1, name: "Rent", active: 1 },
	{ id: 2, name: "  Water ", active: 1 },
	{ id: 3, name: "Old phone plan", active: 0 },
];

describe("duplicateBillName", () => {
	it("finds an active bill with the same name, ignoring case and surrounding spaces", () => {
		expect(duplicateBillName(bills, "rent")).toBe("Rent");
		expect(duplicateBillName(bills, "  RENT  ")).toBe("Rent");
		expect(duplicateBillName(bills, "water")).toBe("Water");
	});

	it("returns the existing bill's own spelling, trimmed", () => {
		expect(duplicateBillName(bills, "WATER")).toBe("Water");
	});

	it("ignores inactive bills", () => {
		expect(duplicateBillName(bills, "Old phone plan")).toBeUndefined();
	});

	it("lets a bill keep its own name", () => {
		expect(duplicateBillName(bills, "rent", 1)).toBeUndefined();
		expect(duplicateBillName(bills, "rent", 2)).toBe("Rent");
	});

	it("does not match a different name or part of one", () => {
		expect(duplicateBillName(bills, "Rent 2")).toBeUndefined();
		expect(duplicateBillName(bills, "Ren")).toBeUndefined();
		expect(duplicateBillName([], "Rent")).toBeUndefined();
	});

	it("matches accented capitals too", () => {
		expect(
			duplicateBillName([{ id: 9, name: "Café", active: 1 }, ...bills], "CAFÉ"),
		).toBe("Café");
	});
});

describe("needsBigAmountConfirm", () => {
	it("is over $100,000.00, not at it", () => {
		expect(BIG_BILL_CENTS).toBe(10_000_000);
		expect(needsBigAmountConfirm(10_000_000, "")).toBe(false);
		expect(needsBigAmountConfirm(10_000_001, "")).toBe(true);
		expect(needsBigAmountConfirm(9_999_999, "")).toBe(false);
	});

	it("is satisfied only by confirming that exact amount", () => {
		expect(needsBigAmountConfirm(15_000_000, "15000000")).toBe(false);
		expect(needsBigAmountConfirm(15_000_000, "20000000")).toBe(true);
		expect(needsBigAmountConfirm(15_000_000, "15000000.0")).toBe(true);
		expect(needsBigAmountConfirm(15_000_000, "on")).toBe(true);
		expect(needsBigAmountConfirm(15_000_000, "")).toBe(true);
	});
});

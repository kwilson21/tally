import { describe, expect, it } from "vitest";
import { findBillSuggestions } from "../src/bills/find";
import { withinBillAmount } from "../src/bills/match";
import {
	BILL_AMOUNT_TOLERANCE_PERCENT,
	occurrencePaid,
} from "../src/bills/status";

// One percentage decides all three amount rules, so a bill that varies by it still matches, is still Paid and is still
// found from repeat charges (spec §6.1 and §8.2). Each test reads the edge from the constant, so changing it moves
// all three together.

const BILL = 120_000;
const EDGE = (BILL * BILL_AMOUNT_TOLERANCE_PERCENT) / 100;

describe("the bill amount tolerance", () => {
	it("is a whole percent, so the checks stay in integer cents", () => {
		expect(Number.isInteger(BILL_AMOUNT_TOLERANCE_PERCENT)).toBe(true);
		expect(BILL_AMOUNT_TOLERANCE_PERCENT).toBeGreaterThan(0);
		expect(BILL_AMOUNT_TOLERANCE_PERCENT).toBeLessThan(100);
	});

	it("matches a payment up to the tolerance over or under the bill, both ends included, and not a cent past", () => {
		expect(withinBillAmount(BILL + EDGE, BILL)).toBe(true);
		expect(withinBillAmount(BILL - EDGE, BILL)).toBe(true);
		expect(withinBillAmount(BILL + EDGE + 1, BILL)).toBe(false);
		expect(withinBillAmount(BILL - EDGE - 1, BILL)).toBe(false);
	});

	it("calls an occurrence Paid from the tolerance's share short of the amount, and part paid a cent below", () => {
		expect(occurrencePaid(BILL - EDGE, BILL)).toBe(true);
		expect(occurrencePaid(BILL - EDGE - 1, BILL)).toBe(false);
		expect(occurrencePaid(BILL + EDGE * 5, BILL)).toBe(true);
	});

	it("finds a bill from two charges a month apart that differ by up to the tolerance, and not a cent past", () => {
		const charge = (date: string, amountCents: number) => ({
			rawName: "GYM MEMBERSHIP",
			bankText: "GYM MEMBERSHIP",
			displayName: null,
			date,
			amountCents,
			categoryId: null,
		});

		const found = (later: number) =>
			findBillSuggestions([
				charge("2026-08-01", BILL),
				charge("2026-08-31", later),
			]).length;

		expect(found(BILL + EDGE)).toBe(1);
		expect(found(BILL + EDGE + 1)).toBe(0);
	});
});

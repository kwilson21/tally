import { describe, expect, it } from "vitest";
import {
	refundAnswersError,
	refundPartIndex,
	type SplitRefund,
} from "../src/transactions/refund-guards";

const TODAY = "2026-09-22";
const KIDS = { name: "Kids", amountCents: 6000 };
const HOUSEHOLD = { name: "Household", amountCents: 4000 };
const PARTS = [KIDS, HOUSEHOLD];
const FIRST: SplitRefund = { id: 1, date: "2026-09-05", amountCents: -4500 };
const SECOND: SplitRefund = { id: 2, date: "2026-09-06", amountCents: -2000 };

describe("refundPartIndex", () => {
	it("reads a part's index, and Not linked as no part", () => {
		expect(refundPartIndex("0", 2)).toBe(0);
		expect(refundPartIndex("1", 2)).toBe(1);
		expect(refundPartIndex("none", 2)).toBeNull();
	});

	it("reads nothing for a missing, blank or out-of-range answer", () => {
		expect(refundPartIndex(undefined, 2)).toBeNull();
		expect(refundPartIndex("", 2)).toBeNull();
		expect(refundPartIndex("2", 2)).toBeNull();
		expect(refundPartIndex("-1", 2)).toBeNull();
		expect(refundPartIndex("1.5", 2)).toBeNull();
	});
});

describe("refundAnswersError", () => {
	it("asks for a part or Not linked for each refund, naming the first one left open", () => {
		expect(refundAnswersError([FIRST, SECOND], {}, PARTS, TODAY)).toBe(
			"Pick which part the refund on Sep 5 goes with, or Not linked.",
		);
		expect(
			refundAnswersError([FIRST, SECOND], { [FIRST.id]: "0" }, PARTS, TODAY),
		).toBe("Pick which part the refund on Sep 6 goes with, or Not linked.");
	});

	it("accepts Not linked as an answer", () => {
		expect(
			refundAnswersError([FIRST], { [FIRST.id]: "none" }, PARTS, TODAY),
		).toBeNull();
	});

	it("refuses a refund bigger than the part it is chosen for, in the refund guards' words", () => {
		// $45.00 does not fit the $40.00 Household part.
		expect(refundAnswersError([FIRST], { [FIRST.id]: "1" }, PARTS, TODAY)).toBe(
			"The refund is $45.00, and Household is only $40.00.",
		);
	});

	it("checks every refund chosen for a part together, against the part's own size", () => {
		// $45.00 fits the $60.00 Kids part, but $20.00 more would make $65.00.
		expect(
			refundAnswersError(
				[FIRST, SECOND],
				{ [FIRST.id]: "0", [SECOND.id]: "0" },
				PARTS,
				TODAY,
			),
		).toBe("The refunds come to $65.00, and Kids is only $60.00.");
		expect(
			refundAnswersError(
				[FIRST, SECOND],
				{ [FIRST.id]: "0", [SECOND.id]: "1" },
				PARTS,
				TODAY,
			),
		).toBeNull();
	});

	it("reads a part's room from its size, whatever the sign of a split refund's parts", () => {
		const negativeParts = PARTS.map((part) => ({
			...part,
			amountCents: -part.amountCents,
		}));
		expect(
			refundAnswersError([FIRST], { [FIRST.id]: "0" }, negativeParts, TODAY),
		).toBeNull();
	});
});

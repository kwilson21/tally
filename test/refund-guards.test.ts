import { describe, expect, it } from "vitest";
import {
	leftToRefundCents,
	refundTooBigMessage,
} from "../src/transactions/refund-guards";

describe("leftToRefundCents", () => {
	it("is the whole purchase while nothing is refunded", () => {
		expect(leftToRefundCents(5000, 0)).toBe(5000);
	});

	it("takes off every refund already linked", () => {
		expect(leftToRefundCents(5000, 3000)).toBe(2000);
		expect(leftToRefundCents(5000, 3000 + 1999)).toBe(1);
	});

	it("is zero once the purchase is refunded in full", () => {
		expect(leftToRefundCents(5000, 5000)).toBe(0);
	});

	it("is never below zero, even for data that was over-refunded before the guard", () => {
		expect(leftToRefundCents(5000, 6500)).toBe(0);
	});

	it("is exact in integer cents", () => {
		// 0.1 + 0.2 style sums would drift as floats; cents never do.
		expect(leftToRefundCents(30, 10 + 20)).toBe(0);
		expect(leftToRefundCents(1, 0)).toBe(1);
	});
});

describe("refundTooBigMessage", () => {
	it("says what is left, formatted as dollars", () => {
		expect(refundTooBigMessage(2000)).toBe(
			"This refund is more than what's left of that purchase ($20.00 left).",
		);
		expect(refundTooBigMessage(5)).toBe(
			"This refund is more than what's left of that purchase ($0.05 left).",
		);
		expect(refundTooBigMessage(123456)).toBe(
			"This refund is more than what's left of that purchase ($1,234.56 left).",
		);
	});

	it("says $0.00 left when the purchase is fully refunded", () => {
		expect(refundTooBigMessage(0)).toBe(
			"This refund is more than what's left of that purchase ($0.00 left).",
		);
	});
});

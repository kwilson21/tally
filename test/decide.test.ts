import { describe, expect, it } from "vitest";
import { decide, NONE_FIT } from "../src/ai/decide";

const categories = [
	{ id: 1, name: "Groceries" },
	{ id: 2, name: "Eating Out" },
];

const answer = (
	label: string,
	confidence: number,
	flags: Partial<Record<"transfer" | "reimbursement" | "income", number>> = {},
) => ({
	category: { label, confidence },
	flags: { transfer: 0, reimbursement: 0, income: 0, ...flags },
});

describe("decide", () => {
	it("applies the category at or above the threshold", () => {
		expect(decide(answer("Eating Out", 0.93), categories, 0.8)).toEqual({
			categoryId: 2,
			suggestedCategoryId: 2,
			confidence: 0.93,
			flags: { transfer: false, reimbursement: false, income: false },
		});
	});

	it("counts exactly the threshold as confident", () => {
		expect(decide(answer("Groceries", 0.8), categories, 0.8).categoryId).toBe(
			1,
		);
	});

	it("leaves the category empty below the threshold but keeps the confidence", () => {
		expect(decide(answer("Groceries", 0.62), categories, 0.8)).toEqual({
			categoryId: null,
			suggestedCategoryId: 1,
			confidence: 0.62,
			flags: { transfer: false, reimbursement: false, income: false },
		});
	});

	it("treats a label that isn't a category as not confident", () => {
		const result = decide(answer("Travel", 0.99), categories, 0.8);
		expect(result.categoryId).toBeNull();
		expect(result.suggestedCategoryId).toBeNull();
		expect(result.confidence).toBe(0.99);
	});

	it("never applies a category when Jev says none of them fit, however sure it is", () => {
		expect(decide(answer(NONE_FIT, 0.97), categories, 0.8)).toEqual({
			categoryId: null,
			suggestedCategoryId: null,
			confidence: 0.97,
			flags: { transfer: false, reimbursement: false, income: false },
		});
	});

	it("sets each flag on its own probability, independent of the category", () => {
		expect(
			decide(
				answer("Groceries", 0.4, {
					transfer: 0.95,
					reimbursement: 0.79,
					income: 0.8,
				}),
				categories,
				0.8,
			).flags,
		).toEqual({ transfer: true, reimbursement: false, income: true });
	});
});

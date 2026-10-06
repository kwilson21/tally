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
			noneFit: false,
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
			noneFit: false,
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
			noneFit: true,
			flags: { transfer: false, reimbursement: false, income: false },
		});
	});

	// Spec §5, §7 (#51): "none fit" is what a new category is suggested from, so it is kept as its own fact,
	// whatever the confidence (the threshold is applied when suggestions are made), and only for a real answer.
	it("marks a none-fit answer at any confidence, and nothing else", () => {
		expect(decide(answer(NONE_FIT, 0.97), categories, 0.8).noneFit).toBe(true);
		expect(decide(answer(NONE_FIT, 0.3), categories, 0.8).noneFit).toBe(true);
		expect(decide(answer("Groceries", 0.97), categories, 0.8).noneFit).toBe(
			false,
		);
		// A label that isn't one of the household's categories is no answer at all.
		expect(decide(answer("Travel", 0.99), categories, 0.8).noneFit).toBe(false);
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

	// Spec §8.6: with the categories-and-exclusions switch off, Jev's category answer and its transfer
	// and reimbursement flags are dropped, so nothing is applied, suggested or excluded.
	describe("with categories and exclusions off", () => {
		const off = { categories: false };

		it("applies and suggests no category, however sure Jev is, but keeps the confidence so it isn't asked again", () => {
			expect(decide(answer("Eating Out", 0.97), categories, 0.8, off)).toEqual({
				categoryId: null,
				suggestedCategoryId: null,
				confidence: 0.97,
				noneFit: false,
				flags: { transfer: false, reimbursement: false, income: false },
			});
		});

		it("doesn't call a none-fit answer none-fit while the switch is off, since nothing about the category is kept", () => {
			expect(decide(answer(NONE_FIT, 0.97), categories, 0.8, off).noneFit).toBe(
				false,
			);
		});

		it("lets no transfer or reimbursement flag through, so nothing is excluded", () => {
			const result = decide(
				answer("Groceries", 0.9, { transfer: 0.99, reimbursement: 0.99 }),
				categories,
				0.8,
				off,
			);
			expect(result.flags.transfer).toBe(false);
			expect(result.flags.reimbursement).toBe(false);
		});

		it("leaves the income answer to the income switch", () => {
			expect(
				decide(answer("Groceries", 0.9, { income: 0.95 }), categories, 0.8, off)
					.flags.income,
			).toBe(true);
		});
	});

	it("decides as before with categories on, or with no switches given", () => {
		const jev = answer("Eating Out", 0.93, { transfer: 0.9 });
		const asBefore = decide(jev, categories, 0.8);
		expect(decide(jev, categories, 0.8, { categories: true })).toEqual(
			asBefore,
		);
		expect(asBefore.categoryId).toBe(2);
		expect(asBefore.flags.transfer).toBe(true);
	});
});

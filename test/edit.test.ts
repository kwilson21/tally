import { describe, expect, it } from "vitest";
import { parseEdit, safeBack } from "../src/transactions/edit";

const form = (fields: Record<string, string>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	return f;
};
const CATEGORIES = [1, 2, 3, 4, 5];

describe("parseEdit and whether a name was given (merchant_was)", () => {
	const read = (fields: Record<string, string>) => {
		const result = parseEdit(form(fields), CATEGORIES);
		if (!result.ok) throw new Error("expected ok");
		return result.value;
	};

	it("is a rename when the field differs from what the panel drew, or has no merchant_was", () => {
		expect(read({ merchant: "New" })).toMatchObject({
			displayName: "New",
			nameChanged: true,
		});
		expect(read({ merchant_was: "Old", merchant: "New" })).toMatchObject({
			displayName: "New",
			nameChanged: true,
		});
		// No merchant_was: an empty field clears the name, as it always did.
		expect(read({ merchant: "" })).toMatchObject({
			displayName: null,
			nameChanged: true,
		});
	});

	it("is not a rename when the field still holds what the panel drew", () => {
		expect(read({ merchant_was: "Old", merchant: "Old" })).toMatchObject({
			nameChanged: false,
		});
		expect(read({ merchant_was: "", merchant: "" })).toMatchObject({
			displayName: null,
			nameChanged: false,
		});
		expect(read({ merchant_was: " Old ", merchant: "Old" })).toMatchObject({
			nameChanged: false,
		});
	});

	it("is a clear when a name the panel drew is emptied", () => {
		expect(read({ merchant_was: "Old", merchant: "" })).toMatchObject({
			displayName: null,
			nameChanged: true,
		});
	});

	it("is a name given by a chip, and keeping the bank's name gives none", () => {
		expect(
			read({ merchant_was: "", merchant: "", name_pick: "s:Blue Bottle" }),
		).toMatchObject({ displayName: "Blue Bottle", nameChanged: true });
		expect(
			read({ merchant_was: "", merchant: "", name_pick: "keep" }),
		).toMatchObject({
			displayName: null,
			keepBankName: true,
			nameChanged: false,
		});
	});
});

describe("parseEdit", () => {
	it("reads a category, name, and empty note", () => {
		expect(
			parseEdit(
				form({ category: "2", merchant: "Local Bakery", note: "" }),
				CATEGORIES,
			),
		).toEqual({
			ok: true,
			value: {
				categoryId: 2,
				alwaysForMerchant: false,
				alwaysWas: false,
				merchantRuleWas: null,
				displayName: "Local Bakery",
				nameChanged: true,
				keepBankName: false,
				note: null,
				excluded: false,
				income: false,
				creditReviewed: false,
				creditReviewedProvided: false,
				kind: undefined,
				forPersonId: undefined,
				keepDetails: false,
			},
		});
	});

	it("records whether the credit-review control was actually shown", () => {
		expect(
			parseEdit(form({ creditReviewedVisible: "1" }), CATEGORIES),
		).toMatchObject({
			ok: true,
			value: { creditReviewed: false, creditReviewedProvided: true },
		});
		expect(parseEdit(form({ creditReviewed: "1" }), CATEGORIES)).toMatchObject({
			ok: true,
			value: { creditReviewed: true, creditReviewedProvided: true },
		});
	});

	it("reads the exclude checkbox", () => {
		expect(parseEdit(form({ excluded: "1" }), CATEGORIES)).toMatchObject({
			ok: true,
			value: { excluded: true },
		});
	});

	it("leaves the category alone when none is picked", () => {
		const result = parseEdit(
			form({ merchant: "", note: "birthday" }),
			CATEGORIES,
		);
		expect(result).toMatchObject({
			ok: true,
			value: { categoryId: null, displayName: null, note: "birthday" },
		});
	});

	it("rejects a category that isn't in the list", () => {
		expect(parseEdit(form({ category: "99" }), CATEGORIES)).toMatchObject({
			ok: false,
			errors: { category: "Pick a category from the list." },
		});
	});

	it("needs a category for a merchant rule", () => {
		expect(parseEdit(form({ always: "1" }), CATEGORIES)).toMatchObject({
			ok: false,
			errors: { category: "Pick a category to use for this merchant." },
		});
		expect(
			parseEdit(form({ always: "1", category: "3" }), CATEGORIES),
		).toMatchObject({
			ok: true,
			value: { alwaysForMerchant: true, categoryId: 3 },
		});
	});

	it("limits the merchant name and note lengths", () => {
		expect(
			parseEdit(form({ merchant: "x".repeat(81) }), CATEGORIES),
		).toMatchObject({
			ok: false,
			errors: { merchant: "Keep the name under 80 characters." },
		});
		expect(
			parseEdit(form({ note: "x".repeat(501) }), CATEGORIES),
		).toMatchObject({
			ok: false,
			errors: { note: "Keep the note under 500 characters." },
		});
	});

	it("trims whitespace and treats a blank name as no custom name", () => {
		expect(
			parseEdit(form({ merchant: "   ", note: "  hi  " }), CATEGORIES),
		).toMatchObject({ ok: true, value: { displayName: null, note: "hi" } });
	});
});

describe("safeBack", () => {
	it("keeps a Transactions list URL", () => {
		expect(safeBack("/transactions?q=x&page=2")).toBe(
			"/transactions?q=x&page=2",
		);
		expect(safeBack("/transactions")).toBe("/transactions");
	});

	it("never redirects anywhere else", () => {
		for (const url of [
			"https://evil.example",
			"//evil.example",
			"/settings",
			"/transactions/../settings",
			"/transactionsX",
			"",
			null,
		]) {
			expect(safeBack(url)).toBe("/transactions");
		}
	});
});

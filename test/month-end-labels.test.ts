import { describe, expect, it } from "vitest";
import { monthEndLabels } from "../src/views/month-end";

describe("month-end chart labels", () => {
	it("keeps the five labels from the drawing", () => {
		expect(
			monthEndLabels([
				"Groceries",
				"Eating Out",
				"Gas",
				"Kids",
				"Household",
				"Utilities",
				"Clothing",
				"Gifts",
				"Pets",
			]),
		).toEqual([
			"Groc.",
			"Eating",
			"Gas",
			"Kids",
			"Home",
			"Util.",
			"Cloth.",
			"Gifts",
			"Pets",
		]);
	});

	it("adds only enough letters to distinguish two and three collisions", () => {
		expect(monthEndLabels(["Home Improvement", "Home Insurance"])).toEqual([
			"Home Im.",
			"Home In.",
		]);
		expect(
			monthEndLabels(["Home Improvement", "Home Insurance", "Home Internet"]),
		).toEqual(["Home Im.", "Home Ins.", "Home Int."]);
	});

	it.each([
		["Subscriptions", "Subscr."],
		["Café & Bakery", "Café"],
		["R&D Supplies", "R&D"],
		["🧾 Receipts", "🧾"],
		["Supercalifragilisticexpialidocious", "Superc."],
	])("labels %s as %s", (name, label) => {
		expect(monthEndLabels([name])).toEqual([label]);
	});

	it("is deterministic and keeps unique labels unique", () => {
		const names = ["Home Improvement", "Home Insurance", "Subscriptions"];
		const first = monthEndLabels(names);
		expect(monthEndLabels(names)).toEqual(first);
		expect(new Set(first).size).toBe(names.length);
		expect(monthEndLabels(["Groceries", "Groc."])).toEqual([
			"Groceries",
			"Groc.",
		]);
	});
});

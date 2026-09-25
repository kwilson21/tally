import { describe, expect, it } from "vitest";
import {
	MAX_ACTIVE,
	parseCategory,
	restoreProblem,
} from "../src/settings/category-form";

const form = (fields: Record<string, string>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	return f;
};
const existing = [
	{ id: 1, name: "Groceries", archived: false },
	{ id: 2, name: "Gas", archived: false },
	{ id: 3, name: "Pets", archived: true },
];

describe("parseCategory", () => {
	it("reads a name and a budget in dollars as cents", () => {
		expect(
			parseCategory(
				form({ name: " Travel ", budget: "$1,250.50" }),
				existing,
				null,
			),
		).toEqual({ ok: true, value: { name: "Travel", budgetCents: 125050 } });
	});

	it("leaves the budget alone when it's blank", () => {
		expect(
			parseCategory(form({ name: "Travel", budget: "" }), existing, null),
		).toEqual({
			ok: true,
			value: { name: "Travel", budgetCents: null },
		});
	});

	it("lets a category keep its own name", () => {
		expect(
			parseCategory(form({ name: "gas", budget: "200" }), existing, 2),
		).toMatchObject({
			ok: true,
		});
	});

	it.each([
		["", "Give the category a name."],
		["x".repeat(41), "Keep the name to 40 characters."],
		["GAS", "That name is taken."],
		["pets", "An archived category has that name. Restore it instead."],
		["None of these fit", "That name is reserved for Jev. Pick another."],
		["none of these FIT", "That name is reserved for Jev. Pick another."],
	])("rejects the name %j", (name, message) => {
		expect(parseCategory(form({ name, budget: "" }), existing, null)).toEqual({
			ok: false,
			errors: { name: message },
		});
	});

	it.each(["abc", "-5", "12.345"])("rejects the budget %j", (budget) => {
		expect(
			parseCategory(form({ name: "Travel", budget }), existing, null),
		).toEqual({
			ok: false,
			errors: { budget: "Enter a dollar amount, like 250 or 250.50." },
		});
	});

	it("caps a budget at $1,000,000 a month, so cents stay exact", () => {
		expect(
			parseCategory(
				form({ name: "Travel", budget: "1,000,000" }),
				existing,
				null,
			),
		).toMatchObject({ ok: true, value: { budgetCents: 100000000 } });
		for (const budget of ["1,000,000.01", "99999999999999999999"])
			expect(
				parseCategory(form({ name: "Travel", budget }), existing, null),
			).toEqual({
				ok: false,
				errors: { budget: "Keep the budget to $1,000,000 a month or less." },
			});
	});

	it("has no room for more than 254 active categories, since Jev offers each one plus 'None of these fit'", () => {
		const full = Array.from({ length: MAX_ACTIVE }, (_, i) => ({
			id: i + 1,
			name: `C${i}`,
			archived: false,
		}));
		expect(MAX_ACTIVE).toBe(254);
		expect(
			parseCategory(form({ name: "One more", budget: "" }), full, null),
		).toEqual({
			ok: false,
			errors: {
				name: "Tally has room for 254 categories. Archive one to add another.",
			},
		});
		// Editing an existing one is fine when full.
		expect(
			parseCategory(form({ name: "C0", budget: "" }), full, 1),
		).toMatchObject({ ok: true });
	});
});

describe("restoreProblem", () => {
	it("allows a restore while there's room", () => {
		expect(restoreProblem(existing)).toBeNull();
	});

	it("says why when the list is full", () => {
		const full = Array.from({ length: MAX_ACTIVE }, (_, i) => ({
			id: i + 1,
			name: `C${i}`,
			archived: false,
		}));
		expect(restoreProblem(full)).toBe(
			"Tally has room for 254 categories. Archive one to restore another.",
		);
	});
});

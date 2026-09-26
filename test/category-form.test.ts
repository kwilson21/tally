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
	it("reads the name, trimmed", () => {
		expect(parseCategory(form({ name: " Travel " }), existing, null)).toEqual({
			ok: true,
			value: { name: "Travel" },
		});
	});

	it("lets a category keep its own name", () => {
		expect(parseCategory(form({ name: "gas" }), existing, 2)).toMatchObject({
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
		expect(parseCategory(form({ name }), existing, null)).toEqual({
			ok: false,
			errors: { name: message },
		});
	});

	it("has no room for more than 50 active categories, so every screen can show them all at once", () => {
		const full = Array.from({ length: MAX_ACTIVE }, (_, i) => ({
			id: i + 1,
			name: `C${i}`,
			archived: false,
		}));
		expect(MAX_ACTIVE).toBe(50);
		expect(parseCategory(form({ name: "One more" }), full, null)).toEqual({
			ok: false,
			errors: {
				name: "Tally has room for 50 categories. Archive one to add another.",
			},
		});
		// Editing an existing one is fine when full.
		expect(parseCategory(form({ name: "C0" }), full, 1)).toMatchObject({
			ok: true,
		});
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
			"Tally has room for 50 categories. Archive one to restore another.",
		);
	});
});

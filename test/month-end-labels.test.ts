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
		expect(
			monthEndLabels(["Subscriptions Basic", "Subscriptions Business"]),
		).toEqual(["Subscr. Ba.", "Subscr. Bu."]);
	});

	it("lengthens first words when neither colliding name has another word", () => {
		expect(monthEndLabels(["Holiday", "Holidays"])).toEqual([
			"Holiday",
			"Holiday.",
		]);
		expect(monthEndLabels(["Holiday", "Holidays", "Holidaying"])).toEqual([
			"Holiday",
			"Holidays",
			"Holidayi.",
		]);
		expect(monthEndLabels(["Entertainment", "Entertaining"])).toEqual([
			"Entertainm.",
			"Entertaini.",
		]);
	});

	it("uses the category set, not arrival order, to resolve mixed collisions", () => {
		const names = ["Holiday", "Holidays", "Home Improvement"];
		const expected = new Map([
			["Holiday", "Holiday"],
			["Holidays", "Holiday."],
			["Home Improvement", "Home"],
		]);
		for (const order of [
			names,
			[...names].reverse(),
			["Holidays", "Home Improvement", "Holiday"],
		]) {
			const labels = monthEndLabels(order);
			expect(
				new Map(order.map((name, index) => [name, labels[index]])),
			).toEqual(expected);
		}
	});

	it("keeps starter and drawn labels distinct and stable", () => {
		const names = [
			"Groceries",
			"Eating Out",
			"Gas",
			"Car & Transport",
			"Rent",
			"Utilities",
			"Subscriptions",
			"Shopping",
			"Personal Care",
			"Health",
			"Entertainment",
			"Kids",
			"Date Night",
			"Donations & Charity",
			"Household",
			"Clothing",
			"Gifts",
			"Pets",
		];
		const labels = monthEndLabels(names);
		expect(labels).toEqual([
			"Groc.",
			"Eating",
			"Gas",
			"Car",
			"Rent",
			"Util.",
			"Subscr.",
			"Shoppi.",
			"Person.",
			"Health",
			"Entert.",
			"Kids",
			"Date",
			"Donati.",
			"Home",
			"Cloth.",
			"Gifts",
			"Pets",
		]);
		expect(new Set(labels).size).toBe(names.length);
		const reversed = [...names].reverse();
		const reversedLabels = monthEndLabels(reversed);
		expect(
			new Map(reversed.map((name, index) => [name, reversedLabels[index]])),
		).toEqual(new Map(names.map((name, index) => [name, labels[index]])));
	});

	it("resolves a drawn short name colliding with a household category", () => {
		expect(monthEndLabels(["Household", "Home"])).toEqual([
			"Household",
			"Home",
		]);
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

	it("compares normalized labels and suffixes identical stored names", () => {
		const labels = monthEndLabels(["Caf\u00e9", "Cafe\u0301", "Cafe\u0301"]);
		expect(labels).toEqual(["Café", "Café 2", "Café 3"]);
		expect(new Set(labels).size).toBe(3);
	});
});

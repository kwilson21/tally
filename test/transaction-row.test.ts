import { describe, expect, it } from "vitest";
import type { ListRow } from "../src/db/transactions";
import { Chip } from "../src/views/chip";
import { FormField } from "../src/views/form-field";
import { rowCaption, TransactionRow } from "../src/views/transaction-row";

const base: ListRow = {
	id: 7,
	date: "2026-09-22",
	amountCents: 1200,
	rawName: "SQ *LOCAL BAKERY 4432",
	displayName: "Local Bakery",
	note: null,
	excluded: false,
	income: false,
	categoryId: null,
	categoryName: null,
	categoryIcon: null,
	categoryColor: null,
};

describe("rowCaption", () => {
	it("shows the category when there is one", () => {
		expect(
			rowCaption({
				...base,
				categoryId: 1,
				categoryName: "Groceries",
				categoryIcon: "groceries",
				categoryColor: "cat-blue",
			}),
		).toEqual({ kind: "category", caption: "Groceries", tag: false });
	});

	it("marks income and excluded in words", () => {
		expect(rowCaption({ ...base, income: true })).toMatchObject({
			kind: "income",
			caption: "Income",
		});
		expect(rowCaption({ ...base, excluded: true })).toMatchObject({
			kind: "excluded",
			caption: "Excluded",
		});
	});

	it("flags what needs a category, showing the raw name when it differs", () => {
		expect(rowCaption(base)).toEqual({
			kind: "needs",
			caption: "SQ *LOCAL BAKERY 4432",
			tag: true,
		});
		expect(
			rowCaption({ ...base, displayName: base.rawName }).caption,
		).toBeNull();
	});
});

describe("TransactionRow", () => {
	it("is one link to the edit URL, keeping the filters, with the signed amount", async () => {
		const html = await TransactionRow({
			row: { ...base, income: true, amountCents: -245000 },
			query: "uncategorized=1",
		}).toString();
		expect(html).toContain('href="/transactions/7?uncategorized=1"');
		expect(html).toContain("+$2,450.00");
		expect(html.match(/<a /g)).toHaveLength(1);
	});
});

describe("Chip", () => {
	it("wraps a real, keyboard-reachable input in its label", async () => {
		const html = await Chip({
			type: "checkbox",
			name: "excluded",
			value: "1",
			checked: true,
			children: "Excluded",
		}).toString();
		expect(html).toMatch(/<label[^>]*>[\s\S]*<input[^>]*type="checkbox"/);
		expect(html).toContain("checked");
		expect(html).toContain('class="sr-only"');
	});
});

describe("FormField", () => {
	it("labels its control and announces an error", async () => {
		const html = await FormField({
			id: "note",
			label: "Note",
			error: "Too long.",
			children: "<control>",
		}).toString();
		expect(html).toContain('<label for="note"');
		expect(html).toContain('role="alert"');
		expect(html).toContain('id="note-error"');
	});
});

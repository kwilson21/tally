import { jsx } from "hono/jsx";
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
	it("is one link to the edit URL when given one, with the signed amount", async () => {
		const html = await TransactionRow({
			row: { ...base, income: true, amountCents: -245000 },
			href: "/transactions/7?uncategorized=1",
		}).toString();
		expect(html).toContain('href="/transactions/7?uncategorized=1"');
		expect(html).toContain("+$2,450.00");
		expect(html.match(/<a /g)).toHaveLength(1);
	});

	it("has one fixed height, with the Needs category tag on the caption line", async () => {
		const html = await TransactionRow({ row: base }).toString();
		expect(html).toMatch(/<div class="[^"]*\bh-16\b/);
		// Two lines only: the name, then the caption with the tag beside it.
		expect(html).toMatch(
			/<span class="flex[^"]*"><span class="truncate[^"]*">SQ \*LOCAL BAKERY 4432<\/span><span[^>]*>Needs category<\/span><\/span>/,
		);
	});

	it("is a plain row without a link otherwise", async () => {
		const html = await TransactionRow({ row: base }).toString();
		expect(html).not.toContain("<a ");
		expect(html).toContain('data-transaction="7"');
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

	it("shows a check mark on a switched-on toggle, so its state isn't color alone", async () => {
		const toggle = await Chip({
			type: "checkbox",
			name: "excluded",
			value: "1",
			children: "Exclude from budget",
		}).toString();
		// Always rendered; CSS shows it only while the box is checked (no JavaScript).
		expect(toggle).toMatch(
			/<span class="hidden group-has-\[:checked\]:inline-flex"[^>]*><svg/,
		);
		const radio = await Chip({
			type: "radio",
			name: "category",
			value: "1",
			children: "Groceries",
		}).toString();
		expect(radio).not.toContain("group-has-[:checked]:inline-flex");
	});
});

describe("FormField", () => {
	it("labels its control and links the error to it", async () => {
		const html = await FormField({
			id: "note",
			label: "Note",
			error: "Too long.",
			children: (a11y) => jsx("textarea", { id: "note", ...a11y }),
		}).toString();
		expect(html).toContain('<label for="note"');
		expect(html).toMatch(
			/<textarea[^>]*aria-describedby="note-error"[^>]*aria-invalid="true"/,
		);
		expect(html).toMatch(/<p id="note-error" role="alert"/);
	});

	it("adds no error attributes when there's no error", async () => {
		const html = await FormField({
			id: "q",
			label: "Search",
			children: (a11y) => jsx("input", { id: "q", ...a11y }),
		}).toString();
		expect(html).not.toContain("aria-describedby");
		expect(html).not.toContain("aria-invalid");
	});
});

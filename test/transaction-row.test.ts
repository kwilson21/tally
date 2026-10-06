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
	creditReviewed: true,
	categoryId: null,
	categoryName: null,
	categoryIcon: null,
	categoryColor: null,
};

describe("rowCaption", () => {
	it("shows a newly imported credit as needing review", async () => {
		expect(
			rowCaption({ ...base, amountCents: -2500, creditReviewed: false }),
		).toMatchObject({
			caption: "Review credit",
			tag: false,
		});
		const html = await TransactionRow({
			row: {
				...base,
				amountCents: -2500,
				creditReviewed: false,
				categoryId: 1,
			},
		}).toString();
		expect(html).toContain("Review credit");
		expect(html).not.toContain("Needs category");
	});
	const kids = {
		categoryId: 4,
		categoryName: "Kids",
		categoryIcon: "kids",
		categoryColor: "cat-ochre",
	};
	it("names the purchase a linked refund is for, with the year only when it differs", () => {
		expect(
			rowCaption({
				...base,
				...kids,
				refundOfId: 3,
				refundPurchaseDate: "2026-09-05",
			}),
		).toEqual({
			kind: "category",
			caption: "Kids · Refund for Sep 5",
			tag: false,
		});
		expect(
			rowCaption({
				...base,
				...kids,
				date: "2027-01-02",
				refundOfId: 3,
				refundPurchaseDate: "2026-12-20",
			}).caption,
		).toBe("Kids · Refund for Dec 20, 2026");
	});

	it("leaves the Needs category tag to the purchase of a linked refund", () => {
		expect(
			rowCaption({
				...base,
				refundOfId: 3,
				refundPurchaseDate: "2026-09-05",
				followsPurchase: true,
			}),
		).toEqual({ kind: "needs", caption: "Refund for Sep 5", tag: false });
		// Once the purchase is excluded, the refund counts on its own and asks for its own category.
		expect(
			rowCaption({ ...base, refundOfId: 3, refundPurchaseDate: "2026-09-05" })
				.tag,
		).toBe(true);
	});

	it("shows how much of a purchase or a split part was refunded", () => {
		expect(rowCaption({ ...base, ...kids, refundedCents: 2499 }).caption).toBe(
			"Kids · $24.99 refunded",
		);
		expect(
			rowCaption({
				...base,
				...kids,
				parentId: 9,
				parentName: "Target",
				refundedCents: 2499,
			}).caption,
		).toBe("Kids · Split from Target · $24.99 refunded");
	});

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

	it("uses bank text on an uncategorized refund only when no refund pair supplies a caption", async () => {
		expect(
			rowCaption({
				...base,
				refundOfId: 3,
				refundPurchaseDate: "2026-09-05",
			}).caption,
		).toBe("Refund for Sep 5");
		expect(rowCaption({ ...base, displayName: "Bakery" }).caption).toBe(
			"SQ *LOCAL BAKERY 4432",
		);
		const pending = await TransactionRow({
			row: {
				...base,
				pending: true,
				refundOfId: 3,
				refundPurchaseDate: "2026-09-05",
			},
		}).toString();
		expect(pending).toContain(
			'Pending ·</span><span class="truncate text-muted">Refund for Sep 5',
		);
		expect(pending).not.toContain("SQ *LOCAL BAKERY 4432");
	});

	it("explains when a bank amount change removed a saved split", () => {
		expect(rowCaption({ ...base, splitRemovedFromCents: 1234 })).toEqual({
			kind: "needs",
			caption: "The bank changed this from $12.34, so its split was removed.",
			tag: true,
		});
	});

	it("names a split part's category next to its parent", () => {
		expect(
			rowCaption({
				...base,
				parentId: 9,
				parentName: "Costco",
				categoryName: "Groceries",
			})?.caption,
		).toBe("Groceries · Split from Costco");
	});

	it("names the bill on split payment parts and parent, leaving other splits alone", () => {
		expect(
			rowCaption({
				...base,
				parentId: 9,
				parentName: "Costco",
				parentBillName: "Rent",
				paysBill: true,
				categoryName: "Groceries",
			}).caption,
		).toBe("Groceries · Split from Costco · paid Rent bill");
		expect(
			rowCaption({
				...base,
				isSplit: true,
				paysBill: true,
				billName: "Rent",
			}).caption,
		).toBe("Split transaction · paid Rent bill");
		expect(
			rowCaption({ ...base, parentId: 9, parentName: "Costco" }).caption,
		).toBe("Split from Costco");
	});

	it("names the bill a payment paid after its category", () => {
		expect(
			rowCaption({
				...base,
				categoryName: "Rent",
				paysBill: true,
				billName: "Rent",
			}),
		).toMatchObject({ kind: "category", caption: "Rent · paid Rent bill" });
		expect(
			rowCaption({
				...base,
				categoryName: "Utilities",
				paysBill: true,
				billName: "Internet",
				categoryId: 3,
			}),
		).toMatchObject({
			kind: "category",
			caption: "Utilities · paid Internet bill",
		});
	});

	it("drops the bank-change note once the purchase has a category again", () => {
		expect(
			rowCaption({ ...base, splitRemovedFromCents: 1234, categoryId: 1 })
				?.caption,
		).not.toContain("The bank changed this");
	});
});

describe("TransactionRow", () => {
	it("leaves Counts in off a linked refund, whose caption already explains it", async () => {
		const row = {
			...base,
			date: "2026-09-26",
			countsInMonth: "2026-08",
			refundOfId: 3,
			refundPurchaseDate: "2026-08-20",
		};
		const html = await TransactionRow({ row }).toString();
		expect(html).toContain("Refund for Aug 20");
		expect(html).not.toContain("Counts in");
		const payment = await TransactionRow({
			row: { ...base, countsInMonth: "2026-08" },
		}).toString();
		expect(payment).toContain("Counts in");
	});

	it("keeps Counts in on a linked refund when a bill moved its purchase's month", async () => {
		const html = await TransactionRow({
			row: {
				...base,
				date: "2026-10-12",
				countsInMonth: "2026-09",
				refundOfId: 3,
				refundPurchaseDate: "2026-10-02",
			},
		}).toString();
		expect(html).toContain("Refund for Oct 2");
		expect(html).toContain("Counts in September");
	});

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

	it("shows Maybe only when the row still needs a category", async () => {
		const suggested = {
			...base,
			maybeCategoryName: "Groceries",
			categoryConfidence: 0.6,
		};
		const needs = await TransactionRow({ row: suggested }).toString();
		expect(needs).toContain("Maybe");
		for (const row of [
			{ ...suggested, categoryId: 1, categoryName: "Groceries" },
			{ ...suggested, excluded: true },
			{ ...suggested, amountCents: -1200, creditReviewed: false },
			{ ...suggested, income: true },
		]) {
			const html = await TransactionRow({ row }).toString();
			expect(html).not.toContain("Maybe");
		}
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
			/<textarea[^>]*aria-describedby="note-error"[^>]*aria-invalid="true"[^>]*class="field-shake"/,
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

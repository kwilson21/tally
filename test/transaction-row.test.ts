import { jsx } from "hono/jsx";
import { describe, expect, it } from "vitest";
import type { ListRow } from "../src/db/transactions";
import { Chip } from "../src/views/chip";
import { FormField } from "../src/views/form-field";
import { MaybeCategory } from "../src/views/maybe-category";
import { SelectableTransactionRow } from "../src/views/selectable-transaction-row";
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

/** The caption line's text, as a reader hears it: its tags stripped, and no-break spaces read as spaces. */
const captionLine = (html: string) => {
	const start = html.indexOf(
		'<span class="flex min-w-0 items-center gap-2 leading-6">',
	);
	const end = html.indexOf(
		'</span></span><span class="shrink-0 text-lg">',
		start,
	);
	return html
		.slice(start, end)
		.replace(/<[^>]+>/g, "")
		.replaceAll(" ", " ");
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

	it("shows a low confidence income guess instead of Review credit", async () => {
		const row = {
			...base,
			amountCents: -2500,
			creditReviewed: false,
			incomeConfidence: 0.71,
		};
		expect(rowCaption(row)).toMatchObject({
			caption: "Maybe income",
			tag: false,
		});
		const html = await TransactionRow({ row }).toString();
		expect(html).toContain("Maybe income");
		expect(html).not.toContain("Review credit");
	});
	it.each([
		[0.1999, false],
		[0.2, false],
		[0.2001, true],
		[0.7949, true],
		[0.795, true],
		[0.7999, true],
		[0.8, false],
		[0.8001, false],
	] as const)(
		"income visibility at %s is maybe income: %s",
		async (confidence, visible) => {
			const row = {
				...base,
				amountCents: -2500,
				creditReviewed: false,
				incomeConfidence: confidence,
			};
			expect(rowCaption(row).caption === "Maybe income").toBe(visible);
			expect(
				(await TransactionRow({ row }).toString()).includes("Maybe income"),
			).toBe(visible);
		},
	);
	it("shows the applied 0.8 answer as Income", async () => {
		const row = {
			...base,
			amountCents: -2500,
			income: true,
			incomeConfidence: 0.8,
		};
		expect(rowCaption(row).caption).toBe("Income");
		expect(await TransactionRow({ row }).toString()).not.toContain(
			"Maybe income",
		);
	});
	it.each([0.5, 0.71])(
		"shows an unsure income answer at %s",
		async (confidence) => {
			const row = {
				...base,
				amountCents: -2500,
				creditReviewed: false,
				incomeConfidence: confidence,
			};
			expect(rowCaption(row).caption).toBe("Maybe income");
			expect(await TransactionRow({ row }).toString()).toContain(
				"Maybe income",
			);
		},
	);
	it("keeps an excluded transfer ahead of an income suggestion", async () => {
		const row = {
			...base,
			amountCents: -2500,
			excluded: true,
			creditReviewed: false,
			incomeConfidence: 0.5,
		};
		expect(rowCaption(row)).toMatchObject({
			kind: "excluded",
			caption: "Excluded",
		});
		expect(await TransactionRow({ row }).toString()).not.toContain(
			"Maybe income",
		);
	});
	it("does not add Needs category beside Maybe income for a none-fit category", async () => {
		const row = {
			...base,
			amountCents: -2500,
			creditReviewed: false,
			incomeConfidence: 0.5,
			jevNoneFit: true,
		};
		const html = await TransactionRow({ row }).toString();
		expect(html).toContain("Maybe income");
		expect(html).not.toContain("Needs category");
	});
	it("hides a reviewed non-income credit's income guess", async () => {
		const row = {
			...base,
			amountCents: -1200,
			creditReviewed: true,
			incomeConfidence: 0.71,
		};
		expect(rowCaption(row).caption).not.toBe("Maybe income");
		const html = await TransactionRow({ row }).toString();
		expect(html).not.toContain("Maybe income");
	});
	it("shows a selected income as plain Income even if confidence is low", async () => {
		const row = {
			...base,
			amountCents: -1200,
			income: true,
			incomeConfidence: 0.71,
		};
		expect(rowCaption(row)).toMatchObject({
			caption: "Income",
			kind: "income",
		});
		const html = await TransactionRow({ row }).toString();
		expect(html).toContain(">Income</span>");
		expect(html).not.toContain("Maybe income");
	});
	it("leaves a confident Jev income as plain Income", async () => {
		const row = {
			...base,
			amountCents: -1200,
			income: true,
			incomeConfidence: 0.95,
		};
		const html = await TransactionRow({ row }).toString();
		expect(rowCaption(row)).toMatchObject({
			caption: "Income",
			kind: "income",
		});
		expect(html).toContain(">Income</span>");
		expect(html).not.toContain("Maybe income");
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

	it("keeps refund captions ahead of an uncategorized purchase note", () => {
		expect(
			rowCaption({ ...base, note: "Dinner", refundedCents: 2499 }).caption,
		).toBe("$24.99 refunded");
		expect(
			rowCaption({
				...base,
				note: "Dinner",
				refundOfId: 3,
				refundPurchaseDate: "2026-09-05",
			}).caption,
		).toBe("Refund for Sep 5");
	});

	it("keeps a refunded bill payment's refund and bill together ahead of its note (#313)", () => {
		const payment = {
			...base,
			note: "Dinner",
			paysBill: true,
			billName: "Electric",
		};
		expect(rowCaption({ ...payment, refundedCents: 1500 })).toEqual({
			kind: "needs",
			caption: "$15.00 refunded · paid Electric bill",
			tag: true,
		});
		expect(rowCaption(payment).caption).toBe("paid Electric bill");
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
		expect(pending).toContain("Pending ·");
		expect(pending).toContain("Refund for Sep 5");
		expect(pending).not.toContain("SQ *LOCAL BAKERY 4432");
	});

	it("explains when a bank amount change removed a saved split", () => {
		expect(rowCaption({ ...base, splitRemovedFromCents: 1234 })).toEqual({
			kind: "needs",
			caption: "The bank changed this from $12.34, so its split was removed.",
			tag: true,
		});
	});

	it("says which bill payment the bank change unlinked, after the note", () => {
		expect(
			rowCaption({
				...base,
				splitRemovedFromCents: 1234,
				splitRemovedBills: '[{"name":"Costco membership","period":"2026"}]',
			}),
		).toEqual({
			kind: "needs",
			caption:
				"The bank changed this from $12.34, so its split was removed. The Costco membership bill for 2026 is no longer paid.",
			tag: true,
		});
	});

	it("keeps the bill sentence beside the category the purchase went back to", () => {
		expect(
			rowCaption({
				...base,
				splitRemovedFromCents: 1234,
				splitRemovedBills:
					'[{"name":"Water","period":"2026-09"},{"name":"Costco membership","period":"2026"}]',
				categoryId: 1,
				categoryName: "Groceries",
			}),
		).toEqual({
			kind: "category",
			caption:
				"Groceries · The bank changed this from $12.34, so its split was removed. 2 bills are no longer paid.",
			tag: false,
		});
	});

	it("keeps a categorized purchase's refund and bill beside its bank-change note (#382)", () => {
		expect(
			rowCaption({
				...base,
				...kids,
				splitRemovedFromCents: 1234,
				refundedCents: 2499,
				paysBill: true,
				billName: "Electric",
			}),
		).toEqual({
			kind: "category",
			caption:
				"Kids · The bank changed this from $12.34, so its split was removed. · $24.99 refunded · paid Electric bill",
			tag: false,
		});
	});

	it("keeps an uncategorized bill payment's refund and bill after its bank-change note (#382)", () => {
		expect(
			rowCaption({
				...base,
				paysBill: true,
				billName: "Electric",
				splitRemovedFromCents: 1234,
			}),
		).toEqual({
			kind: "needs",
			caption:
				"The bank changed this from $12.34, so its split was removed. · paid Electric bill",
			tag: true,
		});
		expect(
			rowCaption({
				...base,
				paysBill: true,
				billName: "Electric",
				splitRemovedFromCents: 1234,
				refundedCents: 1500,
			}),
		).toEqual({
			kind: "needs",
			caption:
				"The bank changed this from $12.34, so its split was removed. · $15.00 refunded · paid Electric bill",
			tag: true,
		});
	});

	it("keeps a refund that follows its purchase beside the bill it paid (#382)", () => {
		expect(
			rowCaption({
				...base,
				refundOfId: 3,
				refundPurchaseDate: "2026-09-05",
				followsPurchase: true,
				paysBill: true,
				billName: "Electric",
			}),
		).toEqual({
			kind: "needs",
			caption: "Refund for Sep 5 · paid Electric bill",
			tag: false,
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
			rowCaption({
				...base,
				parentId: 9,
				parentName: "Costco",
				paysBill: true,
				billName: "Internet",
			}).caption,
		).toBe("Split from Costco · paid Internet bill");
		expect(
			rowCaption({
				...base,
				parentId: 9,
				parentName: "Costco",
				paysBill: true,
				parentBillName: "Rent",
			}).caption,
		).toBe("Split from Costco · paid Rent bill");
		expect(
			rowCaption({
				...base,
				parentId: 9,
				parentName: "Costco",
				paysBill: true,
				billName: "Internet",
				parentBillName: "Rent",
			}).caption,
		).toBe("Split from Costco · paid Internet bill");
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

	it("names the planned expense a payment paid, after its category, as a bill's is named", () => {
		expect(
			rowCaption({
				...base,
				categoryName: "Auto",
				categoryId: 5,
				paysPlan: true,
				planName: "Car registration",
			}),
		).toEqual({
			kind: "category",
			caption: "Auto · paid Car registration",
			tag: false,
		});
		// Uncategorized, the plan's name is its fact in the Needs category row, as a bill's is.
		expect(
			rowCaption({ ...base, paysPlan: true, planName: "Car registration" }),
		).toEqual({ kind: "needs", caption: "paid Car registration", tag: true });
	});

	it("keeps the bank-change note beside the category it went back to, until a person decides", () => {
		expect(
			rowCaption({
				...base,
				splitRemovedFromCents: 1234,
				categoryId: 1,
				categoryName: "Groceries",
			}),
		).toEqual({
			kind: "category",
			caption:
				"Groceries · The bank changed this from $12.34, so its split was removed.",
			tag: false,
		});
	});

	it("says only Income on an income row whose bank change removed its split, with its restored category", () => {
		expect(
			rowCaption({
				...base,
				amountCents: -18742,
				income: true,
				splitRemovedFromCents: 18742,
				categoryId: 1,
				categoryName: "Groceries",
			}),
		).toEqual({ kind: "income", caption: "Income", tag: false });
	});

	it("says only Income on an income row whose bank change removed its split, with no category yet", () => {
		expect(
			rowCaption({
				...base,
				amountCents: -18742,
				income: true,
				splitRemovedFromCents: 18742,
				categoryId: null,
			}),
		).toEqual({ kind: "income", caption: "Income", tag: false });
	});

	it("says a refund is no longer linked after the bank changed its purchase", () => {
		expect(
			rowCaption({
				...base,
				amountCents: -500,
				categoryId: 1,
				categoryName: "Kids",
				refundUnlinkedPurchaseDate: "2026-09-10",
			}),
		).toEqual({
			kind: "category",
			caption:
				"Kids · The bank changed the Sep 10 purchase, so this refund is no longer linked",
			tag: false,
		});
	});

	it("says a split refund's part is no longer linked after its split, following Split from", () => {
		expect(
			rowCaption({
				...base,
				amountCents: -500,
				parentId: 9,
				parentName: "Amazon",
				categoryName: "Kids",
				refundUnlinkedPurchaseDate: "2026-09-10",
			}),
		).toEqual({
			kind: "category",
			caption:
				"Kids · Split from Amazon · The bank changed the Sep 10 purchase, so this refund is no longer linked",
			tag: false,
		});
	});

	it("says a refund with no category is no longer linked, and that it needs one", () => {
		expect(
			rowCaption({
				...base,
				amountCents: -500,
				refundUnlinkedPurchaseDate: "2026-09-10",
			}),
		).toEqual({
			kind: "needs",
			caption:
				"The bank changed the Sep 10 purchase, so this refund is no longer linked",
			tag: true,
		});
	});
});

describe("TransactionRow", () => {
	it.each([
		{
			name: "a bill caption before a guessed note",
			row: {
				note: "Dinner",
				noteGuessed: true,
				paysBill: true,
				billName: "Rent",
			},
			caption: "paid Rent bill",
			showsGuessedNote: false,
		},
		{
			name: "a refund caption before a guessed note",
			row: {
				note: "Dinner",
				noteGuessed: true,
				refundOfId: 3,
				refundPurchaseDate: "2026-09-05",
			},
			caption: "Refund for Sep 5",
			showsGuessedNote: false,
		},
		{
			name: "a split part followed by its bill",
			row: {
				parentId: 9,
				parentName: "Costco",
				parentBillName: "Rent",
				paysBill: true,
			},
			caption: "Split from Costco · paid Rent bill",
			showsGuessedNote: false,
		},
		{
			name: "Excluded before a guessed note",
			row: { excluded: true, note: "Dinner", noteGuessed: true },
			caption: "Excluded",
			showsGuessedNote: false,
		},
		{
			name: "Pending before bank text",
			row: { pending: true },
			caption: "SQ *LOCAL BAKERY 4432",
			showsGuessedNote: false,
		},
	])(
		"keeps $name in the caption order",
		async ({ row, caption, showsGuessedNote }) => {
			const transaction = { ...base, ...row };
			expect(rowCaption(transaction).caption).toBe(caption);
			const html = await TransactionRow({ row: transaction }).toString();
			expect(html.includes("Tally&#39;s guess:")).toBe(showsGuessedNote);
			if (transaction.pending) {
				expect(html).toContain("Pending");
				expect(html).not.toContain("SQ *LOCAL BAKERY 4432");
			}
		},
	);

	it("marks only a caption that shows the guessed note", async () => {
		const category = await TransactionRow({
			row: {
				...base,
				note: "Dinner",
				noteGuessed: true,
				categoryId: 1,
				categoryName: "Groceries",
				categoryIcon: "groceries",
				categoryColor: "cat-blue",
			},
		}).toString();
		expect(category).not.toContain("Tally&#39;s guess");
		expect(category).not.toContain("decoration-dashed");
		const note = await TransactionRow({
			row: { ...base, note: "Dinner", noteGuessed: true },
		}).toString();
		expect(note).toContain("Tally&#39;s guess:");
		expect(note).toContain("decoration-dashed");
	});
	it("prioritizes Maybe income over an unsure category on the row", async () => {
		const row = {
			...base,
			amountCents: -2500,
			creditReviewed: false,
			incomeConfidence: 0.5,
			maybeCategoryName: "Groceries",
			categoryConfidence: 0.5,
		};
		const html = await TransactionRow({ row }).toString();
		expect(html).toContain("Maybe income");
		expect(html).not.toContain("Maybe Groceries");
	});
	it("lets a long category guess shrink and truncate", async () => {
		const html = await MaybeCategory({
			name: "A category name long enough to reach the amount",
			kind: "category",
		}).toString();
		expect(html).toContain("truncate");
		expect(html).not.toContain("shrink-0");
	});

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

	it("has one fixed height, with Needs category in words on the caption line", async () => {
		const html = await TransactionRow({ row: base }).toString();
		expect(html).toMatch(/<div class="[^"]*\bh-16\b/);
		// Two lines only: the name, then the caption, which says Needs category in words before the bank text.
		expect(html).toMatch(
			/<span class="flex min-w-0 items-center gap-2 leading-6"><span class="flex min-w-0"><span class="shrink-0 text-muted">Needs category\u00a0·\u00a0<\/span><span class="truncate text-muted ?">SQ \*LOCAL BAKERY 4432<\/span><\/span><\/span>/,
		);
	});

	it("says Needs category in words, and the dot has one space each side, with no pill", async () => {
		const html = await TransactionRow({ row: base }).toString();
		expect(html).toContain("Needs category\u00a0·\u00a0");
		expect(html).not.toContain("bg-band");
		expect(html).not.toContain("rounded-control");
	});

	it("says only Needs category, with no dot, when the row has no other caption", async () => {
		const html = await TransactionRow({
			row: { ...base, displayName: "SQ *LOCAL BAKERY 4432" },
		}).toString();
		expect(html).toContain(
			'<span class="shrink-0 text-muted">Needs category</span>',
		);
		expect(html).not.toContain("·");
	});

	it("reads Pending · Needs category when the bank text goes", async () => {
		const html = await TransactionRow({
			row: { ...base, pending: true },
		}).toString();
		expect(html).toContain(
			'<span class="shrink-0 text-muted">Pending · Needs category</span>',
		);
		expect(captionLine(html)).toBe("Pending · Needs category");
		expect(html).not.toContain("SQ *LOCAL BAKERY 4432");
	});

	it("reads Pending · Needs category · and the bank change's note on a pending row whose split the bank changed", async () => {
		const html = await TransactionRow({
			row: { ...base, pending: true, splitRemovedFromCents: 1234 },
		}).toString();
		expect(captionLine(html)).toBe(
			"Pending · Needs category · The bank changed this from $12.34, so its split was removed.",
		);
	});

	it("keeps Needs category first in a caption with the bank change, a refund and a bill", async () => {
		const html = await TransactionRow({
			row: {
				...base,
				paysBill: true,
				billName: "Electric",
				splitRemovedFromCents: 1234,
				refundedCents: 1500,
			},
		}).toString();
		expect(captionLine(html)).toBe(
			"Needs category · The bank changed this from $12.34, so its split was removed. · $15.00 refunded · paid Electric bill",
		);
	});

	it("reads a refund that follows its purchase as its date and bill, with no Needs category", async () => {
		const html = await TransactionRow({
			row: {
				...base,
				refundOfId: 3,
				refundPurchaseDate: "2026-09-05",
				followsPurchase: true,
				paysBill: true,
				billName: "Electric",
			},
		}).toString();
		expect(captionLine(html)).toBe("Refund for Sep 5 · paid Electric bill");
		expect(html).not.toContain("Needs category");
	});

	it("keeps a Maybe guess's dashed tag instead of the words", async () => {
		const html = await TransactionRow({
			row: {
				...base,
				maybeCategoryName: "Groceries",
			},
		}).toString();
		expect(html).toContain("Maybe");
		expect(html).not.toContain("Needs category");
	});

	it("truncates an unbroken merchant name inside the fixed-height row", async () => {
		const html = await TransactionRow({
			row: { ...base, displayName: "x".repeat(48) },
		}).toString();
		expect(html).toMatch(
			new RegExp(
				`<span class="[^"]*\\btruncate\\b[^"]*">${"x".repeat(48)}<\\/span>`,
			),
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

	it("keeps a bank-change sentence over a Maybe category on an unlinked refund, which still needs one", async () => {
		const html = await TransactionRow({
			row: {
				...base,
				amountCents: -500,
				maybeCategoryName: "Kids",
				refundUnlinkedPurchaseDate: "2026-09-10",
			},
		}).toString();
		expect(html).toContain(
			"The bank changed the Sep 10 purchase, so this refund is no longer linked",
		);
		expect(html).toContain("Needs category");
		expect(html).not.toContain("Maybe Kids");
	});

	it("keeps the bank-change note over a Maybe category on a split-removed purchase, which still needs one", async () => {
		const html = await TransactionRow({
			row: {
				...base,
				splitRemovedFromCents: 1234,
				maybeCategoryName: "Groceries",
			},
		}).toString();
		expect(html).toContain(
			"The bank changed this from $12.34, so its split was removed.",
		);
		expect(html).toContain("Needs category");
		expect(html).not.toContain("Maybe Groceries");
	});

	it("is a plain row without a link otherwise", async () => {
		const html = await TransactionRow({ row: base }).toString();
		expect(html).not.toContain("<a ");
		expect(html).toContain('data-transaction="7"');
	});
});

describe("a TransactionRow that opens", () => {
	it("ends in the muted arrow after the amount, hung into the margin", async () => {
		const html = await TransactionRow({
			row: base,
			href: "/transactions/7",
		}).toString();
		expect(html).toMatch(
			/<span class="shrink-0 text-lg">[^<]*<\/span><svg class="size-5 shrink-0 -ml-3 -mr-2 text-muted group-hover\/row:text-ink" viewBox="0 0 24 24"[^>]*aria-hidden="true" data-icon="chevron-right"/,
		);
	});

	it("is marked as opening, so it takes the press tint and its arrow turns ink on hover", async () => {
		const html = await TransactionRow({
			row: base,
			href: "/transactions/7",
		}).toString();
		expect(html).toContain(
			'class="flex h-16 items-center gap-4 text-ink no-underline group/row row-opens"',
		);
	});

	it("has no arrow and no press on a row that opens nothing, in Select mode or as a split parent", async () => {
		const plain = await TransactionRow({ row: base }).toString();
		const selectable = await SelectableTransactionRow({
			row: base,
			today: "2026-09-22",
		}).toString();
		for (const html of [plain, selectable]) {
			expect(html).not.toContain("chevron-right");
			expect(html).not.toContain("row-opens");
		}
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

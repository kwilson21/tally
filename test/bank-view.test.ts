import { describe, expect, it } from "vitest";
import type { ListRow } from "../src/db/transactions";
import { bankRow } from "../src/transactions/bank-view";
import { rowCaption } from "../src/views/transaction-row";

// A row as Tally has decided it, every decision at once.
const decided: ListRow = {
	id: 7,
	date: "2026-10-03",
	amountCents: -245000,
	rawName: "ACME CORP PAYROLL",
	displayName: "Paycheck, Acme Corp",
	note: "October pay",
	excluded: true,
	paysBill: true,
	income: true,
	creditReviewed: false,
	categoryId: 3,
	categoryName: "Groceries",
	categoryIcon: "groceries",
	categoryColor: "cat-blue",
	countsInMonth: "2026-09",
	parentId: 2,
	parentName: "Costco",
	isSplit: true,
	splitRemovedFromCents: 100,
	refundOfId: 4,
	refundPurchaseDate: "2026-09-01",
	followsPurchase: true,
	refundedCents: 500,
	pending: true,
	nameSuggested: true,
};

describe("bankRow", () => {
	it("keeps what the bank sent: the date, the amount, the raw text and whether it is pending", () => {
		const row = bankRow(decided);
		expect(row.id).toBe(7);
		expect(row.date).toBe("2026-10-03");
		expect(row.amountCents).toBe(-245000);
		expect(row.rawName).toBe("ACME CORP PAYROLL");
		expect(row.displayName).toBe("ACME CORP PAYROLL");
		expect(row.pending).toBe(true);
	});

	it("takes away everything Tally or a person decided", () => {
		const row = bankRow(decided);
		expect(row).toMatchObject({
			excluded: false,
			income: false,
			categoryId: null,
			categoryName: null,
			categoryIcon: null,
			categoryColor: null,
			note: null,
			nameSuggested: false,
		});
		expect(row.paysBill).toBeFalsy();
		expect(row.countsInMonth).toBeFalsy();
		expect(row.parentId).toBeFalsy();
		expect(row.isSplit).toBeFalsy();
		expect(row.refundOfId).toBeFalsy();
		expect(row.followsPurchase).toBeFalsy();
		expect(row.refundedCents).toBeFalsy();
	});

	it("says Needs category on every row, a credit too, with no caption of its own", () => {
		const credit = rowCaption(bankRow(decided));
		expect(credit).toEqual({ kind: "needs", caption: null, tag: true });
		const spend = rowCaption(
			bankRow({ ...decided, amountCents: 6418, income: false }),
		);
		expect(spend).toEqual({ kind: "needs", caption: null, tag: true });
	});
});

import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { appleRowCells } from "../src/apple-card/csv";

// A row's cleaned cells, decoded at the edge into the typed row (#1120). The answers the reader gives are pinned by
// apple-card-csv-characterise.test.ts; these check the schema itself: its typed value, its sentence and its order.

const GOOD = [
	"10/03/2026",
	"10/04/2026",
	"GREENLEAF MARKET",
	"Greenleaf Market",
	"Grocery",
	"Purchase",
	"38.40",
];

function decode(cells: readonly string[], line = 2) {
	return Schema.decodeUnknownResult(appleRowCells(line))(cells);
}

describe("appleRowCells, the row's schema (#1120)", () => {
	it("decodes the cells into the typed row, with dates as YYYY-MM-DD and money as cents", () => {
		const read = decode(GOOD);

		expect(Result.isSuccess(read)).toBe(true);
		expect(Result.isSuccess(read) && read.success).toEqual({
			transactionDate: "2026-10-03",
			clearingDate: "2026-10-04",
			description: "GREENLEAF MARKET",
			merchant: "Greenleaf Market",
			category: "Grocery",
			type: "Purchase",
			amountCents: 3840,
		});
	});

	it("reads a blank clearing date, merchant and category as null, and a negative amount as money in", () => {
		const read = decode([
			"10/03/2026",
			"",
			"PAYMENT",
			"",
			"",
			"Payment",
			"-0.00",
		]);

		expect(Result.isSuccess(read) && read.success).toEqual({
			transactionDate: "2026-10-03",
			clearingDate: null,
			description: "PAYMENT",
			merchant: null,
			category: null,
			type: "Payment",
			amountCents: 0,
		});
		expect(
			Result.isSuccess(read) && Object.is(read.success.amountCents, -0),
		).toBe(false);
	});

	it("refuses a dollar sign with the amount sentence for its row", () => {
		const read = decode([...GOOD.slice(0, 6), "$5"], 7);

		expect(Result.isFailure(read) && read.failure.message).toBe(
			"Row 7's amount can't be read. Nothing was added.",
		);
	});

	it("refuses a bad amount before a bad date", () => {
		const read = decode(["2/30/2024", "", "D", "M", "C", "Purchase", "x"], 3);

		expect(Result.isFailure(read) && read.failure.message).toBe(
			"Row 3's amount can't be read. Nothing was added.",
		);
	});

	it("refuses a bad clearing date with the date sentence, even when the transaction date is good", () => {
		const read = decode(
			["10/03/2026", "2/30/2026", "D", "M", "C", "Purchase", "5.00"],
			4,
		);

		expect(Result.isFailure(read) && read.failure.message).toBe(
			"Row 4's date can't be read. Nothing was added.",
		);
	});

	it("refuses a blank description or type as an unreadable row", () => {
		const read = decode(
			["10/03/2026", "", "", "M", "C", "Purchase", "5.00"],
			5,
		);

		expect(Result.isFailure(read) && read.failure.message).toBe(
			"Row 5 can't be read. Nothing was added.",
		);
	});
});

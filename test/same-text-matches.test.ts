import { describe, expect, it } from "vitest";
import {
	groupBySameCleanedText,
	type SameTextRow,
	VAGUE_TEXTS,
} from "../src/same-text-matches";

// Rows that share a cleaned bank text (decision 157 step A) form a group. Never by merchant name alone, never on a
// trip Jev calls mixed (decision 90), and a vague line (APPLE.COM/BILL) only with the same "what it was" note.

function row(
	id: number,
	rawName: string,
	extra: Partial<SameTextRow> = {},
): SameTextRow {
	return {
		id,
		rawName,
		merchantKey: rawName,
		mixed: false,
		whatItWasNote: null,
		...extra,
	};
}

describe("groupBySameCleanedText", () => {
	it("groups two Audible rows", () => {
		const groups = groupBySameCleanedText([
			row(1, "Audible"),
			row(2, "AUDIBLE  09/02"),
		]);

		expect(groups).toHaveLength(1);
		expect(groups[0]?.cleanedText).toBe("audible");
		expect(groups[0]?.note).toBeNull();
		expect(groups[0]?.rows.map((r) => r.id)).toEqual([1, 2]);
	});

	it("groups two CHECKCARD rows at one store whose terminal codes differ", () => {
		const groups = groupBySameCleanedText([
			row(1, "CHECKCARD 0921 CVS"),
			row(2, "CHECKCARD 1137 CVS"),
		]);

		expect(groups).toHaveLength(1);
		expect(groups[0]?.cleanedText).toBe("cvs");
		expect(groups[0]?.rows.map((r) => r.id)).toEqual([1, 2]);
	});

	it("drops a group of one", () => {
		expect(groupBySameCleanedText([row(1, "Audible")])).toEqual([]);
	});

	it("never groups two rows that share a merchant but differ in cleaned text", () => {
		const groups = groupBySameCleanedText([
			row(1, "Kindle Unltd*TE3E10I7 WA 07/26", { merchantKey: "Amazon" }),
			row(2, "Audible", { merchantKey: "Amazon" }),
		]);

		expect(groups).toEqual([]);
	});

	it("never groups by merchant key alone, even when the keys are identical", () => {
		const groups = groupBySameCleanedText([
			row(1, "Kindle Unltd*TE3E10I7 WA 07/26", { merchantKey: "Amazon" }),
			row(2, "Audible", { merchantKey: "Amazon" }),
			row(3, "Audible", { merchantKey: "Amazon" }),
		]);

		expect(groups.map((g) => g.cleanedText)).toEqual(["audible"]);
		expect(groups[0]?.rows.map((r) => r.id)).toEqual([2, 3]);
	});

	it("never groups a row on a trip Jev calls mixed", () => {
		expect(
			groupBySameCleanedText([
				row(1, "Audible", { mixed: true }),
				row(2, "Audible"),
			]),
		).toEqual([]);
	});

	it("leaves a mixed row out of a larger group and keeps the rest", () => {
		const groups = groupBySameCleanedText([
			row(1, "Audible"),
			row(2, "Audible", { mixed: true }),
			row(3, "Audible"),
		]);

		expect(groups).toHaveLength(1);
		expect(groups[0]?.rows.map((r) => r.id)).toEqual([1, 3]);
	});

	it("never groups a row whose bank text cleans to nothing", () => {
		expect(
			groupBySameCleanedText([row(1, "POS DEBIT"), row(2, "POS DEBIT 09/30")]),
		).toEqual([]);
	});

	describe("a vague line (APPLE.COM/BILL)", () => {
		const note = "App Store, Oct";

		it("is listed as a vague text", () => {
			expect(VAGUE_TEXTS).toContain("apple.com/bill");
		});

		it("does not group Apple rows that have no note", () => {
			expect(
				groupBySameCleanedText([
					row(1, "APPLE.COM/BILL CA 09/30"),
					row(2, "POS DEBIT APPLE.COM/BILL"),
				]),
			).toEqual([]);
		});

		it("groups Apple rows with the same note, whatever their dates and prefixes", () => {
			const groups = groupBySameCleanedText([
				row(1, "APPLE.COM/BILL CA 09/30", { whatItWasNote: note }),
				row(2, "POS DEBIT APPLE.COM/BILL", { whatItWasNote: note }),
			]);

			expect(groups).toHaveLength(1);
			expect(groups[0]?.cleanedText).toBe("apple.com/bill");
			expect(groups[0]?.note).toBe(note);
			expect(groups[0]?.rows.map((r) => r.id)).toEqual([1, 2]);
		});

		it("treats a cleaned text that starts with the vague text and a space as vague too", () => {
			expect(
				groupBySameCleanedText([
					row(1, "APPLE.COM/BILL CUPERTINO CA"),
					row(2, "APPLE.COM/BILL CUPERTINO CA 09/30"),
				]),
			).toEqual([]);
		});

		it("groups Apple rows with a city suffix when they share the note", () => {
			const groups = groupBySameCleanedText([
				row(1, "APPLE.COM/BILL CUPERTINO CA", { whatItWasNote: note }),
				row(2, "APPLE.COM/BILL CUPERTINO CA 09/30", { whatItWasNote: note }),
			]);

			expect(groups).toHaveLength(1);
			expect(groups[0]?.cleanedText).toBe("apple.com/bill cupertino");
			expect(groups[0]?.rows.map((r) => r.id)).toEqual([1, 2]);
		});

		it("does not treat APPLE.COM/BILLING INC as vague, since there is no space after the vague text", () => {
			const groups = groupBySameCleanedText([
				row(1, "APPLE.COM/BILLING INC"),
				row(2, "APPLE.COM/BILLING INC 09/30"),
			]);

			expect(groups).toHaveLength(1);
			expect(groups[0]?.cleanedText).toBe("apple.com/billing inc");
			expect(groups[0]?.note).toBeNull();
		});

		it("does not group Apple rows whose notes differ", () => {
			expect(
				groupBySameCleanedText([
					row(1, "APPLE.COM/BILL CA 09/30", { whatItWasNote: "App Store" }),
					row(2, "POS DEBIT APPLE.COM/BILL", { whatItWasNote: "iCloud" }),
				]),
			).toEqual([]);
		});

		it("does not group a note-less Apple row with a row that has a note", () => {
			const groups = groupBySameCleanedText([
				row(1, "APPLE.COM/BILL CA 09/30", { whatItWasNote: note }),
				row(2, "POS DEBIT APPLE.COM/BILL"),
			]);

			expect(groups).toEqual([]);
		});

		it("treats a blank note as no note", () => {
			expect(
				groupBySameCleanedText([
					row(1, "APPLE.COM/BILL CA 09/30", { whatItWasNote: "   " }),
					row(2, "APPLE.COM/BILL CA 10/01", { whatItWasNote: "" }),
				]),
			).toEqual([]);
		});

		it("compares notes ignoring case and extra spaces", () => {
			const groups = groupBySameCleanedText([
				row(1, "APPLE.COM/BILL CA 09/30", { whatItWasNote: "App  Store" }),
				row(2, "APPLE.COM/BILL CA 10/01", { whatItWasNote: "app store " }),
			]);

			expect(groups).toHaveLength(1);
			expect(groups[0]?.rows.map((r) => r.id)).toEqual([1, 2]);
		});

		it("never groups a mixed Apple row, even with the same note", () => {
			expect(
				groupBySameCleanedText([
					row(1, "APPLE.COM/BILL CA 09/30", { whatItWasNote: note }),
					row(2, "POS DEBIT APPLE.COM/BILL", {
						whatItWasNote: note,
						mixed: true,
					}),
				]),
			).toEqual([]);
		});
	});

	it("keeps groups in the order their first row appears", () => {
		const groups = groupBySameCleanedText([
			row(1, "Netflix"),
			row(2, "Audible"),
			row(3, "NETFLIX 09/02"),
			row(4, "Audible CA 09/03"),
		]);

		expect(groups.map((g) => g.cleanedText)).toEqual(["netflix", "audible"]);
		expect(groups[0]?.rows.map((r) => r.id)).toEqual([1, 3]);
		expect(groups[1]?.rows.map((r) => r.id)).toEqual([2, 4]);
	});
});

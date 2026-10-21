import { describe, expect, it } from "vitest";
import type { AppleRow } from "../src/apple-card/csv";
import {
	importWords,
	leftOut,
	planImport,
	rowKey,
} from "../src/apple-card/plan";

// Made-up rows in Apple's layout, for the Rivera family.
const row = (over: Partial<AppleRow> = {}): AppleRow => ({
	line: 2,
	transactionDate: "2026-09-25",
	clearingDate: "2026-09-26",
	description: "PAT CAFE #12",
	merchant: "Pat Cafe",
	category: "Dining",
	type: "Purchase",
	amountCents: 1200,
	...over,
});

describe("planImport", () => {
	it("numbers twins: identical rows get 1 and 2, and a third identical row later in the file gets 3", () => {
		const twin = row();
		const other = row({ description: "OTHER SHOP", merchant: "Other Shop" });
		const plan = planImport(
			[twin, { ...twin, line: 3 }, other, { ...twin, line: 4 }],
			"2026-07-21",
		);
		expect(plan.add.map((item) => item.twin)).toEqual([1, 2, 1, 3]);
		expect(plan.add[0]?.key).toBe(plan.add[1]?.key);
		expect(plan.add[0]?.key).toBe(plan.add[3]?.key);
		expect(plan.add[2]?.key).not.toBe(plan.add[0]?.key);
	});

	it("skips a row that hasn't cleared: it's counted in notCleared, never in add", () => {
		const plan = planImport(
			[row({ clearingDate: null }), row({ line: 3 })],
			"2026-07-21",
		);
		expect(plan.notCleared).toBe(1);
		expect(plan.add).toHaveLength(1);
		expect(plan.add[0]?.row.line).toBe(3);
	});

	it("skips a row before Tally's history, and adds one on the history's first day", () => {
		const plan = planImport(
			[
				row({ clearingDate: "2026-07-20" }),
				row({ clearingDate: "2026-07-21", line: 3 }),
			],
			"2026-07-21",
		);
		expect(plan.beforeHistory).toBe(1);
		expect(plan.add.map((item) => item.row.clearingDate)).toEqual([
			"2026-07-21",
		]);
	});

	it("counts skipped rows out of the twin numbering", () => {
		const plan = planImport(
			[
				row({ clearingDate: null }),
				row({ clearingDate: "2026-07-20", line: 3 }),
				row({ line: 4 }),
			],
			"2026-07-21",
		);
		expect(plan.add[0]?.twin).toBe(1);
	});

	it("marks a Payment as left out, and nothing else", () => {
		const plan = planImport(
			[
				row({ type: "Payment", amountCents: -5000, description: "Payment" }),
				row({ line: 3 }),
			],
			"2026-07-21",
		);
		expect(plan.add.map((item) => item.excluded)).toEqual([true, false]);
	});
});

describe("planImport: rows Tally holds", () => {
	it("counts a held row cleared before the history start as held, not as before history", () => {
		const early = row({ clearingDate: "2026-07-20" });
		const held = new Map([[rowKey(early), new Set([1])]]);
		const plan = planImport([early], "2026-07-21", held);
		expect(plan.beforeHistory).toBe(0);
		expect(plan.add.map((item) => item.twin)).toEqual([1]);
	});

	it("still leaves out a before-history row Tally doesn't hold, and a twin beyond the held ones", () => {
		const early = row({ clearingDate: "2026-07-20" });
		const held = new Map([[rowKey(early), new Set([1])]]);
		const plan = planImport([early, { ...early, line: 3 }], "2026-07-21", held);
		expect(plan.beforeHistory).toBe(1);
		expect(plan.add.map((item) => item.twin)).toEqual([1]);
	});
});

describe("leftOut (decision 144)", () => {
	it("leaves out a Payment", () => {
		expect(
			leftOut(row({ type: "Payment", amountCents: -5000, description: "Pay" })),
		).toBe(true);
	});

	it("leaves out an Other row that money went out on and whose Description says REVERSAL, in any case", () => {
		for (const description of [
			"ACH DEPOSIT (REVERSAL - INSUFFICIENT FUNDS)",
			"ach deposit (reversal - insufficient funds)",
			"Reversal of payment",
		]) {
			expect(
				leftOut(row({ type: "Other", amountCents: 5000, description })),
			).toBe(true);
		}
	});

	it("keeps an Other row whose Description says REVERSAL when money came in: a refund counts by its sign", () => {
		expect(
			leftOut(
				row({
					type: "Other",
					amountCents: -5000,
					description: "PURCHASE (REVERSAL)",
				}),
			),
		).toBe(false);
	});

	it("keeps an Other row without REVERSAL in its Description", () => {
		expect(
			leftOut(row({ type: "Other", amountCents: 5000, description: "FEE" })),
		).toBe(false);
	});

	it("keeps a Purchase whose Description says REVERSAL", () => {
		expect(
			leftOut(
				row({
					type: "Purchase",
					amountCents: 5000,
					description: "STORE REVERSAL",
				}),
			),
		).toBe(false);
	});

	it("keeps a money-in refund whose Type is some other word, even with REVERSAL in its Description", () => {
		expect(
			leftOut(
				row({
					type: "Refund",
					amountCents: -5000,
					description: "REVERSAL OF CHARGE",
				}),
			),
		).toBe(false);
	});
});

describe("rowKey", () => {
	it("pins the stored key for a fixture row (a changed key would re-key held rows and double them)", () => {
		expect(
			rowKey(
				row({
					transactionDate: "2026-09-25",
					clearingDate: "2026-09-26",
					description: "PAT CAFE #12",
					type: "Purchase",
					amountCents: 1200,
				}),
			),
		).toBe('["2026-09-25","2026-09-26","PAT CAFE #12","Purchase",1200]');
	});

	it("reads decomposed and composed text, and padded text, as one key", () => {
		const composed = row({ description: "CAFÉ", type: "Purchase" });
		const decomposed = row({ description: "CAFÉ", type: " Purchase " });
		expect(rowKey(decomposed)).toBe(rowKey(composed));
	});
});

describe("importWords, with exact strings", () => {
	const none = { added: 0, already: 0, notCleared: 0, beforeHistory: 0 };
	const today = "2026-09-22";
	const start = "2026-07-21";

	it.each([
		[
			{ ...none, added: 34, already: 6 },
			"Added 34 from Apple Card. 6 were already in Tally.",
		],
		[
			{ ...none, added: 1, already: 1 },
			"Added 1 from Apple Card. 1 was already in Tally.",
		],
		[{ ...none, added: 34 }, "Added 34 from Apple Card."],
		[{ ...none, already: 40 }, "Nothing new. All 40 were already in Tally."],
		[{ ...none, already: 1 }, "Nothing new. 1 was already in Tally."],
		[none, "Nothing new."],
		[{ ...none, notCleared: 2 }, "Nothing new. 2 haven't cleared yet."],
		[{ ...none, notCleared: 1 }, "Nothing new. 1 hasn't cleared yet."],
		[
			{ ...none, added: 34, notCleared: 2 },
			"Added 34 from Apple Card. 2 haven't cleared yet.",
		],
		[
			{ ...none, beforeHistory: 12 },
			"Nothing new. 12 were from before Jul 21, when Tally's history starts.",
		],
		[
			{ ...none, beforeHistory: 1 },
			"Nothing new. 1 was from before Jul 21, when Tally's history starts.",
		],
	])("%j reads as the table says", (counts, words) => {
		expect(importWords(counts, start, today)).toBe(words);
	});

	it("adds the year to a history start that isn't this year's", () => {
		expect(
			importWords({ ...none, beforeHistory: 3 }, "2025-12-31", today),
		).toBe(
			"Nothing new. 3 were from before Dec 31, 2025, when Tally's history starts.",
		);
	});
});

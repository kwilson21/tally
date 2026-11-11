import { describe, expect, it } from "vitest";
import type { BillStatus } from "../src/bills/status";
import { occurrenceKey, setAsideFor } from "../src/bills/totals";

// What Safe to spend sets aside for bills (decision 123, #942): the unpaid part of each distinct due or overdue
// occurrence of an active bill that is due this month, each counted once, the first one given winning a tie.

const MONTH = "2026-10";
const occ = (
	billId: number,
	dueDate: string,
	status: BillStatus,
	amountCents: number,
	paidCents = 0,
) => ({ billId, dueDate, status, amountCents, paidCents });
const active = new Set([1, 2, 3]);

describe("setAsideFor", () => {
	it("is zero with no occurrences", () => {
		expect(setAsideFor([], active, MONTH)).toBe(0);
	});

	it("adds the unpaid part of each due or overdue occurrence due this month", () => {
		expect(
			setAsideFor(
				[
					occ(1, "2026-10-05", "overdue", 10000),
					occ(2, "2026-10-20", "due", 6000, 2500),
				],
				active,
				MONTH,
			),
		).toBe(13500);
	});

	it("never sets aside less than zero for an occurrence paid past its amount", () => {
		expect(
			setAsideFor(
				[
					occ(1, "2026-10-05", "due", 5000, 7000),
					occ(2, "2026-10-06", "due", 300),
				],
				active,
				MONTH,
			),
		).toBe(300);
	});

	it("skips paid and upcoming occurrences", () => {
		expect(
			setAsideFor(
				[
					occ(1, "2026-10-05", "paid", 10000, 10000),
					occ(2, "2026-10-28", "upcoming", 6000),
				],
				active,
				MONTH,
			),
		).toBe(0);
	});

	it("skips an occurrence due in another month", () => {
		expect(
			setAsideFor(
				[
					occ(1, "2026-11-01", "due", 10000),
					occ(2, "2026-09-30", "overdue", 400),
				],
				active,
				MONTH,
			),
		).toBe(0);
	});

	it("skips an inactive bill's occurrence", () => {
		expect(
			setAsideFor(
				[occ(9, "2026-10-05", "due", 10000), occ(1, "2026-10-05", "due", 200)],
				active,
				MONTH,
			),
		).toBe(200);
	});

	it("counts an occurrence given twice once, the first one winning", () => {
		expect(
			setAsideFor(
				[
					occ(1, "2026-10-05", "due", 10000, 4000),
					occ(1, "2026-10-05", "due", 10000),
					occ(1, "2026-10-12", "due", 10000),
				],
				active,
				MONTH,
			),
		).toBe(16000);
		// The first one wins even when it counts for nothing: a paid shown occurrence hides its unpaid twin.
		expect(
			setAsideFor(
				[
					occ(1, "2026-10-05", "paid", 10000, 10000),
					occ(1, "2026-10-05", "due", 10000),
				],
				active,
				MONTH,
			),
		).toBe(0);
	});
});

describe("occurrenceKey", () => {
	it("names one bill's one due date, so two occurrences share a key only when both match", () => {
		expect(occurrenceKey(1, "2026-10-05")).toBe(occurrenceKey(1, "2026-10-05"));
		expect(occurrenceKey(1, "2026-10-05")).not.toBe(
			occurrenceKey(2, "2026-10-05"),
		);
		expect(occurrenceKey(1, "2026-10-05")).not.toBe(
			occurrenceKey(1, "2026-10-06"),
		);
		expect(occurrenceKey(1, "12026-10-05")).not.toBe(
			occurrenceKey(11, "2026-10-05"),
		);
	});
});

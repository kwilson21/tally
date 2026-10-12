import { describe, expect, it } from "vitest";
import {
	NO_SELECTION,
	type Selection,
	selectedIds,
	setIds,
	settle,
} from "../src/transactions/selection";

/** An all-mode selection, with the fields a test doesn't name left empty. */
const whole = (partial: Partial<Selection>): Selection => ({
	ticks: [],
	held: [],
	all: true,
	unticked: [],
	...partial,
});

describe("settle (#321, #350)", () => {
	it("in all mode, moves a tick the filters match into held", () => {
		expect(settle(whole({ ticks: [1, 2] }), new Set([1]))).toEqual({
			ticks: [2],
			held: [1],
			all: true,
			unticked: [],
		});
	});

	it("in all mode, moves a held id the filters no longer match back to ticks", () => {
		expect(settle(whole({ held: [1, 3] }), new Set([3]))).toEqual({
			ticks: [1],
			held: [3],
			all: true,
			unticked: [],
		});
	});

	it("drops an id in unticked from both ticks and held, since unticking ends a tick", () => {
		expect(
			settle(
				whole({ ticks: [1, 4, 5], held: [2], unticked: [1, 2, 5] }),
				new Set([1, 2, 3]),
			),
		).toEqual({
			ticks: [4],
			held: [],
			all: true,
			unticked: [1, 2, 5],
		});
	});

	it("in ticked mode, folds held back into ticks, each id once", () => {
		expect(
			settle(
				{ ticks: [1, 2], held: [2, 3], all: false, unticked: [] },
				new Set([9]),
			),
		).toEqual({ ticks: [1, 2, 3], held: [], all: false, unticked: [] });
	});

	it("is idempotent", () => {
		const cases: [Selection, Set<number>][] = [
			[whole({ ticks: [1, 2, 9], held: [3] }), new Set([1, 3, 4])],
			[whole({ ticks: [5], held: [6], unticked: [6] }), new Set([6])],
			[{ ...NO_SELECTION, ticks: [7], held: [8] }, new Set([8])],
		];
		for (const [selection, matched] of cases) {
			const once = settle(selection, matched);
			expect(settle(once, matched)).toEqual(once);
		}
	});
});

describe("setIds (#321)", () => {
	it("in all mode, returns the matched rows less the unticked, held ticks included, and leaves out off-filter ticks", () => {
		const settled = settle(
			whole({ ticks: [9], held: [2], unticked: [1] }),
			new Set([1, 2, 3]),
		);
		expect(setIds(settled, [1, 2, 3])).toEqual([2, 3]);
	});

	it("outside all mode, returns nothing, whatever the ticks", () => {
		expect(setIds(NO_SELECTION, [1, 2])).toEqual([]);
		expect(setIds({ ...NO_SELECTION, ticks: [4, 5] }, [1, 2])).toEqual([]);
	});
});

describe("selectedIds", () => {
	it("counts each id once: the matched rows less the unticked, then the ticks", () => {
		const settled = settle(
			whole({ ticks: [9], held: [2], unticked: [1] }),
			new Set([1, 2, 3]),
		);
		expect(selectedIds(settled, [1, 2, 3])).toEqual([2, 3, 9]);
	});

	it("does not count a held id twice", () => {
		const settled = settle(whole({ held: [2] }), new Set([1, 2]));
		expect(selectedIds(settled, [1, 2])).toEqual([1, 2]);
	});

	it("returns the ticks outside all mode", () => {
		expect(selectedIds(NO_SELECTION, [1, 2])).toEqual([]);
		expect(selectedIds({ ...NO_SELECTION, ticks: [4, 5] }, [1, 2])).toEqual([
			4, 5,
		]);
	});
});

import { describe, expect, it } from "vitest";
import {
	MAX_SPLIT_CENTS,
	MAX_SPLIT_PARTS,
	parseSplit,
	partsAddUp,
	splitStatus,
} from "../src/transactions/split";

describe("split validation", () => {
	it("requires two categorized positive parts that exactly equal a purchase", () => {
		expect(parseSplit(["1"], ["10.00"], 1000, [1])).toMatchObject({
			ok: false,
		});
		expect(parseSplit(["1", ""], ["5.00", "5.00"], 1000, [1])).toMatchObject({
			ok: false,
		});
		expect(parseSplit(["1", "1"], ["5.00", "0"], 1000, [1])).toMatchObject({
			ok: false,
		});
		expect(parseSplit(["1", "1"], ["5.00", "4.99"], 1000, [1])).toMatchObject({
			ok: false,
		});
		expect(parseSplit(["1", "1"], ["5.00", "5.00"], 1000, [1])).toEqual({
			ok: true,
			parts: [
				{ categoryId: 1, amountCents: 500 },
				{ categoryId: 1, amountCents: 500 },
			],
		});
	});

	it("applies a refund parent's sign to its positive part amounts", () => {
		expect(
			parseSplit(["1", "2"], ["4.00", "6.00"], -1000, [1, 2]),
		).toMatchObject({
			ok: true,
			parts: [{ amountCents: -400 }, { amountCents: -600 }],
		});
	});
});

const part = (amountCents: number) => ({ categoryId: 1, amountCents });

describe("partsAddUp", () => {
	it("accepts two or more parts that add up exactly, with the transaction's sign", () => {
		expect(partsAddUp([part(500), part(500)], 1000)).toBe(true);
		expect(partsAddUp([part(1), part(2), part(3)], 6)).toBe(true);
		expect(partsAddUp([part(-400), part(-600)], -1000)).toBe(true);
	});

	it("refuses fewer than two parts", () => {
		expect(partsAddUp([], 0)).toBe(false);
		expect(partsAddUp([part(1000)], 1000)).toBe(false);
	});

	it("refuses parts that do not add up", () => {
		expect(partsAddUp([part(500), part(499)], 1000)).toBe(false);
		expect(partsAddUp([part(500), part(501)], 1000)).toBe(false);
	});

	it("refuses a zero part, even when the rest add up", () => {
		expect(partsAddUp([part(1000), part(0)], 1000)).toBe(false);
		expect(partsAddUp([part(0), part(0)], 0)).toBe(false);
	});

	it("refuses a part with the wrong sign, even when they add up", () => {
		expect(partsAddUp([part(1500), part(-500)], 1000)).toBe(false);
		expect(partsAddUp([part(500), part(500)], -1000)).toBe(false);
		expect(partsAddUp([part(-500), part(-500)], 1000)).toBe(false);
	});

	it("adds exactly at the limits", () => {
		const parts = Array.from({ length: MAX_SPLIT_PARTS }, () =>
			part(MAX_SPLIT_CENTS),
		);
		expect(partsAddUp(parts, MAX_SPLIT_PARTS * MAX_SPLIT_CENTS)).toBe(true);
		expect(partsAddUp(parts, MAX_SPLIT_PARTS * MAX_SPLIT_CENTS - 1)).toBe(
			false,
		);
	});
});

describe("split limits", () => {
	it("refuses a part above what can be added exactly, in words", () => {
		const over = ((MAX_SPLIT_CENTS + 1) / 100).toFixed(2);
		expect(
			parseSplit(["1", "1"], [over, "1.00"], MAX_SPLIT_CENTS + 101, [1]),
		).toEqual({
			ok: false,
			error: "Enter an amount of $100,000,000 or less for part 1.",
		});
	});

	it("accepts a part exactly at the limit", () => {
		const at = (MAX_SPLIT_CENTS / 100).toFixed(2);
		expect(
			parseSplit(["1", "1"], [at, "1.00"], MAX_SPLIT_CENTS + 100, [1]),
		).toMatchObject({ ok: true });
	});

	it("refuses more parts than can be added exactly", () => {
		const many = Array.from({ length: MAX_SPLIT_PARTS + 1 }, () => "1");
		expect(
			parseSplit(
				many,
				many.map(() => "0.01"),
				MAX_SPLIT_PARTS + 1,
				[1],
			),
		).toEqual({
			ok: false,
			error: `Use at most ${MAX_SPLIT_PARTS} parts.`,
		});
	});
});

describe("split status", () => {
	it("uses words as well as the check icon state", () => {
		// The live amount is its own part, in tabular figures; the words around it stay in normal ones (#676, decision 128).
		const left = splitStatus(1000, ["4.00", ""]);
		expect(left).toEqual({
			kind: "left",
			cents: 600,
			before: "",
			figures: "$6.00",
			after: " left to assign",
		});
		expect(left.before + left.figures + left.after).toBe(
			"$6.00 left to assign",
		);
		const over = splitStatus(1000, ["7", "4"]);
		expect(over).toEqual({
			kind: "over",
			cents: 100,
			before: "",
			figures: "$1.00",
			after: " over",
		});
		expect(over.before + over.figures + over.after).toBe("$1.00 over");
		const done = splitStatus(-1000, ["4", "6"]);
		expect(done).toEqual({
			kind: "done",
			cents: 1000,
			before: "Adds up to ",
			figures: "$10.00",
			after: "",
		});
		expect(done.before + done.figures + done.after).toBe("Adds up to $10.00");
	});
});

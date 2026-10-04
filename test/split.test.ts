import { describe, expect, it } from "vitest";
import { parseSplit, splitStatus } from "../src/transactions/split";

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

describe("split status", () => {
	it("uses words as well as the check icon state", () => {
		expect(splitStatus(1000, ["4.00", ""])).toEqual({
			kind: "left",
			cents: 600,
			text: "$6.00 left to assign",
		});
		expect(splitStatus(1000, ["7", "4"])).toEqual({
			kind: "over",
			cents: 100,
			text: "$1.00 over",
		});
		expect(splitStatus(-1000, ["4", "6"])).toEqual({
			kind: "done",
			cents: 1000,
			text: "Adds up to $10.00",
		});
	});
});

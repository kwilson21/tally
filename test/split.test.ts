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

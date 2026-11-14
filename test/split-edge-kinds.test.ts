import { describe, expect, it } from "vitest";
import { readAtEdge } from "../src/edge";
import { PartIdText, SafeCentsText, SheetToken } from "../src/edge-kinds";

// The three kinds the split routes read with (#1006, PR 11): each accepts exactly what the route's own check accepted
// before the edge, and refuses the rest.

const LOWER = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";

describe("SafeCentsText: a split sheet's whole cents", () => {
	it.each(["1", "9", "10000", "1000000000000000", "9007199254740991"])(
		"accepts %s",
		(text) => {
			expect(readAtEdge(SafeCentsText, text)).toEqual({
				ok: true,
				value: Number(text),
			});
		},
	);

	it.each([
		"0",
		"007",
		"1e3",
		" 5",
		"5 ",
		"+5",
		"-5",
		"1,000",
		"1.5",
		"9007199254740992",
		"12345678901234567890",
		`1${"0".repeat(400)}`,
		"",
		"abc",
	])("refuses %j", (text) => {
		expect(readAtEdge(SafeCentsText, text).ok).toBe(false);
	});
});

describe("PartIdText: a saved split part's id", () => {
	it("accepts digits with no leading zero, and a long one as the float it always was", () => {
		expect(readAtEdge(PartIdText, "42")).toEqual({ ok: true, value: 42 });
		expect(readAtEdge(PartIdText, "12345678901234567890")).toEqual({
			ok: true,
			value: 12345678901234567000,
		});
	});

	it.each(["0", "007", "1e3", " 7", "-5", "1.5", "", "abc"])(
		"refuses %j",
		(text) => {
			expect(readAtEdge(PartIdText, text).ok).toBe(false);
		},
	);
});

describe("SheetToken: the split sheet's token, lower case only", () => {
	it("accepts 36 lower-case hex digits and dashes", () => {
		expect(readAtEdge(SheetToken, LOWER)).toEqual({ ok: true, value: LOWER });
	});

	it.each([
		LOWER.toUpperCase(),
		LOWER.slice(1),
		`${LOWER}7`,
		`${LOWER}\n`,
		`${LOWER.slice(0, 35)}g`,
		"",
		undefined,
	])("refuses %j", (text) => {
		expect(readAtEdge(SheetToken, text).ok).toBe(false);
	});
});

import { describe, expect, it } from "vitest";
// The browser script's pure parts: integer cents in, the field's text out.
import {
	capDecimals,
	fieldCents,
	nudged,
	roundedUp,
	showCents,
} from "../public/js/money.js";

describe("fieldCents (the field's text → cents, or null)", () => {
	it.each([
		["612.40", 61240],
		["612.4", 61240],
		["0.05", 5],
		["612", 61200],
		["$1,234.56", 123456],
		["0", 0],
		["", 0],
		["  7.05 ", 705],
	])("%j → %i", (text, cents) => {
		expect(fieldCents(text)).toBe(cents);
	});

	it("gives null for anything else, so the buttons leave it alone", () => {
		expect(fieldCents("abc")).toBeNull();
		expect(fieldCents("1.2.3")).toBeNull();
		expect(fieldCents("-5")).toBeNull();
		// The same format the server saves: digits before the point, one or two after it.
		expect(fieldCents(".5")).toBeNull();
		expect(fieldCents("12.")).toBeNull();
		expect(fieldCents("$")).toBeNull();
	});
});

describe("showCents (cents → the field's text, always with cents, as in the original)", () => {
	it.each([
		[61240, "612.40"],
		[61200, "612.00"],
		[5, "0.05"],
		[0, "0.00"],
	])("%i → %j", (cents, text) => {
		expect(showCents(cents)).toBe(text);
	});
});

describe("nudged", () => {
	it("adds or takes away cents and dollars exactly", () => {
		expect(nudged("612.40", 1)).toBe("612.41");
		expect(nudged("612.40", -1)).toBe("612.39");
		expect(nudged("612.40", 100)).toBe("613.40");
		expect(nudged("0.10", -1)).toBe("0.09");
		// 0.1 + 0.2 style float errors can't happen: it's all integer cents.
		expect(nudged("0.29", 1)).toBe("0.30");
	});

	it("never goes below $0", () => {
		expect(nudged("0.50", -100)).toBe("0.00");
		expect(nudged("0", -1)).toBe("0.00");
	});

	it("starts from $0 when the field is empty", () => {
		expect(nudged("", 100)).toBe("1.00");
	});

	it("leaves text it can't read alone", () => {
		expect(nudged("abc", 100)).toBe("abc");
	});
});

describe("roundedUp", () => {
	it("goes up to the next whole dollar when there are cents", () => {
		expect(roundedUp("250.01")).toBe("251.00");
		expect(roundedUp("612.40")).toBe("613.00");
	});

	it("is null when there's nothing to round", () => {
		expect(roundedUp("250")).toBeNull();
		expect(roundedUp("0")).toBeNull();
		expect(roundedUp("abc")).toBeNull();
	});
});

describe("capDecimals", () => {
	it("stops typing at two decimals", () => {
		expect(capDecimals("12.345")).toBe("12.34");
		expect(capDecimals("12.3")).toBe("12.3");
		expect(capDecimals("1234")).toBe("1234");
	});
});

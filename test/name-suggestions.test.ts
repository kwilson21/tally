import { describe, expect, it } from "vitest";
import {
	MAX_SUGGESTED_NAMES,
	parseSuggestedNames,
	shownName,
	storeSuggestedNames,
	usableSuggestedNames,
} from "../src/transactions/name-suggestions";

// A merchant's suggested names (spec §5, §7, decision 64): up to three, kept one per line in
// `merchants.suggested_name`, and shown only while the suggestion is pending.

describe("parseSuggestedNames and storeSuggestedNames", () => {
	it("round-trips up to three names, one per line", () => {
		const stored = storeSuggestedNames(["Blue Bottle Coffee", "Blue Bottle"]);
		expect(stored).toBe("Blue Bottle Coffee\nBlue Bottle");
		expect(parseSuggestedNames(stored)).toEqual([
			"Blue Bottle Coffee",
			"Blue Bottle",
		]);
	});

	it("reads a single plain name", () => {
		expect(parseSuggestedNames("Comcast")).toEqual(["Comcast"]);
	});

	it("reads nothing, an empty value ('asked, nothing useful') and blank lines as no names", () => {
		expect(parseSuggestedNames(null)).toEqual([]);
		expect(parseSuggestedNames(undefined)).toEqual([]);
		expect(parseSuggestedNames("")).toEqual([]);
		expect(parseSuggestedNames("\n \n")).toEqual([]);
	});

	it("keeps no more than three", () => {
		expect(MAX_SUGGESTED_NAMES).toBe(3);
		expect(storeSuggestedNames(["a1", "b2", "c3", "d4"])).toBe("a1\nb2\nc3");
		expect(parseSuggestedNames("a1\nb2\nc3\nd4")).toEqual(["a1", "b2", "c3"]);
	});
});

describe("usableSuggestedNames", () => {
	const base = {
		stored: "Blue Bottle Coffee\nBlue Bottle",
		status: "pending",
		namesOn: true,
	};

	it("offers a pending merchant's names", () => {
		expect(usableSuggestedNames(base)).toEqual([
			"Blue Bottle Coffee",
			"Blue Bottle",
		]);
	});

	it("offers nothing once a person has decided, or when nothing was suggested", () => {
		for (const status of ["none", "accepted", "rejected"])
			expect(usableSuggestedNames({ ...base, status })).toEqual([]);
		expect(usableSuggestedNames({ ...base, stored: null })).toEqual([]);
		expect(usableSuggestedNames({ ...base, status: null })).toEqual([]);
	});

	it("with the names switch off, offers nothing, and offers the names again when it is back on", () => {
		expect(usableSuggestedNames({ ...base, namesOn: false })).toEqual([]);
		expect(usableSuggestedNames({ ...base, namesOn: true })).toEqual([
			"Blue Bottle Coffee",
			"Blue Bottle",
		]);
	});
});

describe("shownName", () => {
	const raw = "SQ *BLUE BOTTLE COF 0412";
	const input = {
		chosen: null,
		stored: "Blue Bottle Coffee\nBlue Bottle",
		status: "pending",
		rawName: raw,
		namesOn: true,
	};

	it("a person's chosen name always wins", () => {
		expect(shownName({ ...input, chosen: "The Bottle" })).toEqual({
			name: "The Bottle",
			suggested: false,
		});
	});

	it("shows the first suggestion, marked as only suggested, until a person chooses", () => {
		expect(shownName(input)).toEqual({
			name: "Blue Bottle Coffee",
			suggested: true,
		});
	});

	it("falls back to the tidied bank text with no suggestion, a decided one, or the switch off", () => {
		const tidied = { name: "Blue bottle cof", suggested: false };
		expect(shownName({ ...input, stored: null })).toEqual(tidied);
		expect(shownName({ ...input, status: "rejected" })).toEqual(tidied);
		expect(shownName({ ...input, status: "accepted" })).toEqual(tidied);
		expect(shownName({ ...input, namesOn: false })).toEqual(tidied);
	});

	it("is not a suggestion when it says what the tidied text already says", () => {
		expect(
			shownName({
				...input,
				rawName: "NETFLIX.COM",
				stored: "Netflix.com\nNetflix",
			}),
		).toEqual({ name: "Netflix", suggested: true });
		expect(
			shownName({
				...input,
				rawName: "NETFLIX",
				stored: "Netflix",
			}),
		).toEqual({ name: "Netflix", suggested: false });
	});
});

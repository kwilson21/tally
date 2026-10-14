import { describe, expect, it } from "vitest";
import {
	isBankName,
	MAX_SUGGESTED_NAMES,
	nameSource,
	offeredNames,
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

	it("reads a single plain name, which is how Plaid's name is stored", () => {
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

describe("where a name came from (P87 B)", () => {
	it("is the bank's when it is the merchant's key, since Plaid's name is the key and Workers AI is never asked about a bank text Plaid named", () => {
		expect(isBankName("Blue Bottle Coffee", "Blue Bottle Coffee")).toBe(true);
		expect(isBankName("Blue Bottle Coffee", "SQ *BLUE BOTTLE COF 0412")).toBe(
			false,
		);
	});

	it("reads as the bank's only when every offered name is the key, and as Tally's guess otherwise", () => {
		expect(nameSource(["Comcast"], "Comcast")).toBe("bank");
		expect(nameSource(["Blue Bottle Coffee", "Blue Bottle"], "SQ *BLUE")).toBe(
			"tally",
		);
		expect(nameSource([], "Comcast")).toBe("tally");
	});
});

describe("usableSuggestedNames", () => {
	const KEY = "SQ *BLUE BOTTLE COF 0412";
	const base = {
		stored: "Blue Bottle Coffee\nBlue Bottle",
		status: "pending",
		key: KEY,
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

	it("with the names switch off, hides Tally's guesses but still offers the bank's own name (decision 80)", () => {
		expect(usableSuggestedNames({ ...base, namesOn: false })).toEqual([]);
		expect(
			usableSuggestedNames({
				stored: "Blue Bottle Coffee",
				status: "pending",
				key: "Blue Bottle Coffee",
				namesOn: false,
			}),
		).toEqual(["Blue Bottle Coffee"]);
		// Switched back on, the guesses are offered again, since they were kept.
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
		key: raw,
		rawName: raw,
		namesOn: true,
	};

	it("a person's chosen name always wins", () => {
		expect(shownName({ ...input, chosen: "The Bottle" })).toEqual({
			name: "The Bottle",
			suggested: false,
			fromBank: false,
		});
	});

	it("shows the first suggestion, marked as only suggested, until a person chooses", () => {
		expect(shownName(input)).toEqual({
			name: "Blue Bottle Coffee",
			suggested: true,
			fromBank: false,
		});
	});

	it("falls back to the tidied bank text with no suggestion, a decided one, or the switch off", () => {
		const tidied = {
			name: "Blue bottle cof",
			suggested: false,
			fromBank: false,
		};
		expect(shownName({ ...input, stored: null })).toEqual(tidied);
		expect(shownName({ ...input, status: "rejected" })).toEqual(tidied);
		expect(shownName({ ...input, status: "accepted" })).toEqual(tidied);
		expect(shownName({ ...input, namesOn: false })).toEqual(tidied);
	});

	it("marks the bank's name as the bank's, and shows it as a suggestion even with the switch off", () => {
		const bank = {
			...input,
			key: "Blue Bottle Coffee",
			stored: "Blue Bottle Coffee",
		};
		expect(shownName(bank)).toEqual({
			name: "Blue Bottle Coffee",
			suggested: true,
			fromBank: true,
		});
		expect(shownName({ ...bank, namesOn: false })).toEqual({
			name: "Blue Bottle Coffee",
			suggested: true,
			fromBank: true,
		});
	});

	it("is not a suggestion when it says what the tidied text already says", () => {
		expect(
			shownName({
				...input,
				rawName: "NETFLIX.COM",
				key: "NETFLIX.COM",
				stored: "Netflix.com\nNetflix",
			}),
		).toEqual({ name: "Netflix", suggested: true, fromBank: false });
		expect(
			shownName({
				...input,
				rawName: "NETFLIX",
				key: "NETFLIX",
				stored: "Netflix",
			}),
		).toEqual({ name: "Netflix", suggested: false, fromBank: false });
	});

	it("does not offer a Tally guess that only recapitalizes the shown text", () => {
		const guess = {
			stored: "blue BOTTLE cof",
			status: "pending",
			key: raw,
			namesOn: true,
		};
		expect(offeredNames(guess, raw)).toEqual([]);
		expect(shownName({ ...input, ...guess })).toEqual({
			name: "Blue bottle cof",
			suggested: false,
			fromBank: false,
		});
	});

	it("keeps the bank's own name offered when it only recapitalizes the shown text (P87 B)", () => {
		const bank = {
			stored: "Blue Bottle Cof",
			status: "pending",
			key: "Blue Bottle Cof",
			namesOn: true,
		};
		expect(offeredNames(bank, raw)).toEqual(["Blue Bottle Cof"]);
		expect(shownName({ ...input, ...bank })).toEqual({
			name: "Blue Bottle Cof",
			suggested: true,
			fromBank: true,
		});
	});
});

// A Tally guess that differs from the shown text only in punctuation, spacing or capitals repeats it, so it is not
// offered; the bank's own name is kept, as it is for capitals (P87 B) (#412).
describe("a Tally guess that differs from the shown text only by punctuation, spacing or capitals (#412)", () => {
	it.each([
		["AT&T", "AT&T", "ATT"],
		["TRADER JOE'S #552", "Trader joe's", "Trader Joes"],
		["BLUE BOTTLE COF", "Blue bottle cof", "Blue-Bottle Cof"],
		["7-ELEVEN", "7-eleven", "7 Eleven"],
	])(
		"is not offered beside %j (shown as %j) when the guess is %j",
		(raw, tidied, guess) => {
			const merchant = {
				stored: guess,
				status: "pending",
				key: raw,
				namesOn: true,
			};
			expect(offeredNames(merchant, raw)).toEqual([]);
			expect(shownName({ ...merchant, chosen: null, rawName: raw })).toEqual({
				name: tidied,
				suggested: false,
				fromBank: false,
			});
		},
	);

	it("still offers a Tally guess that says a different word", () => {
		const merchant = {
			stored: "Trader Joe's Market\nTrader Joes",
			status: "pending",
			key: "TRADER JOE'S #552",
			namesOn: true,
		};
		expect(offeredNames(merchant, "TRADER JOE'S #552")).toEqual([
			"Trader Joe's Market",
		]);
	});

	it("still offers a Tally guess with different digits, since Motel 8 is not Motel 6", () => {
		const merchant = {
			stored: "Motel 8",
			status: "pending",
			key: "MOTEL 6",
			namesOn: true,
		};
		expect(offeredNames(merchant, "MOTEL 6")).toEqual(["Motel 8"]);
		expect(
			shownName({ ...merchant, chosen: null, rawName: "MOTEL 6" }),
		).toEqual({
			name: "Motel 8",
			suggested: true,
			fromBank: false,
		});
	});

	it("keeps the bank's own name offered when it only differs by punctuation (P87 B)", () => {
		const bank = {
			stored: "ATT",
			status: "pending",
			key: "ATT",
			namesOn: true,
		};
		expect(offeredNames(bank, "AT&T")).toEqual(["ATT"]);
		expect(shownName({ ...bank, chosen: null, rawName: "AT&T" })).toEqual({
			name: "ATT",
			suggested: true,
			fromBank: true,
		});
	});
});

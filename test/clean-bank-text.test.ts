import { describe, expect, it } from "vitest";
import { cleanBankText } from "../src/clean-bank-text";

// The bank's text for a purchase, cleaned so two purchases from one place read the same. It is never the
// store's display name, and it is lowercase (decision 156). Dates, state codes, reference IDs and "POS DEBIT"
// prefixes go; a trailing city does not (it can't be told from the end of a store name).

describe("cleanBankText", () => {
	it("strips the date and the state code from an Apple line", () => {
		expect(cleanBankText("APPLE.COM/BILL CA 09/30")).toBe("apple.com/bill");
	});

	it("reads an Apple line with a POS DEBIT prefix the same as one without", () => {
		expect(cleanBankText("POS DEBIT APPLE.COM/BILL")).toBe("apple.com/bill");
		expect(cleanBankText("POS DEBIT APPLE.COM/BILL")).toBe(
			cleanBankText("APPLE.COM/BILL CA 09/30"),
		);
	});

	it("removes the reference ID after * and the state code, keeping the store's name", () => {
		expect(cleanBankText("Kindle Unltd*TE3E10I7 WA 07/26")).toBe(
			"kindle unltd",
		);
	});

	it("leaves a plain store name as it is, in lowercase", () => {
		expect(cleanBankText("Audible")).toBe("audible");
		expect(cleanBankText("AUDIBLE")).toBe("audible");
	});

	it("keeps a city after the store name, and strips only the state code", () => {
		expect(cleanBankText("Museum of the Bible Washington DC 08/04")).toBe(
			"museum of the bible washington",
		);
	});

	it("strips a single-digit month and day", () => {
		expect(cleanBankText("APPLE.COM/BILL CA 9/3")).toBe("apple.com/bill");
	});

	it("strips a POS DEBIT, POS CREDIT or POS PURCHASE prefix, any case", () => {
		expect(cleanBankText("POS CREDIT TARGET")).toBe("target");
		expect(cleanBankText("pos purchase target")).toBe("target");
		expect(cleanBankText("CHECKCARD TARGET")).toBe("target");
	});

	it("strips a CHECKCARD or POS terminal code, which varies by purchase", () => {
		expect(cleanBankText("CHECKCARD 0921 CVS")).toBe("cvs");
		expect(cleanBankText("POS 4417 CITY PARKING")).toBe("city parking");
	});

	it("reads two purchases at one store the same, whatever their terminal codes", () => {
		expect(cleanBankText("CHECKCARD 0921 CVS")).toBe(
			cleanBankText("CHECKCARD 1137 CVS 09/30"),
		);
	});

	it("strips a terminal code only when it has three or more digits", () => {
		expect(cleanBankText("CHECKCARD 76 GAS")).toBe("76 gas");
		expect(cleanBankText("POS 24 HOUR FITNESS")).toBe("24 hour fitness");
		expect(cleanBankText("POS 7 ELEVEN")).toBe("7 eleven");
	});

	it("strips a terminal code after DEBIT CARD PURCHASE too", () => {
		expect(cleanBankText("DEBIT CARD PURCHASE 0921 CVS")).toBe("cvs");
	});

	it("strips a trailing processor code of three or more digits, so one merchant groups", () => {
		expect(cleanBankText("SQ *BLUE BOTTLE COF 0412")).toBe("blue bottle cof");
		expect(cleanBankText("SQ *BLUE BOTTLE COF 0217")).toBe("blue bottle cof");
	});

	it("keeps a short number that is part of a processor merchant's name", () => {
		expect(cleanBankText("SQ *CAFE 22")).toBe("cafe 22");
		expect(cleanBankText("SQ *7ELEVEN")).toBe("7eleven");
		expect(cleanBankText("SQ *24HOURFITNESS")).toBe("24hourfitness");
	});

	it("strips a processor's trailing store code with a # or a hyphen, as well as a bare number", () => {
		expect(cleanBankText("SQ *CAFE #552")).toBe("cafe");
		expect(cleanBankText("SQ *CAFE T-1432")).toBe("cafe");
		expect(cleanBankText("SQ *CAFE 0412")).toBe("cafe");
	});

	it("leaves a trailing number alone when there is no processor marker (conservative)", () => {
		expect(cleanBankText("BLUE BOTTLE 0412")).toBe("blue bottle 0412");
	});

	it("reads a state code and a trailing date the same in either order", () => {
		expect(cleanBankText("APPLE.COM/BILL 09/30 CA")).toBe("apple.com/bill");
		expect(cleanBankText("APPLE.COM/BILL 09/30 CA")).toBe(
			cleanBankText("APPLE.COM/BILL CA 09/30"),
		);
	});

	it("strips a valid month and day at the end even when it reads as a date (chosen: MEMORIAL 9/11 is memorial)", () => {
		expect(cleanBankText("MEMORIAL 9/11")).toBe("memorial");
	});

	it("leaves a number that is not directly after POS or CHECKCARD at the start", () => {
		expect(cleanBankText("CITY PARKING 4417")).toBe("city parking 4417");
		expect(cleanBankText("STORE POS 4417")).toBe("store pos 4417");
	});

	it("keeps a bare POS, which may be part of a store's name", () => {
		expect(cleanBankText("POS SYSTEMS INC")).toBe("pos systems inc");
	});

	it("drops a reference ID only when it contains a digit", () => {
		expect(cleanBankText("GOOGLE *YOUTUBE")).toBe("google *youtube");
		expect(cleanBankText("AMZN Mktp US*2K4")).toBe("amzn mktp us");
	});

	it("strips a bank date only at the end of the text, a valid month and day", () => {
		expect(cleanBankText("SOME STORE 09/30")).toBe("some store");
		expect(cleanBankText("24/7 FITNESS")).toBe("24/7 fitness");
		expect(cleanBankText("9/11 MEMORIAL")).toBe("9/11 memorial");
	});

	it("keeps the merchant after a processor's * and drops only the processor", () => {
		expect(cleanBankText("SQ *7ELEVEN")).toBe("7eleven");
		expect(cleanBankText("SQ *24HOURFITNESS")).toBe("24hourfitness");
		expect(cleanBankText("SQ *24HOURFITNESS")).not.toBe(
			cleanBankText("SQ *7ELEVEN"),
		);
	});

	it("collapses whitespace and trims", () => {
		expect(cleanBankText("   Audible    CA   ")).toBe("audible");
		expect(cleanBankText("APPLE.COM/BILL\tCA  09/30")).toBe("apple.com/bill");
	});

	it("strips a state code only in capitals, so a lowercase word stays", () => {
		expect(cleanBankText("Cafe in Maine")).toBe("cafe in maine");
		expect(cleanBankText("Cafe in Maine ME")).toBe("cafe in maine");
	});

	it("keeps a text that is only a state code, since it has nothing to belong to", () => {
		expect(cleanBankText("CA")).toBe("ca");
	});

	it("gives an empty string when only a prefix is left", () => {
		expect(cleanBankText("POS DEBIT")).toBe("");
		expect(cleanBankText("POS DEBIT 09/30")).toBe("");
	});
});

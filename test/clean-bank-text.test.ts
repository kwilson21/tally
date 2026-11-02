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

	it("keeps a bare POS, which may be part of a store's name", () => {
		expect(cleanBankText("POS SYSTEMS INC")).toBe("pos systems inc");
	});

	it("drops a reference ID only when it contains a digit", () => {
		expect(cleanBankText("GOOGLE *YOUTUBE")).toBe("google *youtube");
		expect(cleanBankText("AMZN Mktp US*2K4")).toBe("amzn mktp us");
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

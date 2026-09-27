import { describe, expect, it } from "vitest";
import { tidyName } from "../src/transactions/tidy-name";

// Every raw merchant string in the demo seed (src/demo/seed.ts), and what tidyName should turn
// it into for display. `raw_name` itself is never touched (spec §7); this only checks the pure
// function.
const SEED_NAMES: [string, string][] = [
	// Named merchants (src/demo/seed.ts MERCHANTS).
	["TRADER JOE'S #552", "Trader joe's"],
	["COSTCO WHSE #0431", "Costco whse"],
	["WHOLEFDS MKT 10233", "Wholefds mkt"],
	["BLUE BOTTLE COFFEE", "Blue bottle coffee"],
	["CHIPOTLE 2291", "Chipotle"],
	["OLIVE GARDEN 1187", "Olive garden"],
	["MARIO'S PIZZA", "Mario's pizza"],
	["STARBUCKS STORE 5521", "Starbucks store"],
	["THAI PALACE", "Thai palace"],
	["SHELL OIL 57442", "Shell oil"],
	["CHEVRON 0098812", "Chevron"],
	["TARGET T-1432", "Target"],
	["YOUTH SOCCER LEAGUE", "Youth soccer league"],
	["BARNES & NOBLE #2831", "Barnes & noble"],
	["THE HOME DEPOT #6612", "The home depot"],
	["AMAZON.COM*RT4K2", "Amazon.com*rt4k2"],
	// Uncategorized merchants (src/demo/seed.ts UNCATEGORIZED), the issue's own examples among them.
	["SQ *LOCAL BAKERY 4432", "Local bakery"],
	["PAYPAL *XYZSHOP", "Xyzshop"],
	["SQ *FARMERS MKT", "Farmers mkt"],
	["VENMO *J RIVERA", "Venmo *j rivera"],
	["TST* CORNER DELI", "Corner deli"],
	["AMZN MKTP US*2K4", "Amzn mktp"],
	["SP * CRAFTSUPPLY", "Craftsupply"],
	["POS 4417 CITY PARKING", "City parking"],
	["CHECKCARD 0921 CVS", "CVS"],
	["APPLE.COM/BILL", "Apple.com/bill"],
	["GOOGLE *YOUTUBE", "Google *youtube"],
	["DD *DOORDASH TACO", "Doordash taco"],
	// Income, transfer and reimbursement merchants (src/demo/seed.ts).
	["ACME CORP PAYROLL", "Acme corp payroll"],
	["ONLINE TRANSFER TO SAV ...5678", "Online transfer to sav"],
	["DR MARTIN FAMILY PRACTICE REFUND", "Dr martin family practice refund"],
];

describe("tidyName", () => {
	it.each(SEED_NAMES)("tidies %s to %s", (raw, expected) => {
		expect(tidyName(raw)).toBe(expected);
	});

	it("never returns an empty string for text that's only a prefix", () => {
		expect(tidyName("SQ *")).toBe("SQ *");
	});

	it("leaves numbers-only text as the raw text", () => {
		expect(tidyName("12345")).toBe("12345");
	});

	it("leaves already mixed-case text unchanged", () => {
		expect(tidyName("Local Bakery")).toBe("Local Bakery");
	});

	it("tidies non-ASCII text", () => {
		expect(tidyName("CAFÉ MÜNCHEN")).toBe("Café münchen");
	});

	it("tidies very long text without crashing", () => {
		const raw = "A".repeat(500);
		expect(() => tidyName(raw)).not.toThrow();
		expect(tidyName(raw)).toBe(`A${"a".repeat(499)}`);
	});

	it("collapses leading, trailing and repeated spaces", () => {
		expect(tidyName("  SQ *  LOCAL   BAKERY   4432  ")).toBe("Local bakery");
	});

	it("keeps acronyms in capitals wherever they appear as a whole word", () => {
		expect(tidyName("CHECKCARD 0921 CVS")).toBe("CVS");
		expect(tidyName("ATM WITHDRAWAL 4417")).toBe("ATM withdrawal");
		expect(tidyName("USPS PRIORITY MAIL")).toBe("USPS priority mail");
		expect(tidyName("UPS STORE #1200")).toBe("UPS store");
		expect(tidyName("AT&T BILL PAYMENT")).toBe("AT&T bill payment");
		expect(tidyName("BP GAS STATION 55")).toBe("BP gas station");
		expect(tidyName("KFC 4471")).toBe("KFC");
		expect(tidyName("H&M 2210")).toBe("H&M");
	});
});

import { describe, expect, it } from "vitest";
import { bankWords } from "../src/views/your-banks";

// The words at a bank's row in Home's Your banks list (P140 A, decision 133, spec §8.8): how far Tally has got, by state.
describe("bankWords", () => {
	it("being read with nothing stored yet says Reading alone", () => {
		expect(bankWords("being-read", 0)).toBe("Reading");
	});

	it("paused with nothing stored yet says Paused alone", () => {
		expect(bankWords("paused", 0)).toBe("Paused");
	});

	it("paused with transactions so far says Paused · 86 so far", () => {
		expect(bankWords("paused", 86)).toBe("Paused · 86 so far");
	});

	it("being read with transactions so far says Reading · 86 so far", () => {
		expect(bankWords("being-read", 86)).toBe("Reading · 86 so far");
	});

	it("reading past its first hour with transactions so far says Reading · 86 so far", () => {
		expect(bankWords("reading", 86)).toBe("Reading · 86 so far");
	});

	it("in says 90 days in · 412 once its history is in", () => {
		expect(bankWords("in", 412)).toBe("90 days in · 412");
	});

	it("in groups thousands: 90 days in · 1,234", () => {
		expect(bankWords("in", 1234)).toBe("90 days in · 1,234");
	});
});

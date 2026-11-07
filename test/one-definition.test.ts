import { describe, expect, it } from "vitest";

// Every source file, read as text, so a copied definition cannot hide in a new file.
const SOURCES = import.meta.glob("../src/**/*.{ts,tsx}", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

describe("one definition of a rule", () => {
	it("defines NEEDS_CATEGORY in exactly one place, src/db/transactions.ts", () => {
		const definers = Object.entries(SOURCES)
			.filter(([, text]) => /\bconst\s+NEEDS_CATEGORY(_SQL)?\s*=/.test(text))
			.map(([file]) => file);
		expect(definers).toEqual(["../src/db/transactions.ts"]);
	});

	it("writes a day's length in milliseconds, and the day number of a date, only in src/dates.ts", () => {
		// SQL that turns julian days into milliseconds is a different conversion, so lines with julianday are left out.
		const literal = /\b86_?400_?000\b/;
		const copies = Object.entries(SOURCES).flatMap(([file, text]) =>
			text
				.split("\n")
				.filter((line) => literal.test(line) && !line.includes("julianday"))
				.map(() => file),
		);
		expect([...new Set(copies)]).toEqual(["../src/dates.ts"]);
		const definers = Object.entries(SOURCES)
			.filter(([, text]) =>
				/\b(const|function)\s+(dayNumber|dateNumber|epochDay|calendarDay|fromNumber)\b/.test(
					text,
				),
			)
			.map(([file]) => file);
		expect(definers).toEqual(["../src/dates.ts"]);
	});

	it("names the failures in a row that stop a run in exactly one place", () => {
		const definers = Object.entries(SOURCES)
			.filter(([, text]) => /\bconst\s+MAX_FAILURES_IN_A_ROW\s*=/.test(text))
			.map(([file]) => file);
		expect(definers).toHaveLength(1);
	});

	it("names the bill amount tolerance once, and every bill rule that uses it reads that name", () => {
		const definers = Object.entries(SOURCES)
			.filter(([, text]) =>
				/\bconst\s+BILL_AMOUNT_TOLERANCE_PERCENT\s*=/.test(text),
			)
			.map(([file]) => file);
		expect(definers).toEqual(["../src/bills/status.ts"]);
		// A rule that spells the percentage out again can drift from the others, so each of these must read the name.
		for (const file of [
			"../src/bills/match.ts",
			"../src/bills/find.ts",
			"../src/bills/status.ts",
			"../src/bills/unpaid.ts",
		])
			expect(SOURCES[file], file).toContain("BILL_AMOUNT_TOLERANCE_PERCENT");
	});
});

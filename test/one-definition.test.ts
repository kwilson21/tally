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
});

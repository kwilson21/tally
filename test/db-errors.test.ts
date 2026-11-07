import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "../src/db/errors";

/** An error whose cause is `inner`, the way Drizzle wraps a driver error. */
function wrap(message: string, inner: unknown): Error {
	return new Error(message, { cause: inner });
}

describe("isUniqueViolation", () => {
	it("is true for an Error whose message says UNIQUE", () => {
		expect(
			isUniqueViolation(
				new Error("D1_ERROR: UNIQUE constraint failed: categories.name"),
			),
		).toBe(true);
	});

	it("is true for a wrapped 'Failed query' error whose cause says UNIQUE", () => {
		const error = wrap(
			"Failed query: insert into category_suggestions values (?, ?)",
			new Error("UNIQUE constraint failed: category_suggestions.name"),
		);
		expect(isUniqueViolation(error)).toBe(true);
	});

	it("is false for an unrelated error", () => {
		expect(isUniqueViolation(new Error("no such table: merchants"))).toBe(
			false,
		);
	});

	it("is false for a bare string, even one that says UNIQUE", () => {
		expect(isUniqueViolation("UNIQUE constraint failed")).toBe(false);
	});

	it("is false for an object that only looks like an Error", () => {
		expect(isUniqueViolation({ message: "UNIQUE constraint failed" })).toBe(
			false,
		);
	});

	it("is false for undefined", () => {
		expect(isUniqueViolation(undefined)).toBe(false);
	});

	it("finds UNIQUE on a cause two levels down", () => {
		const error = wrap(
			"Failed query: outer",
			wrap("Failed query: middle", new Error("UNIQUE constraint failed: x")),
		);
		expect(isUniqueViolation(error)).toBe(true);
	});

	it("stops after five levels of cause", () => {
		// The error itself, then five causes: the fifth cause is searched, the sixth is not.
		let deepest: Error = new Error("UNIQUE constraint failed: far");
		for (let i = 0; i < 4; i++) deepest = wrap("Failed query", deepest);
		const fifth = wrap("Failed query", deepest); // UNIQUE is 5 causes below this error
		expect(isUniqueViolation(fifth)).toBe(true);
		const sixth = wrap("Failed query", fifth); // now 6 causes below
		expect(isUniqueViolation(sixth)).toBe(false);
	});

	it("does not hang on an error whose cause is itself", () => {
		const error = new Error("Failed query: loop");
		(error as Error & { cause?: unknown }).cause = error;
		expect(isUniqueViolation(error)).toBe(false);
	});
});

/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { MoneyInput } from "../src/views/money-input";

const inputTag = (error?: string) =>
	String(
		MoneyInput({
			id: "amount",
			name: "amount",
			label: "Amount",
			value: "20.00",
			error,
		}),
	).match(/<input [^>]*data-money-input[^>]*>/)?.[0] ?? "";

describe("MoneyInput", () => {
	it("makes the input fill the whole 90px box, so tapping anywhere in the box focuses it", () => {
		// The box is a div, not a label: an input only as tall as its text (42px) leaves the box's top and
		// bottom bands dead. self-stretch and -my-3 (undoing the box's py-3) give the input the box's
		// height, as the cent arrows beside it have.
		const input = inputTag();
		expect(input).toMatch(/class="[^"]*\bself-stretch\b/);
		expect(input).toMatch(/class="(?:[^"]* )?-my-3[ "]/);
	});

	it("keeps the field-shake class on the same input when there is an error", () => {
		const input = inputTag("Enter a dollar amount.");
		expect(input).toContain("field-shake");
		expect(input).toMatch(/class="[^"]*\bself-stretch\b/);
	});
});

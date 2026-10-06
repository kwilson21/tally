/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
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

const draw = () =>
	renderToString(
		<MoneyInput id="amount" name="amount" label="Budget" value="700.00" />,
	);

describe("MoneyInput's corners (decision 85, Q61 A)", () => {
	it("draws the box in the 12px control corner, like every input", () => {
		const html = draw();
		// The box that holds the $ and the amount, found by its fixed width and height.
		const box =
			html.match(/<div class="([^"]*min-h-\[90px\][^"]*)"/)?.[1] ?? "";
		expect(box).toContain("rounded-control");
		expect(box).not.toContain("rounded-lg");
	});

	it("rounds the cent arrows' outer corners with the same token", () => {
		const html = draw();
		expect(html).toContain("rounded-tr-control");
		expect(html).toContain("rounded-br-control");
	});

	it("keeps no 8px corner anywhere", () => {
		expect(draw()).not.toMatch(/rounded(-[a-z]{1,2})?-lg/);
	});
});

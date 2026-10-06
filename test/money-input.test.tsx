/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { MoneyInput } from "../src/views/money-input";

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

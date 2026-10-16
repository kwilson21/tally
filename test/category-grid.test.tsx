/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { CategoryGrid } from "../src/views/category-grid";

const CATS = [
	{ id: 1, name: "Groceries", icon: "cart", color: "cat-blue" },
	{ id: 2, name: "Gas", icon: "fuel", color: "cat-ochre" },
	{ id: 3, name: "Rent", icon: "rent", color: "cat-slate" },
];

/** The radio values in the order they're drawn. */
const values = (html: string) =>
	[...html.matchAll(/type="radio" name="(\w+)" value="([^"]*)"/g)].map(
		(m) => m[2],
	);

describe("CategoryGrid (#498, P120 B)", () => {
	it("draws the choices in two equal columns", () => {
		const html = renderToString(<CategoryGrid categories={CATS} />);
		expect(html).toMatch(/^<div class="grid grid-cols-2 gap-2">/);
		expect(html).not.toContain("flex-wrap");
	});

	it("ends with New category when asked, and not otherwise", () => {
		const plain = renderToString(<CategoryGrid categories={CATS} />);
		expect(values(plain)).toEqual(["1", "2", "3"]);
		const withNew = renderToString(
			<CategoryGrid categories={CATS} newCategory />,
		);
		expect(values(withNew)).toEqual(["1", "2", "3", "new"]);
		expect(withNew).toContain("New category");
	});

	it("draws a leading cell, such as Tally's guess, before the categories", () => {
		const html = renderToString(
			<CategoryGrid categories={CATS} leading={<span>Guess</span>} />,
		);
		expect(html.indexOf("Guess")).toBeLessThan(html.indexOf("Groceries"));
	});

	it("checks the chosen category and names every radio with one group", () => {
		const html = renderToString(
			<CategoryGrid categories={CATS} checkedId={2} name="category" />,
		);
		expect(html).toMatch(/value="2"[^>]*checked|checked[^>]*value="2"/);
		expect(html.match(/name="category"/g)?.length).toBe(3);
	});

	it("requires the first choice when the group is required (Organize)", () => {
		const html = renderToString(<CategoryGrid categories={CATS} required />);
		const first = html.match(/<input[^>]*value="1"[^>]*>/)?.[0] ?? "";
		expect(first).toContain("required");
		const second = html.match(/<input[^>]*value="2"[^>]*>/)?.[0] ?? "";
		expect(second).not.toContain("required");
	});
});

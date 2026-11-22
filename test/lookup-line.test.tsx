/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { LookupLine } from "../src/views/lookup-line";

// #988: the store lookup's line under a guess that used it, with a quiet "Don't use this" below it (P146 option B).

describe("LookupLine", () => {
	it("draws the line after From the web, with the search icon hidden from screen readers", () => {
		const html = renderToString(
			<LookupLine line="Coffee shop in Arlington, VA" store="La Coop" />,
		);

		expect(html).toContain("From the web: Coffee shop in Arlington, VA");
		expect(html).toContain('data-icon="search"');
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain("text-sm text-muted");
	});

	it("names the store in the button", () => {
		const html = renderToString(
			<LookupLine line="Coffee shop in Arlington, VA" store="La Coop" />,
		);

		expect(html).toContain('aria-label="Don&#39;t use this for La Coop"');
		expect(html).toContain("Don&#39;t use this</button>");
		expect(html).toContain('type="submit"');
		expect(html).toContain("min-h-11");
		expect(html).toContain("underline");
		expect(html).toContain("text-muted");
	});

	it("passes the button's own attributes through", () => {
		const html = renderToString(
			<LookupLine
				line="Coffee shop in Arlington, VA"
				store="La Coop"
				button={{ name: "answer", value: "dont_use" }}
			/>,
		);

		expect(html).toContain('name="answer"');
		expect(html).toContain('value="dont_use"');
	});

	it("an 80-character line is drawn whole", () => {
		const line =
			"Independent hardware store and garden store in Takoma Park, Maryland, since 1946";

		expect(line).toHaveLength(80);

		const html = renderToString(
			<LookupLine line={line} store="Maple Street Hardware" />,
		);

		expect(html).toContain(line);
		expect(html).toContain("wrap-anywhere");
	});

	it("lines the button's text up with the icon's left edge", () => {
		const html = renderToString(
			<LookupLine line="Coffee shop in Arlington, VA" store="La Coop" />,
		);

		expect(html).toMatch(/<button[^>]*class="[^"]*-ml-2/);
	});
});

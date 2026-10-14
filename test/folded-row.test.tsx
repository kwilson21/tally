/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { FoldedRow } from "../src/views/folded-row";

describe("FoldedRow", () => {
	it("is a disclosure at least 48px tall, under a rule, closed by default", () => {
		const html = renderToString(
			<FoldedRow label="Category">
				<p>Chips</p>
			</FoldedRow>,
		);
		expect(html).toMatch(/^<details class="group border-b border-rule"[^>]*>/);
		expect(html).not.toMatch(/<details[^>]* open[ >=]/);
		const summary = html.match(/<summary [^>]*>/)?.[0] ?? "";
		expect(summary).toContain("min-h-12");
		expect(summary).toContain("list-none");
		// Hono escapes the & in an attribute; the browser reads it back as the same class.
		expect(summary).toContain("[&amp;::-webkit-details-marker]:hidden");
		expect(summary).toContain("focus-visible:outline-accent");
	});

	it("shows its name in muted words", () => {
		const html = renderToString(<FoldedRow label="Match payments from" />);
		expect(html).toContain(
			'<span class="text-muted">Match payments from</span>',
		);
	});

	it("shows a short choice at the right, after the name", () => {
		const html = renderToString(
			<FoldedRow label="Category" value={<span>Groceries</span>} />,
		);
		expect(html).toMatch(
			/<span class="ml-auto flex min-w-0 items-center gap-2"><span>Groceries<\/span><\/span>/,
		);
		expect(html).not.toContain("truncate text-sm text-muted");
	});

	it("shows a long choice under the name, cut to one line", () => {
		const html = renderToString(
			<FoldedRow
				label="Match payments from"
				sub="CITY WATER AUTOPAY 0093 REF"
			/>,
		);
		expect(html).toContain(
			'<span class="truncate text-sm text-muted">CITY WATER AUTOPAY 0093 REF</span>',
		);
		expect(html).not.toContain("ml-auto flex min-w-0 items-center gap-2");
	});

	it("turns its chevron when it opens", () => {
		const html = renderToString(<FoldedRow label="Category" />);
		expect(html).toMatch(
			/<svg [^>]*class="[^"]*text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none[^"]*"/,
		);
	});

	it("opens in place when told to, and not otherwise", () => {
		const closed = renderToString(<FoldedRow label="Category" />);
		const open = renderToString(<FoldedRow label="Category" open />);
		expect(closed).not.toMatch(/<details[^>]* open[ >=]/);
		expect(open).toMatch(/<details[^>]* open[ >=]/);
	});

	it("holds its controls after the row, so they still post while it is closed", () => {
		const html = renderToString(
			<FoldedRow label="Category">
				<input name="category" value="gas" />
			</FoldedRow>,
		);
		const summaryEnd = html.indexOf("</summary>");
		const control = html.indexOf('name="category"');
		expect(control).toBeGreaterThan(summaryEnd);
		expect(html.indexOf("</details>")).toBeGreaterThan(control);
		expect(html).not.toMatch(/<details[^>]* open[ >=]/);
	});
});

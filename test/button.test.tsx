/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "../src/views/button";

describe("Button", () => {
	it.each([
		["primary", "bg-ink"],
		["secondary", "border-ink"],
		["text", "text-accent"],
	] as const)("renders the %s kind", (kind, style) => {
		expect(renderToString(<Button kind={kind}>Act</Button>)).toContain(style);
	});

	it("renders a link and passes attributes through", () => {
		const html = renderToString(
			<Button href="/back" kind="secondary" class="w-full" hx-get="/next">
				Cancel
			</Button>,
		);
		expect(html).toContain('<a href="/back"');
		expect(html).toContain('hx-get="/next"');
		expect(html).toContain("w-full");
	});

	it("passes button attributes through", () => {
		const html = renderToString(
			<Button type="submit" formaction="/save" disabled>
				Save
			</Button>,
		);
		expect(html).toContain('type="submit"');
		expect(html).toContain('formaction="/save"');
		expect(html).toContain("disabled");
	});
});

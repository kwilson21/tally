/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import css from "../src/styles/app.css?raw";
import { TextInput } from "../src/views/text-input";

describe("TextInput", () => {
	it("renders its label and passes native attributes through", () => {
		const html = renderToString(
			<TextInput
				id="name"
				label="Name"
				name="name"
				value="Food"
				maxlength={40}
			/>,
		);
		expect(html).toContain('<label for="name"');
		expect(html).toContain('value="Food"');
		expect(html).toContain('maxlength="40"');
		expect(html).toContain("bg-band");
	});

	it("supports the paper surface", () => {
		expect(
			renderToString(
				<TextInput id="merchant" label="Merchant" surface="paper" />,
			),
		).toContain("bg-paper");
	});

	it("connects and announces an error", () => {
		const html = renderToString(
			<TextInput id="name" label="Name" error="Required" />,
		);
		expect(html).toContain('aria-invalid="true"');
		expect(html).toContain('aria-describedby="name-error"');
		expect(html).toContain('role="alert"');
		expect(html).toContain("field-shake");
	});

	it("defines a reduced-motion-safe error shake", () => {
		expect(css).toContain("@keyframes field-shake");
		expect(css).toMatch(
			/prefers-reduced-motion: reduce[\s\S]*\.field-shake[\s\S]*animation: none/,
		);
	});

	it("passes disabled through", () => {
		const html = renderToString(<TextInput id="name" label="Name" disabled />);
		expect(html).toContain("disabled");
		expect(html).toContain("disabled:opacity-40");
	});

	it("connects a hint to the input", () => {
		const html = renderToString(
			<TextInput id="merchant" label="Merchant" hint="Helpful text" />,
		);
		expect(html).toContain('aria-describedby="merchant-hint"');
		expect(html).toContain('<p id="merchant-hint" class="text-sm text-muted">');
	});

	it("connects a hint before an error", () => {
		const html = renderToString(
			<TextInput
				id="merchant"
				label="Merchant"
				hint="Helpful text"
				error="Required"
			/>,
		);
		expect(html).toContain('aria-describedby="merchant-hint merchant-error"');
		expect(html.indexOf('id="merchant-hint"')).toBeLessThan(
			html.indexOf('role="alert"'),
		);
	});
});

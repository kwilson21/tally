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

	it("uses caller horizontal padding instead of the kind default", () => {
		const custom = renderToString(<Button class="px-3">Act</Button>);
		expect(custom).toContain("px-3");
		expect(custom).not.toContain("px-5");
		expect(renderToString(<Button>Act</Button>)).toContain("px-5");
	});

	it.each(["primary", "text"] as const)(
		"gives a %s link a full button target without an underline",
		(kind) => {
			const html = renderToString(
				<Button href="/next" kind={kind}>
					Next
				</Button>,
			);
			expect(html).toContain("inline-flex");
			expect(html).toContain("items-center");
			expect(html).toContain("justify-center");
			expect(html).toContain("no-underline");
		},
	);

	it("renders a disabled link action as a disabled button", () => {
		const html = renderToString(
			<Button href="/next" disabled>
				Next
			</Button>,
		);
		expect(html).toContain('<button type="button" disabled');
		expect(html).toContain("disabled:opacity-40");
		expect(html).not.toContain("<a");
	});

	it("dims disabled buttons without adding the disabled style to links", () => {
		expect(renderToString(<Button disabled>Save</Button>)).toContain(
			"disabled:opacity-40",
		);
		expect(renderToString(<Button href="/next">Next</Button>)).not.toContain(
			"disabled:opacity-40",
		);
	});

	it("swaps resting content for busy content without affecting resting size", () => {
		const html = renderToString(<Button busyLabel="Saving…">Save</Button>);
		expect(html).toContain("Saving…");
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain("button-spinner");
		expect(html).toContain('class="contents [.htmx-request_&amp;]:hidden"');
		expect(html).toContain('class="hidden [.htmx-request_&amp;]:inline-flex');
		expect(html).not.toContain("inline-grid");
	});

	it("does not render busy content unless requested", () => {
		const html = renderToString(<Button>Save</Button>);
		expect(html).not.toContain("button-spinner");
		expect(html).not.toContain("Saving…");
	});

	it("keeps only the requesting busy button at full opacity", () => {
		const busy = renderToString(<Button busyLabel="Saving…">Save</Button>);
		const plain = renderToString(<Button>Cancel</Button>);

		expect(busy).toContain("[&amp;.htmx-request]:opacity-100!");
		expect(plain).not.toContain("[&amp;.htmx-request]:opacity-100!");
	});
});

/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { ErrorPage } from "../src/views/error-page";

const render = (props: Parameters<typeof ErrorPage>[0]) =>
	String(ErrorPage(props));

describe("ErrorPage", () => {
	it("draws the ledger large, as a decoration", () => {
		const html = render({ kind: "404" });
		expect(html).toContain("[&amp;&gt;svg]:size-44");
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain('stroke-width="1.75"');
	});

	it("puts the serif number in the one h1, read as an error by screen readers", () => {
		for (const kind of ["404", "500"] as const) {
			const html = render(
				kind === "404" ? { kind } : { kind, retryHref: "/bills" },
			);
			expect(html.match(/<h1/g)).toHaveLength(1);
			expect(html).toMatch(
				new RegExp(
					`<h1 class="[^"]*font-serif[^"]*text-7xl[^"]*"><span class="sr-only">Error </span>${kind}</h1>`,
				),
			);
		}
	});

	it("says the 404 in one sentence, with Go to Home as a secondary button and no Try again", () => {
		const html = render({ kind: "404" });
		expect(html).toContain("This page isn&#39;t here.");
		expect(html).toMatch(
			/<a href="\/"[^>]*class="[^"]*border-ink[^"]*"[^>]*>Go to Home<\/a>/,
		);
		expect(html).not.toContain("Try again");
		expect(html).not.toContain("text-muted");
	});

	it("says the 500 is Tally's, with Try again on the address it was given and Go to Home as quiet text", () => {
		const html = render({ kind: "500", retryHref: "/bills?month=2026-09" });
		expect(html).toContain("Something went wrong on our side.");
		expect(html).toContain(
			"Nothing you did. Your data is safe; try again in a minute.",
		);
		expect(html).toMatch(
			/<a href="\/bills\?month=2026-09"[^>]*class="[^"]*border-ink[^"]*"[^>]*>Try again<\/a>/,
		);
		expect(html).toMatch(
			/<a href="\/"[^>]*class="[^"]*text-accent[^"]*"[^>]*>Go to Home<\/a>/,
		);
	});

	it("keeps both buttons at least 44px tall", () => {
		const html = render({ kind: "500", retryHref: "/" });
		expect(html.match(/min-h-11/g)).toHaveLength(2);
	});
});

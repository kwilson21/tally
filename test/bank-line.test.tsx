/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { BankBehind } from "../src/views/bank-line";
import { HomeTop } from "../src/views/home-top";

describe("BankBehind", () => {
	const html = String(BankBehind({ words: ["Chase stopped updating Oct 2"] }));

	it("uses an alert icon and the picked plain words", () => {
		expect(html).toContain("Chase stopped updating Oct 2");
		expect(html).toContain(
			'<p class="min-w-0 flex-1 text-pretty">Chase stopped updating Oct 2</p>',
		);
		expect(html).toContain('data-icon="bank"');
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain("bg-over/10");
	});

	it("links to Accounts with a 44px Fix button", () => {
		expect(html).toMatch(
			/<a href="\/accounts" class="[^"]*min-h-11[^"]*">Fix<span class="sr-only"> the bank in Accounts<\/span><\/a>/,
		);
	});

	it("renders multiple bank lines as list items before one Fix button", () => {
		const multiple = String(
			BankBehind({
				words: [
					"Chase stopped updating Sep 20",
					"Capital One needs signing in",
				],
			}),
		);
		expect(multiple).toContain('<ul class="min-w-0 flex-1 list-none');
		expect(multiple).toContain("<li>Chase stopped updating Sep 20</li>");
		expect(multiple).toContain("<li>Capital One needs signing in</li>");
		expect(multiple.indexOf("Capital One needs signing in")).toBeLessThan(
			multiple.indexOf('href="/accounts"'),
		);
		expect(multiple.match(/data-icon="bank"/g) ?? []).toHaveLength(1);
		expect(multiple.match(/href="\/accounts"/g) ?? []).toHaveLength(1);
	});
});

describe("HomeTop with a bank behind", () => {
	const top = (props: Partial<Parameters<typeof HomeTop>[0]> = {}) =>
		String(
			HomeTop({
				month: "October",
				safeToSpendCents: 93400,
				status: "Everything is on track.",
				band: { href: "/transactions/organize", text: "4 need a category" },
				forecast: "forecast",
				...props,
			}),
		);

	it("puts the as-of tag on the amount, then the bank line before the forecast", () => {
		const html = top({
			bankDate: "Oct 2",
			bankLine: [
				"Chase stopped updating Oct 2",
				"Capital One needs signing in",
			],
		});
		const at = (text: string) => html.indexOf(text);
		expect(at("as of Oct 2")).toBeLessThan(at("Chase stopped updating Oct 2"));
		expect(at("Chase stopped updating Oct 2")).toBeLessThan(at("forecast"));
		expect(at("Capital One needs signing in")).toBeLessThan(at("forecast"));
		expect(html.match(/data-icon="bank"/g) ?? []).toHaveLength(1);
		expect(html.match(/href="\/accounts"/g) ?? []).toHaveLength(1);
		expect(html).toContain("<li>Capital One needs signing in</li>");
		expect(at("forecast")).toBeLessThan(at("How this works"));
		expect(at("How this works")).toBeLessThan(at("4 need a category"));
	});

	it("keeps Fix when there is no Band", () => {
		const html = top({ bankLine: ["Chase needs signing in"], band: undefined });
		expect(html).toContain("Fix");
		expect(html).not.toContain("bg-band");
	});
});

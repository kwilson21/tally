/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { BankLine } from "../src/views/bank-line";
import { HomeTop } from "../src/views/home-top";

const WORDS =
	"Chase hasn't synced since Oct 1, so Safe to spend may be too high.";

// P37 A (decision 72): the alert icon and ink words, then a 44px terracotta link to Accounts.
describe("BankLine", () => {
	const html = String(BankLine({ words: WORDS }));

	it("says the words, with an alert icon so it isn't color alone", () => {
		expect(html).toContain("hasn&#39;t synced since Oct 1");
		expect(html).toContain("Safe to spend may be too high.");
		expect(html).toContain("<svg");
		expect(html).toContain('aria-hidden="true"');
	});

	it("keeps the words in ink, not brick", () => {
		expect(html).not.toContain("text-over");
		expect(html).not.toContain("text-muted");
	});

	it("links to Accounts with a 44px target", () => {
		expect(html).toMatch(
			/<a href="\/accounts" class="[^"]*min-h-11[^"]*">\s*Check Accounts\s*<\/a>/,
		);
	});

	it("is not an alert: it's a standing line, not an error to announce", () => {
		expect(html).not.toContain("role=");
	});
});

describe("HomeTop with a bank line", () => {
	const top = (props: Partial<Parameters<typeof HomeTop>[0]> = {}) =>
		String(
			HomeTop({
				month: "October",
				safeToSpendCents: 93400,
				status: "Everything is on track.",
				band: { href: "/transactions/organize", text: "4 need a category" },
				...props,
			}),
		);

	it("puts the line after the status sentence and How this works, before the Band", () => {
		const html = top({ bankLine: WORDS });
		const at = (s: string) => html.indexOf(s);
		expect(at("Everything is on track.")).toBeLessThan(at("How this works"));
		expect(at("How this works")).toBeLessThan(at("Safe to spend may be too"));
		expect(at("Safe to spend may be too")).toBeLessThan(
			at("4 need a category"),
		);
		expect(at("Check Accounts")).toBeLessThan(at("4 need a category"));
	});

	it("leaves the Band its job: it is still the only tinted row", () => {
		const html = top({ bankLine: WORDS });
		expect(html.match(/bg-band/g)).toHaveLength(1);
	});

	it("shows the line without a Band too", () => {
		const html = top({ bankLine: WORDS, band: undefined });
		expect(html).toContain("Check Accounts");
		expect(html).not.toContain("bg-band");
	});

	it("draws nothing extra without one", () => {
		const html = top();
		expect(html).not.toContain("Check Accounts");
		expect(html).not.toContain("Safe to spend may be too high");
	});
});

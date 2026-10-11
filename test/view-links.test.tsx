/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { ViewLinks } from "../src/views/view-links";

const props = { madeHref: "/transactions", bankHref: "/transactions?raw=1" };
const nav = (current: "made" | "bank", extra: object = {}) =>
	String(ViewLinks({ ...props, current, ...extra }));
const links = (html: string) =>
	[...html.matchAll(/<a [^>]*>[^<]*<\/a>/g)].map((m) => m[0]);

describe("ViewLinks", () => {
	it("is a nav named View with the two links and a dot hidden from screen readers", () => {
		const html = nav("made");
		expect(html).toMatch(/^<nav [^>]*aria-label="View"/);
		expect(html).toContain('id="view-links"');
		expect(links(html).map((a) => a.replace(/<[^>]+>/g, ""))).toEqual([
			"With Tally",
			"Without Tally",
		]);
		expect(html).toMatch(/<span[^>]*aria-hidden="true"[^>]*>\s*·\s*<\/span>/);
	});

	it("makes each link 44px tall and sends each to its own address", () => {
		const [made, bank] = links(nav("made"));
		expect(made).toContain("min-h-11");
		expect(bank).toContain("min-h-11");
		expect(made).toContain('href="/transactions"');
		expect(bank).toContain('href="/transactions?raw=1"');
	});

	it("draws the current one in ink, semibold and not underlined, with aria-current, and the other as a link", () => {
		for (const current of ["made", "bank"] as const) {
			const [made, bank] = links(nav(current));
			const [here, other] = current === "made" ? [made, bank] : [bank, made];
			expect(here).toContain('aria-current="page"');
			expect(here).toContain("text-ink");
			expect(here).toContain("font-semibold");
			expect(here).toContain("no-underline");
			expect(other).not.toContain("aria-current");
			expect(other).not.toContain("text-ink");
			expect(other).not.toContain("font-semibold");
			expect(other).not.toContain("no-underline");
		}
	});

	it("takes its own id, so the catalog can show it twice", () => {
		expect(nav("bank", { id: "ds-view-bank" })).toContain('id="ds-view-bank"');
	});

	it("carries no script", () => {
		const html = nav("made");
		expect(html).not.toContain("hx-");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("onclick");
	});
});

// Every source file as text: the link names changed, so no file in src keeps the old words.
const SRC = import.meta.glob(["../src/**/*.{ts,tsx,css}"], {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

describe("the link names in src", () => {
	it("appear in no source file under the old words", () => {
		expect(Object.keys(SRC).length).toBeGreaterThan(100);
		for (const [file, text] of Object.entries(SRC)) {
			expect(text.toLowerCase(), file).not.toContain("tidied by tally");
			expect(text.toLowerCase(), file).not.toContain("straight from the bank");
		}
	});
});

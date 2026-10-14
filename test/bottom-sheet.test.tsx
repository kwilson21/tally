/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { BottomSheet } from "../src/views/bottom-sheet";

// The markup from main before the footer slot existed, captured then, plus the two markers sheet.js
// finds the sheet by (#87): a sheet without a footer must otherwise still draw exactly this.
const PLAIN_BEFORE_FOOTER =
	'<a href="/bills" aria-label="Close" tabindex="-1" data-sheet-close="" class="fade-in fixed inset-0 z-40 bg-ink/30" hx-get="/bills" hx-target="#page"></a><section role="dialog" aria-labelledby="sheet-title" data-sheet="" class="sheet-panel fixed inset-x-0 bottom-0 z-50 max-h-[min(90vh,calc(100svh-var(--safe-area-top)-var(--toast-top-room)))] overflow-y-auto rounded-t-sheet bg-paper p-5 pb-[calc(1.25rem+var(--safe-area-bottom))] pl-[calc(1.25rem+var(--safe-area-left))] pr-[calc(1.25rem+var(--safe-area-right))] lg:inset-y-0 lg:left-auto lg:max-h-none lg:w-[28rem] lg:rounded-none lg:rounded-l-sheet">Body</section>';

const STILL_BEFORE_FOOTER =
	'<a href="/bills" aria-label="Close" tabindex="-1" data-sheet-close="" class="fixed inset-0 z-40 bg-ink/30"></a><section role="dialog" aria-labelledby="sheet-title" data-sheet="" class="fixed inset-x-0 bottom-0 z-50 max-h-[min(90vh,calc(100svh-var(--safe-area-top)-var(--toast-top-room)))] overflow-y-auto rounded-t-sheet bg-paper p-5 pb-[calc(1.25rem+var(--safe-area-bottom))] pl-[calc(1.25rem+var(--safe-area-left))] pr-[calc(1.25rem+var(--safe-area-right))] lg:inset-y-0 lg:left-auto lg:max-h-none lg:w-[28rem] lg:rounded-none lg:rounded-l-sheet">Body</section>';

describe("BottomSheet without a footer", () => {
	it("draws exactly the markup it drew before the footer slot, with the sheet markers", () => {
		expect(
			renderToString(
				<BottomSheet
					labelledBy="sheet-title"
					closeHref="/bills"
					closeAttrs={{ "hx-get": "/bills", "hx-target": "#page" }}
				>
					Body
				</BottomSheet>,
			),
		).toBe(PLAIN_BEFORE_FOOTER);
	});

	it("keeps the still sheet's markup as it was", () => {
		expect(
			renderToString(
				<BottomSheet labelledBy="sheet-title" closeHref="/bills" still>
					Body
				</BottomSheet>,
			),
		).toBe(STILL_BEFORE_FOOTER);
	});
});

describe("BottomSheet with a footer", () => {
	const html = renderToString(
		<BottomSheet
			labelledBy="sheet-title"
			closeHref="/bills"
			footer={
				<div class="grid grid-cols-2 gap-3">
					<button id="footer-cancel" type="button">
						Cancel
					</button>
					<button id="footer-save" type="submit">
						Save
					</button>
				</div>
			}
		>
			<p id="body-text">Body</p>
		</BottomSheet>,
	);

	it("is a column whose middle scrolls, with the same height limit as before", () => {
		const section = html.match(/<section[^>]*>/)?.[0] ?? "";
		expect(section).toMatch(/\bflex\b[^"]*\bflex-col\b/);
		expect(section).not.toContain("overflow-y-auto");
		expect(section).toContain(
			"max-h-[min(90vh,calc(100svh-var(--safe-area-top)-var(--toast-top-room)))]",
		);
		expect(section).toContain("lg:max-h-none");
		expect(section).toContain("lg:w-[28rem]");
		expect(section).toContain("sheet-panel");
	});

	it("puts the children in the scrolling element, with the side safe-area padding", () => {
		expect(html).toMatch(
			/<div class="min-h-0 flex-1 overflow-y-auto p-5 pl-\[calc\(1\.25rem\+var\(--safe-area-left\)\)\] pr-\[calc\(1\.25rem\+var\(--safe-area-right\)\)\]"><p id="body-text">Body<\/p><\/div>/,
		);
	});

	it("puts the footer after the scrolling element, outside it, under a rule with the bottom safe area", () => {
		const scroller = html.indexOf('id="body-text"');
		const scrollerEnd = html.indexOf("</div>", scroller);
		const footerStart = html.indexOf(
			'<div class="shrink-0 border-t border-rule',
		);
		expect(footerStart).toBeGreaterThan(scrollerEnd);
		expect(footerStart).toBeGreaterThan(0);
		const footer = html.slice(footerStart);
		expect(footer.slice(0, footer.indexOf(">") + 1)).toContain(
			"pb-[calc(1.25rem+var(--safe-area-bottom))]",
		);
		expect(footer).toContain('id="footer-cancel"');
		expect(footer).toContain('id="footer-save"');
		// Nothing of the footer sits inside the scrolling element.
		expect(html.slice(scroller, footerStart)).not.toContain("footer-save");
	});

	it("marks the section and its backdrop for sheet.js, as it does without a footer", () => {
		expect(html).toMatch(
			/<section role="dialog" aria-labelledby="sheet-title" data-sheet="" class="[^"]*">/,
		);
		expect(html).toMatch(
			/<a href="\/bills" aria-label="Close" tabindex="-1" data-sheet-close="" class="[^"]*"><\/a>/,
		);
	});

	it("keeps the still sheet's classes off the footer's markup when still", () => {
		const still = renderToString(
			<BottomSheet
				labelledBy="sheet-title"
				closeHref="/bills"
				still
				footer={<button type="submit">Save</button>}
			>
				Body
			</BottomSheet>,
		);
		expect(still).not.toMatch(/\bsheet-panel\b|\bfade-in\b/);
	});
});

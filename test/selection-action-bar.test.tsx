/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { NotOnPageCount } from "../src/views/selection-action-bar";

// Decision 128 (#676): the number of ticks not on this page is a figure; its words are prose.
describe("NotOnPageCount (decision 128)", () => {
	it("sets the count in tabular figures, and the words after it outside them", () => {
		expect(String(NotOnPageCount({ count: 3 }))).toBe(
			'<span id="not-on-page-count"><span class="tabular-nums">3</span> not on this page</span>',
		);
	});

	it("keeps the same figures when it is swapped out of band", () => {
		expect(String(NotOnPageCount({ count: 3, oob: true }))).toBe(
			'<span id="not-on-page-count" hx-swap-oob="innerHTML"><span class="tabular-nums">3</span> not on this page</span>',
		);
	});
});

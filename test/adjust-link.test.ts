import { describe, expect, it } from "vitest";
import { AdjustLink } from "../src/views/adjust-link";

describe("AdjustLink (#94)", () => {
	it("day to day, links to Home in Adjust mode", async () => {
		const html = (await AdjustLink({ adjusting: false }).toString()) as string;
		expect(html).toMatch(
			/<a href="\/\?adjust=1"[^>]*class="[^"]*min-h-11[^"]*text-accent/,
		);
		expect(html).toContain('Adjust<span class="sr-only"> budgets</span>');
	});

	it("in Adjust mode, says Done and links back to Home", async () => {
		const html = (await AdjustLink({ adjusting: true }).toString()) as string;
		expect(html).toMatch(/<a href="\/"/);
		expect(html).toContain(
			'Done<span class="sr-only"> adjusting budgets</span>',
		);
	});

	it("passes htmx attributes through", async () => {
		const html = (await AdjustLink({
			adjusting: false,
			attrs: { "hx-get": "/?adjust=1" },
		}).toString()) as string;
		expect(html).toContain('hx-get="/?adjust=1"');
	});
});

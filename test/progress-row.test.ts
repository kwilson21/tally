import { describe, expect, it } from "vitest";
import { ProgressRow } from "../src/views/progress-row";

const row = (spentCents: number, budgetCents: number) =>
	ProgressRow({
		name: "Gas",
		icon: "gas",
		color: "cat-slate",
		spentCents,
		budgetCents,
		href: "/budget/3",
	}).toString();

describe("ProgressRow", () => {
	it("is a link to its budget sheet, saying so to screen readers", async () => {
		const html = await row(18600, 20000);
		expect(html).toMatch(/<a href="\/budget\/3"/);
		expect(html).toContain('<span class="sr-only">, change the budget</span>');
	});

	it("draws a 4px bar with no limit marker (decision 46)", async () => {
		for (const html of [await row(18600, 20000), await row(28600, 25000)]) {
			expect(html).toMatch(/<svg class="mt-2 h-1 w-full"/);
			expect(html).not.toContain("<line");
		}
	});

	it("over budget, the bar is full and brick", async () => {
		const html = await row(28600, 25000);
		expect(html).toMatch(/<rect width="100%"[^>]*class="bar-fill fill-over"/);
	});

	it("says by how much it's over, in words, not only color", async () => {
		expect(await row(18600, 20000)).not.toContain(" over");
		const html = await row(28600, 25000);
		expect(html).toMatch(/\$36 over<span class="sr-only"> budget<\/span>/);
	});

	it("keeps the cents when the overage isn't whole dollars", async () => {
		const html = await row(28650, 25000);
		expect(html).toMatch(/\$36\.50 over<span class="sr-only"> budget<\/span>/);
	});
});

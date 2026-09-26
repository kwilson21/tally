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

	it("draws the limit notch at the icon stroke width", async () => {
		const notch = (await row(18600, 20000)).match(/<line[^>]*>/)?.[0];
		expect(notch).toContain('stroke-width="1.75"');
	});

	it("says over budget in words, not only color", async () => {
		expect(await row(18600, 20000)).not.toContain("over budget");
		expect(await row(28600, 25000)).toContain("over budget");
	});
});

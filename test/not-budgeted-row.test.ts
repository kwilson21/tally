import { describe, expect, it } from "vitest";
import { NotBudgetedRow } from "../src/views/not-budgeted-row";

const render = (spentCents: number) =>
	NotBudgetedRow({
		name: "Kids",
		icon: "kids",
		color: "cat-ochre",
		spentCents,
		href: "/budget/4",
	}).toString();

describe("NotBudgetedRow", () => {
	it("shows positive counted spending under the category name in muted text", () => {
		expect(render(6000)).toMatch(/Kids[\s\S]*text-muted[^>]*>\$60 spent/);
	});

	it("shows cents only when present", () => {
		expect(render(1450)).toContain("$14.50 spent");
	});

	it("shows a net refund in green and leaves a zero-spending row as before", () => {
		expect(render(-2000)).toMatch(/text-ok[^>]*>\+\$20/);
		expect(render(0)).not.toContain("spent");
	});

	it("tells screen readers a net refund outweighs spending, after the amount", () => {
		expect(render(-2000)).toContain(
			'+$20<span class="sr-only"> back: refunds outweigh spending</span>',
		);
		expect(render(6000)).not.toContain("refunds outweigh");
		expect(render(0)).not.toContain("refunds outweigh");
	});

	it("shows an archived category that nets to $0 as $0, with no link and no Add a budget", () => {
		const html = NotBudgetedRow({
			name: "Old",
			icon: "tag",
			color: "cat-slate",
			spentCents: 0,
		}).toString();
		expect(html).toContain('<span class="block text-sm text-muted">$0</span>');
		expect(html).not.toContain("<a ");
		expect(html).not.toContain("Add a budget");
	});

	it("leaves an active category that nets to $0 with its name and Add a budget only", () => {
		expect(render(0)).not.toContain('text-muted">$0');
	});
});

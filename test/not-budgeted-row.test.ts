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
});

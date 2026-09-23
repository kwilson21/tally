import { describe, expect, it } from "vitest";
import { ProgressRow } from "../src/views/progress-row";

const row = (spentCents: number, budgetCents: number) =>
	ProgressRow({
		name: "Gas",
		icon: "gas",
		color: "cat-slate",
		spentCents,
		budgetCents,
	}).toString();

describe("ProgressRow", () => {
	it("draws the limit notch at the icon stroke width", async () => {
		const notch = (await row(18600, 20000)).match(/<line[^>]*>/)?.[0];
		expect(notch).toContain('stroke-width="1.75"');
	});

	it("says over budget in words, not only color", async () => {
		expect(await row(18600, 20000)).not.toContain("over budget");
		expect(await row(28600, 25000)).toContain("over budget");
	});
});

/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import type { CategorySummary } from "../src/budget";
import { MonthEnd } from "../src/views/month-end";

const rows = (count: number): CategorySummary[] =>
	Array.from({ length: count }, (_, index) => ({
		id: index + 1,
		name: `Category ${index + 1}`,
		budgetCents: 10000,
		spentCents: 1010000,
		leftCents: -1000000,
		over: true,
	}));

describe("MonthEnd budget bars", () => {
	it.each([9, 12])("keeps %i bars and labels apart at 320px", (count) => {
		const html = renderToString(
			<MonthEnd monthName="September" amountCents={0} rows={rows(count)} />,
		);
		const chart = html.match(
			/<svg[^>]*aria-label="Spent against each budget:[\s\S]*?<\/svg>/,
		)?.[0];
		expect(chart).toBeDefined();
		expect(chart).toContain(`viewBox="0 0 350 ${Math.ceil(count / 5) * 142}"`);
		expect(chart).toContain('width="42"');
		expect(chart).toContain('<line x1="4" x2="292" y1="40" y2="40"');
		expect(chart).toContain('<text x="298" y="45"');
		expect(chart).toContain('y="22" width="42" height="90"');
		expect(chart).toContain('y="132"');
		const groups = [
			...(chart ?? "").matchAll(
				/<g transform="translate\(0 (\d+)\)">([\s\S]*?)<\/g>/g,
			),
		];
		expect(groups).toHaveLength(Math.ceil(count / 5));
		const xs = [...(chart ?? "").matchAll(/<rect x="([\d.]+)"/g)].map((match) =>
			Number(match[1]),
		);
		const labels = [
			...(chart ?? "").matchAll(/<text x="([\d.]+)" y="132"/g),
		].map((match) => Number(match[1]));
		const overLabels = [
			...(chart ?? "").matchAll(/<text x="([\d.]+)" y="16"/g),
		].map((match) => Number(match[1]));
		expect(xs).toHaveLength(count);
		expect(labels).toHaveLength(count);
		expect(overLabels).toHaveLength(count);
		for (let start = 0; start < count; start += 5) {
			const rowBars = xs.slice(start, start + 5);
			const rowLabels = labels.slice(start, start + 5);
			const rowOverLabels = overLabels.slice(start, start + 5);
			expect(rowBars.length).toBeLessThanOrEqual(5);
			expect(
				rowBars.every(
					(value, index) =>
						index === 0 || value - (rowBars[index - 1] ?? value) >= 42,
				),
			).toBe(true);
			expect(
				rowLabels.every(
					(value, index) =>
						index === 0 || value - (rowLabels[index - 1] ?? value) >= 42,
				),
			).toBe(true);
			expect(
				rowOverLabels.every(
					(value, index) =>
						index === 0 || value - (rowOverLabels[index - 1] ?? value) >= 61.5,
				),
			).toBe(true);
		}
	});
});

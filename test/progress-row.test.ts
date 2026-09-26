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

describe("ProgressRow in Adjust mode (#94)", () => {
	const adjusting = (spentCents: number, budgetCents: number) =>
		ProgressRow({
			name: "Gas",
			icon: "gas",
			color: "cat-slate",
			spentCents,
			budgetCents,
			href: "/budget/3",
			nudge: { href: "/budget/3/nudge", id: "nudge-3" },
		}).toString();

	it("puts a − before the row and a + after it, each a form that posts without JavaScript", async () => {
		const html = await adjusting(18600, 20000);
		expect(html).toMatch(
			/<form method="post" action="\/budget\/3\/nudge\/down"[^>]*>\s*<button type="submit" id="nudge-3-down"/,
		);
		expect(html).toMatch(
			/<form method="post" action="\/budget\/3\/nudge\/up"[^>]*>\s*<button type="submit" id="nudge-3-up"/,
		);
		expect(html.indexOf("nudge-3-down")).toBeLessThan(html.indexOf("<a "));
		expect(html.indexOf("nudge-3-up")).toBeGreaterThan(html.indexOf("</a>"));
	});

	it("says what each tap will do, to the next round $10", async () => {
		const html = await adjusting(18600, 71200);
		expect(html).toContain('aria-label="Lower Gas to $710"');
		expect(html).toContain('aria-label="Raise Gas to $720"');
	});

	it("turns − off at $0", async () => {
		const html = await adjusting(1200, 0);
		expect(html).toMatch(
			/<button type="submit" id="nudge-3-down"[^>]* disabled=""/,
		);
		expect(html).toContain('aria-label="Gas is at $0"');
		expect(html).not.toMatch(/id="nudge-3-up"[^>]* disabled=""/);
	});

	it("keeps the row a link to its sheet, for an exact amount", async () => {
		const html = await adjusting(18600, 20000);
		expect(html).toMatch(/<a href="\/budget\/3"/);
		expect(html).not.toMatch(/<a [^>]*>[\s\S]*<button[\s\S]*<\/a>/);
	});

	it("doesn't replay the bar's fill on each tap, so the list stays still", async () => {
		const html = await adjusting(18600, 20000);
		expect(html).not.toContain("bar-fill");
		expect(html).toContain('class="fill-ok"');
		expect(await row(18600, 20000)).toContain("bar-fill fill-ok");
	});

	it("on a phone, − takes the icon's place", async () => {
		expect(await adjusting(18600, 20000)).toMatch(
			/<span class="hidden sm:contents"><span class="shrink-0 text-cat-slate">/,
		);
		expect(await row(18600, 20000)).not.toContain("hidden sm:contents");
	});

	it("can put focus on one button, for when a tap turns the other off", async () => {
		const html = await ProgressRow({
			name: "Gas",
			icon: "gas",
			color: "cat-slate",
			spentCents: 0,
			budgetCents: 0,
			nudge: { href: "/budget/3/nudge", id: "nudge-3", focus: "up" },
		}).toString();
		expect(html).toMatch(/id="nudge-3-up"[^>]*autofocus/);
		expect(html).not.toMatch(/id="nudge-3-down"[^>]*autofocus/);
	});

	it("draws no buttons day to day", async () => {
		expect(await row(18600, 20000)).not.toContain("<button");
	});
});

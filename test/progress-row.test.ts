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

	it("$200.01 reads $0.01 over", async () => {
		const html = await row(20001, 20000);
		expect(html).toMatch(/\$0\.01 over<span class="sr-only"> budget<\/span>/);
		expect(html).toContain("fill-over");
		expect(html).not.toContain("fill-near-limit");
		expect(html).not.toContain("nearly spent");
	});

	it.each([
		[16000, 20000, true],
		[15999, 20000, false],
		[20000, 20000, true],
		[0, 0, false],
	])(
		"marks %i of %i with the nearly spent bar at the 80% line, and says so to screen readers",
		async (spent, budget, amber) => {
			const html = await row(spent, budget);
			expect(html.includes("fill-near-limit")).toBe(amber);
			expect(html.includes('<span class="sr-only">, nearly spent</span>')).toBe(
				amber,
			);
		},
	);

	it("keeps the bar green below 80% and brick above budget", async () => {
		expect(await row(15999, 20000)).toContain("fill-ok");
		expect(await row(20001, 20000)).toContain("fill-over");
	});

	it("shows a net refund in green with an empty bar and its budget under the name", async () => {
		const html = await row(-2000, 20000);
		expect(html).toMatch(/class="text-right text-lg text-ok">\+\$20/);
		expect(html).toContain(
			'+$20<span class="sr-only"> back: refunds outweigh spending</span>',
		);
		expect(html).not.toContain("nearly spent");
		expect(html).toMatch(/<rect width="0%"[^>]*class="bar-fill fill-ok"/);
		// P98: the budget stays visible under the name, as the drawing shows it.
		expect(html).toMatch(
			/<span class="block text-lg">Gas<\/span><span class="block text-muted">\$200 budget<\/span>/,
		);
		expect(html).not.toContain("of $200");
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
		expect(html).not.toContain("hx-disable");
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
		expect(html).toContain('class="fill-near-limit"');
		expect(html).toContain('<span class="sr-only">, nearly spent</span>');
		expect(await row(18600, 20000)).toContain("bar-fill fill-near-limit");
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

	it("keeps a net refund's budget under its name, and its empty bar, in Adjust mode too", async () => {
		const html = await adjusting(-2000, 20000);
		expect(html).toMatch(/class="text-right text-lg text-ok">\+\$20/);
		expect(html).toContain(
			'+$20<span class="sr-only"> back: refunds outweigh spending</span>',
		);
		expect(html).toMatch(/<rect width="0%"[^>]*class="fill-ok"/);
		expect(html).toMatch(
			/<span class="block text-lg">Gas<\/span><span class="block text-muted">\$200 budget<\/span>/,
		);
		expect(html).not.toContain("of $200");
	});
});

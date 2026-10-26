/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import {
	finishBillsLine,
	finishBudgetsLine,
	finishLead,
	finishPayLine,
	finishSavingsLine,
	SORTS_LINE,
} from "../src/first-tally/finish";
import { SetupFinish } from "../src/views/setup-finish";

// The setup finish (P142 A, decision 148, spec §8.8, #774): the step bar full, "You're set up.", the month's Safe to spend,
// what each step set up as ruled rows, and Go to Home at the foot. Drawn from the same words as the finish's own lines.

// Hono writes an apostrophe as &#39; and a negative Safe to spend with U+2212, so the markup is asserted as it is written.
const html = (node: unknown) => String(node);

/** The h1's opening tag, its text and whether it takes focus. */
const headingOf = (markup: string) => {
	const tag = markup.match(/<h1\b[^>]*>/)?.[0] ?? "";
	return {
		text: markup.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "",
		focused: /\sautofocus/.test(tag),
		tabindex: tag.match(/\stabindex="([^"]*)"/)?.[1],
		classes: tag.match(/\sclass="([^"]*)"/)?.[1] ?? "",
	};
};
/** Every id the markup draws. */
const idsOf = (markup: string) =>
	[...markup.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1] ?? "");
/** Each row of the What you set up list: its label and its values, in order. */
const rowsOf = (markup: string) =>
	[...markup.matchAll(/<div class="grid[^"]*">([\s\S]*?)<\/div>/g)].map(
		(match) => {
			const row = match[1] ?? "";
			return {
				label: row.match(/<dt\b[^>]*>([\s\S]*?)<\/dt>/)?.[1] ?? "",
				values: [...row.matchAll(/<dd\b[^>]*>([\s\S]*?)<\/dd>/g)].map(
					(dd) => dd[1] ?? "",
				),
			};
		},
	);
/** The h2 of the list, if drawn. */
const listHeadingOf = (markup: string) =>
	markup.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? null;

const EVERY_OTHER_FRIDAY = [
	"2026-07-17",
	"2026-07-31",
	"2026-08-14",
	"2026-08-28",
	"2026-09-11",
	"2026-09-25",
	"2026-10-09",
].map((date) => ({ date, cents: 245000 }));
const ACME = finishPayLine({
	name: "ACME Corp",
	deposits: EVERY_OTHER_FRIDAY,
});
const RIVERSIDE = finishPayLine({
	name: "Riverside Clinic",
	deposits: EVERY_OTHER_FRIDAY,
});

/** The finish with everything set up (the catalog's first state), overridden in part. */
const finish = (over: Partial<Parameters<typeof SetupFinish>[0]> = {}) =>
	html(
		SetupFinish({
			month: "2026-10",
			safeCents: 128400,
			rows: {
				pay: [ACME],
				bills: finishBillsLine(8, 124000),
				budgets: finishBudgetsLine(12, 405000),
				savings: finishSavingsLine(15000),
			},
			sortsOnArrival: true,
			focus: false,
			...over,
		}),
	);

describe("SetupFinish", () => {
	it("draws the step bar full, its words Setup done with all four segments inked", () => {
		const markup = finish();
		expect(markup).toContain("Setup done");
		expect(markup.split('class="h-1 rounded-full bg-ink"').length - 1).toBe(4);
		expect(markup).not.toContain("bg-ink/40");
		expect(markup).not.toContain("bg-rule");
	});

	it("draws the notebook beside the step bar as decoration, with no id of its own", () => {
		const markup = finish();
		expect(markup).toMatch(/<svg\b[^>]*aria-hidden="true"/);
		expect(idsOf(markup)).toEqual(["setup-screen", "setup-foot"]);
	});

	it("draws exactly one h1, You're set up., in the serif with the top margin the top row needs", () => {
		const markup = finish();
		expect(markup.match(/<h1\b/g)?.length).toBe(1);
		const heading = headingOf(markup);
		expect(heading.text).toBe("You&#39;re set up.");
		expect(heading.classes).toContain("mt-4");
		expect(heading.classes).not.toContain("mt-6");
		expect(heading.classes).toContain("font-serif");
		expect(heading.classes).toContain("text-4xl");
	});

	it("takes focus on the h1 only when focus is given, as a swap's redraw does", () => {
		const focused = headingOf(finish({ focus: true }));
		expect(focused.focused).toBe(true);
		expect(focused.tabindex).toBe("-1");
		const quiet = headingOf(finish({ focus: false }));
		expect(quiet.focused).toBe(false);
		expect(quiet.tabindex).toBeUndefined();
	});

	it("names the month's Safe to spend with the number in the serif, and the lead under it", () => {
		const markup = finish();
		expect(markup).toContain("Safe to spend in October");
		expect(markup).toContain("$1,284");
		expect(markup).toContain(finishLead("2026-10").replaceAll("'", "&#39;"));
	});

	it("keeps the minus sign of a negative Safe to spend, written as U+2212", () => {
		const markup = finish({ safeCents: -4500 });
		expect(markup).toContain("−$45");
		expect(markup).not.toContain("-$45");
	});

	it("draws What you set up as its h2 over the ruled list, in the order Pay, Bills, Budgets, Savings", () => {
		const markup = finish();
		expect(listHeadingOf(markup)).toBe("What you set up");
		expect(markup).toContain('<dl class="mt-2 border-t border-rule">');
		expect(rowsOf(markup).map((row) => row.label)).toEqual([
			"Pay",
			"Bills",
			"Budgets",
			"Savings",
		]);
		expect(rowsOf(markup)).toEqual([
			{ label: "Pay", values: [ACME] },
			{ label: "Bills", values: ["8 bills · $1,240 a month"] },
			{ label: "Budgets", values: ["12 budgets · $4,050 a month"] },
			{ label: "Savings", values: ["$150 a month"] },
		]);
	});

	it("leaves out the row of a step that set nothing, and keeps the others", () => {
		const markup = finish({
			rows: {
				pay: [ACME],
				bills: null,
				budgets: finishBudgetsLine(12, 405000),
				savings: null,
			},
		});
		expect(rowsOf(markup).map((row) => row.label)).toEqual(["Pay", "Budgets"]);
		expect(markup).not.toContain("<dt>Bills</dt>");
		expect(markup).not.toContain("<dt>Savings</dt>");
	});

	it("draws a Pay row with one dd per merchant, all in the one row", () => {
		const markup = finish({
			rows: {
				pay: [ACME, RIVERSIDE],
				bills: null,
				budgets: null,
				savings: null,
			},
		});
		expect(rowsOf(markup)).toEqual([
			{ label: "Pay", values: [ACME, RIVERSIDE] },
		]);
		expect(markup.match(/<dt\b/g)?.length).toBe(1);
	});

	it("draws no What you set up heading or list when no step set anything", () => {
		const markup = finish({
			rows: { pay: [], bills: null, budgets: null, savings: null },
		});
		expect(listHeadingOf(markup)).toBeNull();
		expect(markup).not.toContain("<dl");
		expect(markup).not.toContain("What you set up");
		expect(markup).toContain("You&#39;re set up.");
		expect(markup).toContain("Go to Home");
	});

	it("lays every row out as a grid, its label in column one and each value in column two", () => {
		const markup = finish();
		expect(markup).toContain(
			'<div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 border-b border-rule py-2">',
		);
		expect(markup).toContain('<dt class="col-start-1">Pay</dt>');
		expect(markup).toContain(
			`<dd class="col-start-2 text-right tabular-nums wrap-break-word">${ACME}</dd>`,
		);
	});

	it("wraps a long name at its words, breaking only a word too long for its line", () => {
		const markup = finish({
			rows: {
				pay: [
					finishPayLine({
						name: "STATEOFCALIFORNIAEMPLOYMENTDEVELOPMENTDEPT",
						deposits: EVERY_OTHER_FRIDAY,
					}),
				],
				bills: null,
				budgets: null,
				savings: null,
			},
		});
		expect(markup).toContain("wrap-break-word");
		expect(markup).not.toContain("wrap-anywhere");
	});

	it("says the sort line under Go to Home only while Sort right away is on", () => {
		const on = finish({ sortsOnArrival: true });
		expect(on).toContain(SORTS_LINE);
		expect(on).toContain(
			'<p class="mt-3 text-center text-sm text-muted">From now on Tally sorts new transactions as your bank sends them.</p>',
		);
		const off = finish({ sortsOnArrival: false });
		expect(off).not.toContain(SORTS_LINE);
		expect(off).not.toContain("From now on");
	});

	it("draws Go to Home as a full-width link to Home at the foot, with no Why? link and no check-in", () => {
		const markup = finish();
		expect(markup).toMatch(
			/<a\b[^>]*href="\/"[^>]*class="[^"]*w-full[^"]*"[^>]*>\s*Go to Home\s*<\/a>/,
		);
		expect(markup).toContain('id="setup-foot"');
		expect(markup).not.toContain("Why?");
		expect(markup).not.toContain("home-seen");
	});
});

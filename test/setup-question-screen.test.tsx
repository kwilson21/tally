/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import type { BillSuggestion } from "../src/bills/find";
import { keepHeading } from "../src/first-tally/bills";
import {
	askHeading,
	type BudgetAsk,
	keepAllQuestion,
} from "../src/first-tally/budgets";
import type {
	BudgetsStep,
	FirstPageModel,
	PayMerchant,
} from "../src/first-tally/first-page";
import { questionHeading, questionScreen } from "../src/routes/first-page";

// The screen a model draws at /setup (P142 A, decision 148, #773): the question its step asks, one screen at a time, and the
// heading each draws, which the in-place redraw announces. Each branch of questionScreen is drawn here.

const EVERY_OTHER_FRIDAY = ["2026-09-11", "2026-09-25", "2026-10-09"];
const PAY: PayMerchant = {
	key: "ACME CORP PAYROLL",
	name: "Acme Corp",
	deposits: EVERY_OTHER_FRIDAY.map((date) => ({ date, cents: 245000 })),
	ids: EVERY_OTHER_FRIDAY.map((_, i) => i + 1),
};

const charge = (name: string, amountCents: number, dueDay: number) =>
	({
		displayName: name,
		rawName: name.toUpperCase(),
		bankText: name.toUpperCase(),
		amountCents,
		dueDay,
		categoryId: 1,
		chargeCount: 2,
	}) as BillSuggestion;
const KEEP = [charge("Netflix", 1549, 5), charge("Spotify", 1199, 9)];
const WAITING = [charge("Gym", 4500, 3)];

const MONTHS = [
	{ month: "2026-08", spentCents: 61000 },
	{ month: "2026-09", spentCents: 67400 },
];
const GROCERIES: BudgetAsk = {
	id: 1,
	name: "Groceries",
	icon: "groceries",
	color: "cat-blue",
	months: MONTHS,
	suggestion: { amountCents: 65000, months: MONTHS },
};
const EATING: BudgetAsk = {
	id: 2,
	name: "Eating Out",
	icon: "eating-out",
	color: "cat-plum",
	months: MONTHS,
	suggestion: { amountCents: 15000, months: MONTHS },
};
const GAS: BudgetAsk = {
	id: 3,
	name: "Gas",
	icon: "gas",
	color: "cat-slate",
	months: [{ month: "2026-08", spentCents: 0 }],
	suggestion: null,
};

/** A model with nothing asked or answered: the pay, bills and budgets steps as the arguments say. */
const modelOf = (over: Partial<FirstPageModel> = {}): FirstPageModel => ({
	drawn: 2,
	head: null,
	ledger: [],
	payAnswered: false,
	pay: [],
	keep: [],
	waiting: [],
	budgets: null,
	budgetsAnswered: false,
	watching: false,
	...over,
});

/** A budgets step not yet done, with the asks and the flags given. */
const notDone = (over: Partial<Extract<BudgetsStep, { done: false }>> = {}) =>
	({
		done: false,
		month: "2026-10",
		asks: [GROCERIES],
		keepAllOpen: false,
		needs: null,
		firstDate: "2026-08-01",
		nothingAsked: null,
		...over,
	}) as BudgetsStep;

const render = (
	model: FirstPageModel,
	focus = false,
	over: {
		budgetError?: { text: string; typed: string } | null;
		savingsError?: { text: string; typed: string } | null;
	} = {},
) => String(questionScreen(model, { focus, ...over }));

/** The h1's words, or null when the screen draws no h1. */
const h1Of = (markup: string) =>
	markup.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1]?.replaceAll("&#39;", "'") ??
	null;
/** Whether the screen's h1 takes focus. */
const h1Focused = (markup: string) => /<h1\b[^>]*\sautofocus/.test(markup);

/** One model per question screen the page can draw. */
const SCREENS: { name: string; model: FirstPageModel }[] = [
	{ name: "pay", model: modelOf({ pay: [PAY] }) },
	{ name: "bills", model: modelOf({ keep: KEEP, payAnswered: true }) },
	{
		name: "keep all",
		model: modelOf({
			payAnswered: true,
			budgets: notDone({ asks: [GROCERIES, EATING], keepAllOpen: true }),
		}),
	},
	{
		name: "one at a time",
		model: modelOf({ payAnswered: true, budgets: notDone({ asks: [GAS] }) }),
	},
	{
		name: "savings",
		model: modelOf({ payAnswered: true, budgets: notDone({ asks: [] }) }),
	},
];

describe("questionScreen", () => {
	it("asks the pay question while a merchant is left, in its own form to /setup/pay", () => {
		const markup = render(modelOf({ pay: [PAY] }));
		expect(h1Of(markup)).toBe("Is this your pay?");
		expect(markup).toContain('action="/setup/pay"');
		expect(markup).toContain('id="setup-screen"');
	});

	it("asks the bills question while charges are kept, in its own form to /setup/bills", () => {
		const markup = render(modelOf({ keep: KEEP, payAnswered: true }));
		expect(h1Of(markup)).toBe(keepHeading(KEEP.length));
		expect(markup).toContain('action="/setup/bills"');
	});

	it("keeps all the suggestions while keep all is open, in its own form to /setup/budgets", () => {
		const markup = render(SCREENS[2]?.model as FirstPageModel);
		expect(h1Of(markup)).toBe(keepAllQuestion(2));
		expect(markup).toContain('action="/setup/budgets"');
		expect(markup).toContain("Go one at a time");
	});

	it("asks one category when keep all isn't open, with its question and no Keep all", () => {
		const markup = render(SCREENS[3]?.model as FirstPageModel);
		expect(h1Of(markup)).toBe(askHeading(GAS));
		expect(markup).not.toContain("Keep all");
	});

	it("asks the savings question once no category is left to ask", () => {
		const markup = render(SCREENS[4]?.model as FirstPageModel);
		expect(h1Of(markup)).toBe("Save some each month?");
		expect(markup).toContain('action="/setup/savings"');
	});

	it("draws the ruled-off total with no step bar once the budgets step is done", () => {
		const markup = render(
			modelOf({
				payAnswered: true,
				budgets: { done: true, safeCents: 70000, nothingAsked: null },
			}),
		);
		expect(markup).toContain('id="setup-screen"');
		expect(markup).toContain("Safe to spend");
		expect(markup).toContain("Go to Home");
		expect(markup).not.toContain("Step 4 of 4");
		expect(markup).not.toContain("<h1");
		expect(markup).not.toContain('id="setup-foot"');
	});

	it("draws the ruled-off total's reason above the rule, when the step asked nothing", () => {
		const markup = render(
			modelOf({
				payAnswered: true,
				budgets: {
					done: true,
					safeCents: 70000,
					nothingAsked: "every-category-budgeted",
				},
			}),
		);
		expect(markup).toContain("Every category already has a budget.");
	});

	it("draws no screen for a page with no budgets step read (the type's null, which settleAndLoad never leaves)", () => {
		expect(
			questionScreen(modelOf({ payAnswered: true }), { focus: false }),
		).toBeNull();
	});

	it("gives the heading the focus only when focus is given, on every question screen", () => {
		for (const { model } of SCREENS) {
			expect(h1Focused(render(model, true))).toBe(true);
			expect(h1Focused(render(model, false))).toBe(false);
		}
	});

	it("gives the ruled-off total's Safe to spend the focus when focus is given", () => {
		const done = modelOf({
			payAnswered: true,
			budgets: { done: true, safeCents: 70000, nothingAsked: null },
		});
		expect(render(done, true)).toMatch(/<p[^>]*\sautofocus/);
		expect(render(done, false)).not.toMatch(/<p[^>]*\sautofocus/);
	});

	it("moves the focus from a refused amount's heading to its field, as the one-at-a-time screen does", () => {
		const refused = render(SCREENS[3]?.model as FirstPageModel, true, {
			budgetError: {
				text: "Enter a dollar amount, like 250 or 250.50.",
				typed: "lots",
			},
		});
		expect(h1Focused(refused)).toBe(false);
		expect(refused).toMatch(/<input\b[^>]*\sautofocus/);
		expect(refused).toContain('value="lots"');
	});

	it("passes a refused Save it to the savings screen, with its words and the focus in its field", () => {
		const markup = render(SCREENS[4]?.model as FirstPageModel, true, {
			savingsError: {
				text: "Enter an amount greater than $0, or choose Not now.",
				typed: "",
			},
		});
		expect(markup).toContain(
			"Enter an amount greater than $0, or choose Not now.",
		);
		expect(markup).toContain('role="alert"');
		expect(h1Focused(markup)).toBe(false);
	});

	it("draws the presence check-in on every screen while the model is watching, and on none once it is not", () => {
		for (const { model } of SCREENS) {
			expect(render({ ...model, watching: true })).toContain('id="home-seen"');
			expect(render({ ...model, watching: false })).not.toContain(
				'id="home-seen"',
			);
		}
	});

	it("draws the pay note on the bills screen when pay asked nothing", () => {
		const markup = render(modelOf({ keep: KEEP }));
		expect(markup).toContain('<span class="text-ink">Your pay</span>');
		expect(markup).toContain("spot a paycheck.");
	});

	it("draws the bills note with its waiting count on the first budgets screen", () => {
		const markup = render(
			modelOf({
				payAnswered: true,
				waiting: WAITING,
				budgets: notDone({ asks: [GAS] }),
			}),
		);
		expect(markup).toContain("Your bills");
		expect(markup).toContain("1 more waits in");
		expect(markup).toContain('href="/bills/find"');
	});

	it("draws the savings screen's run of the steps that asked nothing, above its question", () => {
		const markup = render(
			modelOf({
				budgets: notDone({ asks: [], nothingAsked: "no-categories" }),
			}),
		);
		expect(markup).toContain("Your pay");
		expect(markup).toContain("Your bills");
		expect(markup).toContain("No categories to budget yet.");
		expect(markup.indexOf("No categories to budget yet.")).toBeLessThan(
			markup.indexOf("Save some each month?"),
		);
	});

	it("draws no notes on the pay screen or on the ruled-off total", () => {
		// A note names its step in ink, as the step bar's own label does not.
		const NOTE = (step: string) => `<span class="text-ink">${step}</span>`;
		expect(render(modelOf({ pay: [PAY] }))).not.toContain(NOTE("Your pay"));
		expect(
			render(
				modelOf({
					payAnswered: true,
					budgets: {
						done: true,
						safeCents: 1,
						nothingAsked: "no-categories",
					},
				}),
			),
		).not.toContain(NOTE("Your budgets"));
	});
});

describe("questionHeading", () => {
	it("names each question's heading, as the screen draws it", () => {
		expect(questionHeading(modelOf({ pay: [PAY] }))).toBe("Is this your pay?");
		expect(questionHeading(modelOf({ keep: KEEP }))).toBe(keepHeading(2));
		expect(questionHeading(SCREENS[2]?.model as FirstPageModel)).toBe(
			"Keep these budgets?",
		);
		expect(questionHeading(SCREENS[3]?.model as FirstPageModel)).toBe(
			"Do you want a Gas budget?",
		);
		expect(questionHeading(SCREENS[4]?.model as FirstPageModel)).toBe(
			"Save some each month?",
		);
	});

	it("counts keep all's heading over the suggestions it keeps, as the screen does", () => {
		const model = modelOf({
			payAnswered: true,
			budgets: notDone({ asks: [GROCERIES, GAS], keepAllOpen: true }),
		});
		expect(questionHeading(model)).toBe(keepAllQuestion(1));
		expect(h1Of(render(model))).toBe(keepAllQuestion(1));
	});

	it("is null for the ruled-off total and for a page with no budgets step", () => {
		expect(
			questionHeading(
				modelOf({
					payAnswered: true,
					budgets: { done: true, safeCents: 1, nothingAsked: null },
				}),
			),
		).toBeNull();
		expect(questionHeading(modelOf({ payAnswered: true }))).toBeNull();
	});

	it("is the h1 each question screen draws", () => {
		for (const { model } of SCREENS)
			expect(h1Of(render(model))).toBe(questionHeading(model));
	});
});

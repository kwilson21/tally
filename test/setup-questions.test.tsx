/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import type { BillSuggestion } from "../src/bills/find";
import { shownBillValue } from "../src/first-tally/bills";
import type { BudgetAsk } from "../src/first-tally/budgets";
import { askHeading, shownBudgetValue } from "../src/first-tally/budgets";
import type { PayMerchant } from "../src/first-tally/first-page";
import { shownPayValues } from "../src/first-tally/pay";
import {
	skippedBills,
	skippedBudgets,
	skippedPay,
} from "../src/first-tally/skipped";
import {
	SetupBills,
	SetupBudgets,
	SetupOneBudget,
	SetupPay,
	SetupSavings,
	SkippedSteps,
} from "../src/views/setup-questions";
import { BILLS_STEP, BUDGETS_STEP, PAY_STEP } from "../src/views/step-bar";

// The setup question screens (P142 A, decision 148, #773): each step's question as one screen, drawn from the same words,
// fields and answer rules as the question page (src/routes/first-page.tsx reads these fields and values).

const html = (node: unknown) => String(node).replaceAll("&#39;", "'");

/** Every form on the screen: its opening tag's attributes and its inner markup. */
const formsOf = (markup: string) =>
	[...markup.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map((match) => ({
		attrs: match[1] ?? "",
		body: match[2] ?? "",
	}));
/** One attribute of an opening tag's attributes, or undefined. */
const attr = (attrs: string, name: string) =>
	attrs.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
/** The hidden fields of a form's markup, as name and value pairs. */
const hiddenOf = (body: string) =>
	[...body.matchAll(/<input type="hidden"([^>]*)>/g)].map((match) => ({
		name: attr(match[1] ?? "", "name"),
		value: attr(match[1] ?? "", "value"),
	}));
/** Every button on the screen: its attributes and its text. */
const buttonsOf = (markup: string) =>
	[...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(
		(match) => ({
			attrs: match[1] ?? "",
			text: (match[2] ?? "").replace(/<[^>]+>/g, "").trim(),
		}),
	);
/** Every link that is drawn as a text button, by its text and href. */
const linksOf = (markup: string) =>
	[...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((match) => ({
		attrs: match[1] ?? "",
		text: (match[2] ?? "").replace(/<[^>]+>/g, "").trim(),
	}));
/** Every id the markup draws. */
const idsOf = (markup: string) =>
	[...markup.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1] ?? "");
/** The h1's opening tag, and whether it takes focus. */
const headingOf = (markup: string) => {
	const tag = markup.match(/<h1\b[^>]*>/)?.[0] ?? "";
	return {
		text: markup.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "",
		focused: /\sautofocus/.test(tag),
		tabindex: attr(tag.slice(3), "tabindex"),
	};
};
/** The field whose input is the one the markup marks with autofocus, or none. */
const focusedField = (markup: string) =>
	markup.match(/<input\b[^>]*\sautofocus[^>]*>/)?.[0] ?? null;

// Fixtures, in the FIRST_WEEK_* style of the catalog: Chase, October 2026, ACME CORP PAYROLL.
const EVERY_OTHER_FRIDAY = [
	"2026-07-17",
	"2026-07-31",
	"2026-08-14",
	"2026-08-28",
	"2026-09-11",
	"2026-09-25",
	"2026-10-09",
];
const PAY: PayMerchant = {
	key: "ACME CORP PAYROLL",
	name: "Acme Corp",
	deposits: EVERY_OTHER_FRIDAY.map((date) => ({ date, cents: 245000 })),
	ids: EVERY_OTHER_FRIDAY.map((_, i) => i + 1),
};
const ONE_PAY: PayMerchant = {
	key: "ACME CORP PAYROLL",
	name: "Acme Corp",
	deposits: [{ date: "2026-10-09", cents: 245000 }],
	ids: [7],
};

const charge = (
	over: Partial<BillSuggestion> & Pick<BillSuggestion, "displayName">,
): BillSuggestion => ({
	rawName: over.displayName?.toUpperCase() ?? "",
	bankText: over.displayName?.toUpperCase() ?? "",
	amountCents: 1000,
	dueDay: 5,
	categoryId: 1,
	chargeCount: 2,
	...over,
});
/** Eight charges Tally keeps in one tap: five shown and three folded. */
const KEEP: BillSuggestion[] = [
	charge({ displayName: "Netflix", amountCents: 1549, dueDay: 5 }),
	charge({ displayName: "Spotify", amountCents: 1199, dueDay: 9 }),
	charge({ displayName: "Phone", amountCents: 8500, dueDay: 12 }),
	charge({ displayName: "Internet", amountCents: 6500, dueDay: 20 }),
	charge({ displayName: "Car insurance", amountCents: 14000, dueDay: 14 }),
	charge({ displayName: "Water", amountCents: 1500, dueDay: 3 }),
	charge({ displayName: "Cloud storage", amountCents: 1600, dueDay: 17 }),
	charge({ displayName: "Magazine", amountCents: 1600, dueDay: 22 }),
];
const GYM = charge({ displayName: "Gym", amountCents: 4500, categoryId: null });

const MONTHS_AUG_SEP = [
	{ month: "2026-08", spentCents: 61000 },
	{ month: "2026-09", spentCents: 67400 },
];
const GROCERIES: BudgetAsk = {
	id: 1,
	name: "Groceries",
	icon: "groceries",
	color: "cat-blue",
	months: MONTHS_AUG_SEP,
	suggestion: { amountCents: 65000, months: MONTHS_AUG_SEP },
};
const GAS: BudgetAsk = {
	id: 3,
	name: "Gas",
	icon: "gas",
	color: "cat-slate",
	months: [
		{ month: "2026-08", spentCents: 0 },
		{ month: "2026-09", spentCents: 0 },
	],
	suggestion: null,
};
/** Twelve suggestions that sum to $4,050 a month: five shown, seven folded. */
const TWELVE: BudgetAsk[] = [
	[1, "Groceries", "groceries", "cat-blue", 65000],
	[2, "Eating Out", "eating-out", "cat-plum", 23000],
	[3, "Gas", "gas", "cat-slate", 17000],
	[4, "Kids", "kids", "cat-ochre", 29000],
	[5, "Car & Transport", "car", "cat-ochre", 34000],
	[6, "Utilities", "utilities", "cat-blue", 18000],
	[7, "Subscriptions", "subscriptions", "cat-plum", 6000],
	[8, "Shopping", "shopping", "cat-slate", 22000],
	[9, "Personal Care", "personal-care", "cat-ochre", 9000],
	[10, "Health", "health", "cat-brown", 12000],
	[11, "Entertainment", "entertainment", "cat-blue", 15000],
	[12, "Rent", "rent", "cat-brown", 155000],
].map(([id, name, icon, color, amountCents]) => ({
	id: id as number,
	name: name as string,
	icon: icon as string,
	color: color as string,
	months: MONTHS_AUG_SEP,
	suggestion: { amountCents: amountCents as number, months: MONTHS_AUG_SEP },
}));

describe("SetupPay", () => {
	const pay = (props: Partial<Parameters<typeof SetupPay>[0]> = {}) =>
		html(SetupPay({ merchant: PAY, focus: false, ...props }));

	it("draws the step bar, the question as the serif heading, and the lead Tally found", () => {
		const markup = pay();
		expect(markup).toContain(PAY_STEP);
		expect(PAY_STEP).toBe("Step 2 of 4 · Your pay");
		expect(headingOf(markup).text).toBe("Is this your pay?");
		expect(markup).toContain(
			'<h1 class="mt-6 font-serif text-4xl font-semibold tracking-tight">',
		);
		expect(markup).toContain(
			'<p class="mt-3 text-lg text-muted">Tally found money that comes in regularly from one place.</p>',
		);
	});

	it("draws the card: the bank's text, the amount, the cadence, the last three deposits and the earlier count", () => {
		const markup = pay();
		expect(markup).toContain('<p class="font-medium">ACME CORP PAYROLL</p>');
		expect(markup).toContain("$2,450");
		expect(markup).toContain("Every other Friday · 7 times since Jul 17");
		expect(markup).toContain("Fri, Oct 9");
		expect(markup).toContain("Fri, Sep 25");
		expect(markup).toContain("Fri, Sep 11");
		expect(markup).not.toContain("Fri, Aug 28");
		expect(markup).toContain("And 4 earlier");
		expect(markup).toContain("$2,450.00");
		expect(markup).toContain("Yes counts it as income, never as spending.");
	});

	it("draws one deposit as Once, on its day, with no earlier line", () => {
		const markup = pay({ merchant: ONE_PAY });
		expect(markup).toContain("Once, on Oct 9");
		expect(markup).not.toContain("earlier");
		expect(markup).toContain("Tally found money that comes in from one place.");
	});

	it("draws varying amounts as their range, and irregular dates with no cadence", () => {
		const dates = [
			"2026-07-03",
			"2026-07-29",
			"2026-08-21",
			"2026-09-04",
			"2026-09-30",
			"2026-10-02",
			"2026-10-09",
		];
		const cents = [230000, 240000, 260000, 250000, 245000, 255000, 235000];
		const merchant: PayMerchant = {
			...PAY,
			deposits: dates.map((date, i) => ({ date, cents: cents[i] ?? 0 })),
		};
		const markup = pay({ merchant });
		expect(markup).toContain("$2,300 to $2,600");
		expect(markup).toContain("7 times since Jul 3");
		expect(markup).not.toContain("Every");
	});

	it("gives its heading the focus only when focus is given", () => {
		expect(headingOf(pay()).focused).toBe(false);
		expect(headingOf(pay()).tabindex).toBeUndefined();
		const focused = headingOf(pay({ focus: true }));
		expect(focused.focused).toBe(true);
		expect(focused.tabindex).toBe("-1");
	});

	it("posts its answers to /setup/pay, swapping the whole screen, with the merchant and every deposit the page showed", () => {
		const [form] = formsOf(pay());
		expect(form).toBeDefined();
		expect(attr(form?.attrs ?? "", "method")).toBe("post");
		expect(attr(form?.attrs ?? "", "action")).toBe("/setup/pay");
		expect(attr(form?.attrs ?? "", "hx-post")).toBe("/setup/pay");
		expect(attr(form?.attrs ?? "", "hx-target")).toBe("#setup-screen");
		expect(attr(form?.attrs ?? "", "hx-swap")).toBe("outerHTML");
		// The fields first_tally's pay answer reads (routes/first-page.tsx: merchant, answer, deposit).
		const hidden = hiddenOf(form?.body ?? "");
		expect(hidden.filter((field) => field.name === "merchant")).toEqual([
			{ name: "merchant", value: "ACME CORP PAYROLL" },
		]);
		const deposits = hidden.filter((field) => field.name === "deposit");
		expect(deposits).toHaveLength(7);
		expect(deposits.map((field) => field.value)).toEqual(
			shownPayValues(PAY).map((value) => value.replaceAll('"', "&quot;")),
		);
	});

	it("answers Yes and No with name answer, in the screen's foot", () => {
		const markup = pay();
		const yes = buttonsOf(markup).find((b) => b.text === "Yes, that's my pay");
		const no = buttonsOf(markup).find(
			(b) => b.text === "No, it's something else",
		);
		expect(yes?.attrs).toContain('name="answer"');
		expect(yes?.attrs).toContain('value="yes"');
		expect(no?.attrs).toContain('name="answer"');
		expect(no?.attrs).toContain('value="no"');
		const [form] = formsOf(markup);
		expect(form?.body).toContain("Yes, that's my pay");
		expect(form?.body).toContain("No, it's something else");
	});

	it("draws the presence check-in only when watching is given", () => {
		expect(pay()).not.toContain('id="home-seen"');
		expect(pay({ watching: true })).toContain('id="home-seen"');
	});
});

describe("SetupBills", () => {
	const bills = (props: Partial<Parameters<typeof SetupBills>[0]> = {}) =>
		html(
			SetupBills({
				keep: KEEP,
				waiting: [GYM],
				focus: false,
				...props,
			}),
		);

	it("draws the step bar, the heading as today's words, and the lead", () => {
		const markup = bills();
		expect(markup).toContain(BILLS_STEP);
		expect(BILLS_STEP).toBe("Step 3 of 4 · Your bills");
		expect(headingOf(markup).text).toBe("Keep these 8 as bills?");
		expect(markup).toContain(
			'<p class="mt-3 text-lg text-muted">Tally found charges that come back every month.</p>',
		);
	});

	it("lists the first five charges with their days and amounts, and folds the rest with their total", () => {
		const markup = bills();
		const shown = markup.slice(0, markup.indexOf("<details"));
		expect(shown).toContain("around the 5th");
		expect(shown).toContain("around the 14th");
		expect(shown).toContain("$15.49");
		expect(shown).not.toContain("Magazine");
		expect(markup).toContain("3 more · $47 a month");
		expect(markup.slice(markup.indexOf("<details"))).toContain("Magazine");
	});

	it("draws the double-ruled total with the count and the monthly total", () => {
		const markup = bills();
		expect(markup).toContain(
			'<div class="mt-2 flex justify-between border-t-[3px] border-double border-ink pt-2 font-medium">',
		);
		expect(markup).toContain("8 bills");
		expect(markup).toContain("about $364 a month");
	});

	it("says what waits in Possible bills, as Waiting words it", () => {
		const markup = bills();
		expect(markup).toContain("1 more waits in");
		expect(markup).toContain('href="/bills/find"');
	});

	it("counts one charge with the singular words", () => {
		const markup = bills({ keep: [KEEP[0] as BillSuggestion], waiting: [] });
		expect(markup).toContain("Keep this one as a bill?");
		expect(markup).toContain(
			"Tally found a charge that comes back every month.",
		);
		expect(markup).toContain("1 bill");
		expect(markup).toContain("Keep this one");
		expect(markup).not.toContain("more ·");
	});

	it("posts Keep to /setup/bills with each shown charge as a keep field, and links Choose which", () => {
		const markup = bills();
		const [form] = formsOf(markup);
		expect(attr(form?.attrs ?? "", "action")).toBe("/setup/bills");
		expect(attr(form?.attrs ?? "", "hx-post")).toBe("/setup/bills");
		expect(attr(form?.attrs ?? "", "hx-target")).toBe("#setup-screen");
		expect(attr(form?.attrs ?? "", "hx-swap")).toBe("outerHTML");
		// The field the bills answer reads (routes/first-page.tsx: keep, one per charge the page showed).
		const keeps = hiddenOf(form?.body ?? "").filter((f) => f.name === "keep");
		expect(keeps).toHaveLength(8);
		expect(keeps[0]?.value).toBe(
			shownBillValue(KEEP[0] as BillSuggestion).replaceAll('"', "&quot;"),
		);
		expect(
			buttonsOf(markup).find((b) => b.text === "Keep these 8"),
		).toBeDefined();
		const choose = linksOf(markup).find((link) => link.text === "Choose which");
		expect(attr(choose?.attrs ?? "", "href")).toBe("/bills/find");
	});

	it("takes the focus on its heading only when focus is given", () => {
		expect(headingOf(bills()).focused).toBe(false);
		expect(headingOf(bills({ focus: true })).focused).toBe(true);
	});

	it("draws the skipped steps right under the step bar, when there are any", () => {
		const without = bills();
		expect(without).not.toContain("Your pay");
		const withSkipped = bills({ skipped: [skippedPay()] });
		expect(withSkipped.indexOf("Your pay")).toBeGreaterThan(
			withSkipped.indexOf(BILLS_STEP),
		);
		expect(withSkipped.indexOf("Your pay")).toBeLessThan(
			withSkipped.indexOf("Keep these 8 as bills?"),
		);
	});

	it("draws the check-in only when watching is given", () => {
		expect(bills()).not.toContain('id="home-seen"');
		expect(bills({ watching: true })).toContain('id="home-seen"');
	});
});

describe("SetupBudgets", () => {
	const budgets = (props: Partial<Parameters<typeof SetupBudgets>[0]> = {}) =>
		html(
			SetupBudgets({
				asks: TWELVE,
				month: "2026-10",
				needs: null,
				focus: false,
				...props,
			}),
		);

	it("draws the step bar, the keep all question, and P142's lead", () => {
		const markup = budgets();
		expect(markup).toContain(BUDGETS_STEP);
		expect(BUDGETS_STEP).toBe("Step 4 of 4 · Your budgets");
		expect(headingOf(markup).text).toBe("Keep these budgets?");
		expect(markup).toContain(
			'<p class="mt-3 text-muted">Each is what you spent in August and September, on average, rounded up to the next $10.</p>',
		);
	});

	it("lists the first five suggestions with their icon, months and amount, and folds the rest", () => {
		const markup = budgets();
		expect(markup).toContain("Aug $610 · Sep $674");
		expect(markup).toContain("Groceries");
		expect(markup).toContain("$650");
		expect(markup).toContain("7 more · $2,370 a month");
		expect(markup).toContain("Rent");
	});

	it("draws the total with twelve budgets and their monthly sum, and the warning about changing them", () => {
		const markup = budgets();
		expect(markup).toContain("12 budgets");
		expect(markup).toContain("$4,050 a month");
		expect(markup).toContain(
			"Once set, a budget can be changed on Home but not removed.",
		);
	});

	it("draws Needs a category under the total when there are some, with its count and mean", () => {
		expect(budgets()).not.toContain("Needs a category");
		const markup = budgets({ needs: { count: 86, meanCents: 32000 } });
		expect(markup).toContain(
			'href="/transactions?uncategorized=1&amp;month=all"',
		);
		expect(markup).toContain(
			">Needs a category</a> · 86 transactions · about $320 a month",
		);
	});

	it("posts Keep all to /setup/budgets with a keep field per suggestion and the month, and links Go one at a time", () => {
		const markup = budgets();
		const [form] = formsOf(markup);
		expect(attr(form?.attrs ?? "", "action")).toBe("/setup/budgets");
		expect(attr(form?.attrs ?? "", "hx-post")).toBe("/setup/budgets");
		expect(attr(form?.attrs ?? "", "hx-target")).toBe("#setup-screen");
		expect(attr(form?.attrs ?? "", "hx-swap")).toBe("outerHTML");
		const hidden = hiddenOf(form?.body ?? "");
		expect(hidden.filter((f) => f.name === "keep")).toHaveLength(12);
		expect(hidden).toContainEqual({
			name: "month",
			value: "2026-10",
		});
		expect(hidden.find((f) => f.name === "keep")?.value).toBe(
			shownBudgetValue(TWELVE[0] as BudgetAsk).replaceAll('"', "&quot;"),
		);
		const all = buttonsOf(markup).find((b) => b.text === "Keep all 12");
		expect(all?.attrs).toContain('name="answer"');
		expect(all?.attrs).toContain('value="all"');
		const one = linksOf(markup).find(
			(link) => link.text === "Go one at a time",
		);
		expect(attr(one?.attrs ?? "", "href")).toBe("/setup?budgets=one");
	});

	it("asks one suggestion in the singular, with its button and its total", () => {
		const markup = budgets({ asks: [GROCERIES] });
		expect(headingOf(markup).text).toBe("Keep this budget?");
		expect(
			buttonsOf(markup).find((b) => b.text === "Keep this budget"),
		).toBeDefined();
		expect(markup).toContain("1 budget");
		expect(markup).toContain("$650 a month");
		expect(markup).not.toContain("more ·");
	});

	it("draws the skipped steps under the step bar, the bills one with its Possible bills link", () => {
		const markup = budgets({
			skipped: [skippedPay(), skippedBills(1)],
		});
		expect(markup).toContain("Your pay");
		expect(markup).toContain("Your bills");
		expect(markup).toContain("1 more waits in");
		expect(markup.indexOf("Your pay")).toBeLessThan(
			markup.indexOf("Keep these budgets?"),
		);
	});

	it("takes focus on its heading only when focus is given", () => {
		expect(headingOf(budgets()).focused).toBe(false);
		expect(headingOf(budgets({ focus: true })).focused).toBe(true);
	});

	it("draws the check-in only when watching is given", () => {
		expect(budgets({ watching: true })).toContain('id="home-seen"');
	});
});

describe("SetupOneBudget", () => {
	const one = (props: Partial<Parameters<typeof SetupOneBudget>[0]> = {}) =>
		html(
			SetupOneBudget({
				ask: GROCERIES,
				month: "2026-10",
				needs: null,
				focus: false,
				error: null,
				amountOpen: false,
				...props,
			}),
		);

	it("asks the category's question with the bank's numbers, and the suggestion's note", () => {
		const markup = one();
		expect(headingOf(markup).text).toBe(
			"Make $650 a month your Groceries budget?",
		);
		expect(markup).toContain(
			"Your bank shows Groceries spent $610 in August and $674 in September.",
		);
		expect(markup).toContain(
			"Tally's suggestion: a typical month, rounded up to the next $10. From October on.",
		);
	});

	it("keeps Another amount in the body, closed, with its form and the amount field", () => {
		const markup = one();
		expect(markup).toContain("<details");
		expect(markup).not.toMatch(/<details[^>]* open/);
		expect(markup).toContain("Another amount");
		const [another] = formsOf(markup).filter((form) =>
			form.body.includes('name="budget"'),
		);
		expect(another?.body).toContain('value="another"');
		expect(markup).toContain("Save this budget");
		expect(markup).toMatch(/<input[^>]*id="budget-1"[^>]*name="budget"/);
		expect(markup).toContain('for="budget-1"');
		expect(markup).toContain("Groceries, a month");
		expect(markup).toContain('value="650.00"');
	});

	it("opens Another amount when it is asked to, and on a refused amount, which takes focus in the field", () => {
		expect(one({ amountOpen: true })).toMatch(/<details[^>]* open/);
		const refused = one({
			error: {
				text: "Enter a dollar amount, like 250 or 250.50.",
				typed: "lots",
			},
		});
		expect(refused).toMatch(/<details[^>]* open/);
		expect(refused).toContain('role="alert"');
		expect(refused).toContain("Enter a dollar amount, like 250 or 250.50.");
		expect(refused).toContain('value="lots"');
		expect(focusedField(refused)).toContain('id="budget-1"');
		expect(headingOf(refused).focused).toBe(false);
		expect(headingOf(one({ focus: true })).focused).toBe(true);
	});

	it("draws Yes with the suggested amount as the shown field, and Skip this one in a form of its own", () => {
		const markup = one();
		const forms = formsOf(markup);
		const yes = forms.find((form) => form.body.includes("Yes, $650"));
		expect(yes).toBeDefined();
		expect(attr(yes?.attrs ?? "", "action")).toBe("/setup/budgets");
		expect(attr(yes?.attrs ?? "", "hx-post")).toBe("/setup/budgets");
		expect(attr(yes?.attrs ?? "", "hx-target")).toBe("#setup-screen");
		expect(attr(yes?.attrs ?? "", "hx-swap")).toBe("outerHTML");
		const yesFields = hiddenOf(yes?.body ?? "");
		expect(yesFields).toEqual([
			{ name: "category", value: "1" },
			{ name: "month", value: "2026-10" },
			{ name: "shown", value: "65000" },
		]);
		expect(
			buttonsOf(markup).find((b) => b.text === "Yes, $650")?.attrs,
		).toContain('value="yes"');
		const skip = forms.find((form) => form.body.includes("Skip this one"));
		expect(skip).toBeDefined();
		expect(skip).not.toBe(yes);
		expect(hiddenOf(skip?.body ?? "")).toEqual([
			{ name: "category", value: "1" },
			{ name: "month", value: "2026-10" },
		]);
		expect(
			buttonsOf(markup).find((b) => b.text === "Skip this one")?.attrs,
		).toContain('value="skip"');
	});

	it("draws Save this budget in the body's form, with the typed amount and its own answer, when there is no suggestion", () => {
		const markup = one({ ask: GAS, error: null });
		expect(headingOf(markup).text).toBe("Do you want a Gas budget?");
		expect(markup).toContain(
			"Gas has no spending yet. Set a monthly budget, or skip it.",
		);
		expect(markup).not.toContain("<details");
		expect(markup).not.toContain("Yes, $");
		const [body, skip] = formsOf(markup);
		expect(attr(body?.attrs ?? "", "id")).toBe("one-budget");
		expect(hiddenOf(body?.body ?? "")).toEqual([
			{ name: "category", value: "3" },
			{ name: "month", value: "2026-10" },
		]);
		const save = buttonsOf(markup).find((b) => b.text === "Save this budget");
		expect(save?.attrs).toContain('form="one-budget"');
		expect(save?.attrs).toContain('name="answer"');
		expect(save?.attrs).toContain('value="another"');
		expect(hiddenOf(skip?.body ?? "")).toEqual([
			{ name: "category", value: "3" },
			{ name: "month", value: "2026-10" },
		]);
	});

	it("keeps what was typed in the amount field with no suggestion, and refuses it in place", () => {
		const markup = one({
			ask: GAS,
			error: {
				text: "Enter a dollar amount, like 250 or 250.50.",
				typed: "lots",
			},
		});
		expect(markup).toContain('value="lots"');
		expect(focusedField(markup)).toContain('id="budget-3"');
		expect(headingOf(markup).focused).toBe(false);
	});

	it("draws Needs a category under the question when there are some", () => {
		expect(one()).not.toContain("Needs a category");
		expect(one({ needs: { count: 86, meanCents: 32000 } })).toContain(
			">Needs a category</a> · 86 transactions · about $320 a month",
		);
	});

	it("ids its own form and field with the id suffix, so each catalog state points at its own", () => {
		const markup = one({ idSuffix: "amount" });
		expect(idsOf(markup).filter((id) => id !== "")).toEqual(
			expect.arrayContaining(["budget-1amount"]),
		);
		expect(markup).toContain('for="budget-1amount"');
		const blank = one({ ask: GAS, idSuffix: "gas" });
		expect(blank).toContain('id="one-budgetgas"');
		expect(blank).toContain('form="one-budgetgas"');
		expect(blank).toContain('id="budget-3gas"');
	});

	it("draws the check-in only when watching is given", () => {
		expect(one()).not.toContain('id="home-seen"');
		expect(one({ watching: true })).toContain('id="home-seen"');
	});

	it("draws no skipped steps by default", () => {
		expect(one()).not.toContain("Your pay");
	});

	it("draws the skipped steps right under its step bar, as the keep all screen does (#773)", () => {
		const markup = one({ skipped: [skippedPay(), skippedBills(2)] });
		expect(markup).toContain("Your pay");
		expect(markup).toContain("Your bills");
		expect(markup).toContain("2 more wait in");
		const bar = markup.indexOf(BUDGETS_STEP);
		expect(bar).toBeGreaterThanOrEqual(0);
		expect(markup.indexOf("Your pay")).toBeGreaterThan(bar);
		expect(markup.indexOf("Your pay")).toBeLessThan(
			markup.indexOf(askHeading(GROCERIES)),
		);
	});
});

describe("SetupSavings", () => {
	const savings = (props: Partial<Parameters<typeof SetupSavings>[0]> = {}) =>
		html(
			SetupSavings({
				month: "2026-10",
				focus: false,
				error: null,
				...props,
			}),
		);

	it("asks Save some each month? with its lead, the money input from the month on, and its two answers", () => {
		const markup = savings();
		expect(markup).toContain(BUDGETS_STEP);
		expect(headingOf(markup).text).toBe("Save some each month?");
		expect(markup).toContain(
			"Safe to spend sets it aside from the 1st, before anything else. You can change it on Home any time.",
		);
		expect(markup).toContain("Save each month, from October on");
		expect(markup).toMatch(/<input[^>]*id="first-savings"[^>]*name="goal"/);
		expect(markup).toContain('for="first-savings"');
		const [body, notNow] = formsOf(markup);
		expect(attr(body?.attrs ?? "", "id")).toBe("savings");
		expect(attr(body?.attrs ?? "", "action")).toBe("/setup/savings");
		expect(attr(body?.attrs ?? "", "hx-post")).toBe("/setup/savings");
		expect(attr(body?.attrs ?? "", "hx-target")).toBe("#setup-screen");
		expect(attr(body?.attrs ?? "", "hx-swap")).toBe("outerHTML");
		expect(hiddenOf(body?.body ?? "")).toEqual([
			{ name: "month", value: "2026-10" },
		]);
		expect(hiddenOf(notNow?.body ?? "")).toEqual([
			{ name: "month", value: "2026-10" },
		]);
		const save = buttonsOf(markup).find((b) => b.text === "Save it");
		expect(save?.attrs).toContain('form="savings"');
		expect(save?.attrs).toContain('name="answer"');
		expect(save?.attrs).toContain('value="save"');
		const skip = buttonsOf(markup).find((b) => b.text === "Not now");
		expect(skip?.attrs).toContain('name="answer"');
		expect(skip?.attrs).toContain('value="skip"');
	});

	it("keeps a refused amount in the field under its error, and takes focus there rather than on the heading", () => {
		const refused = savings({
			error: {
				text: "Enter an amount greater than $0, or choose Not now.",
				typed: "0",
			},
		});
		expect(refused).toContain(
			"Enter an amount greater than $0, or choose Not now.",
		);
		expect(refused).toContain('value="0"');
		expect(focusedField(refused)).toContain('id="first-savings"');
		expect(headingOf(refused).focused).toBe(false);
		expect(headingOf(savings({ focus: true })).focused).toBe(true);
	});

	it("says why the budgets step asked nothing above the question, when given", () => {
		const markup = savings({
			skipped: [skippedBudgets("every-category-budgeted")],
		});
		expect(markup).toContain("Your budgets");
		expect(markup).toContain("Every category already has a budget.");
		expect(markup.indexOf("Every category already has a budget.")).toBeLessThan(
			markup.indexOf("Save some each month?"),
		);
	});

	it("ids the form and the field with the suffix", () => {
		const markup = savings({ idSuffix: "after" });
		expect(markup).toContain('id="savingsafter"');
		expect(markup).toContain('form="savingsafter"');
		expect(markup).toContain('id="first-savingsafter"');
		expect(markup).toContain('for="first-savingsafter"');
	});

	it("draws the check-in only when watching is given", () => {
		expect(savings({ watching: true })).toContain('id="home-seen"');
	});
});

describe("SkippedSteps", () => {
	it("draws nothing with no notes", () => {
		expect(SkippedSteps({ notes: [] })).toBeNull();
	});

	it("names each step in ink, then its words, and the waiting count with the Possible bills link when some wait", () => {
		const markup = html(
			SkippedSteps({ notes: [skippedPay(), skippedBills(2)] }),
		);
		expect(markup).toContain('<ul class="mt-4 space-y-1 text-sm text-muted">');
		expect(markup).toContain('<span class="text-ink">Your pay</span>');
		expect(markup).toContain('<span class="text-ink">Your bills</span>');
		expect(markup).toContain("Nothing here to keep in one tap. 2 more wait in");
		expect(markup).toContain(">Possible bills</a>.");
		expect(markup).toContain('href="/bills/find"');
	});

	it("draws no waiting words and no link for a note with nothing waiting", () => {
		const markup = html(SkippedSteps({ notes: [skippedPay()] }));
		expect(markup).not.toContain("Possible bills");
		expect(markup).not.toContain("waits in");
		expect(markup).not.toContain("wait in");
	});

	it("draws one li per note", () => {
		const markup = html(
			SkippedSteps({
				notes: [skippedPay(), skippedBills(1), skippedBudgets("no-categories")],
			}),
		);
		expect(markup.match(/<li\b/g)).toHaveLength(3);
	});
});

describe("ids and form references across the screens", () => {
	/** Every screen drawn with the given suffix, in the states that draw forms and fields. */
	const screens = (suffix: string) => [
		html(SetupPay({ merchant: PAY, focus: false, idSuffix: suffix })),
		html(
			SetupBills({
				keep: KEEP,
				waiting: [GYM],
				focus: false,
				idSuffix: suffix,
			}),
		),
		html(
			SetupBudgets({
				asks: TWELVE,
				month: "2026-10",
				needs: null,
				focus: false,
				idSuffix: suffix,
			}),
		),
		html(
			SetupOneBudget({
				ask: GROCERIES,
				month: "2026-10",
				needs: null,
				focus: false,
				error: null,
				amountOpen: false,
				idSuffix: suffix,
			}),
		),
		html(
			SetupOneBudget({
				ask: GAS,
				month: "2026-10",
				needs: null,
				focus: false,
				error: null,
				amountOpen: false,
				idSuffix: suffix,
			}),
		),
		html(
			SetupSavings({
				month: "2026-10",
				focus: false,
				error: null,
				idSuffix: suffix,
			}),
		),
	];

	it("gives every id a screen draws the suffix, so two catalog states on one page don't repeat an id", () => {
		for (const markup of screens("state2")) {
			for (const id of idsOf(markup)) {
				if (id.startsWith("setup-") || id === "home-seen") continue;
				expect(id.endsWith("state2")).toBe(true);
			}
		}
	});

	it("draws the plain ids when no suffix is given, so the page's own ids are the plain ones", () => {
		const [pay, , budgets, oneBudget, , savings] = screens("");
		expect(idsOf(pay ?? "")).toContain("pay");
		expect(idsOf(budgets ?? "")).toContain("budgets");
		expect(idsOf(oneBudget ?? "")).toContain("budget-1");
		expect(idsOf(savings ?? "")).toContain("savings");
		expect(idsOf(savings ?? "")).toContain("first-savings");
	});

	it("points every form= attribute at a form with that id, in every screen", () => {
		for (const markup of screens("x")) {
			const formIds = idsOf(markup);
			for (const [, target] of markup.matchAll(/\sform="([^"]*)"/g)) {
				expect(formIds).toContain(target);
			}
		}
	});

	it("keeps each screen's answers in the foot, after the body", () => {
		const pay = html(SetupPay({ merchant: PAY, focus: false }));
		expect(pay.indexOf("Is this your pay?")).toBeLessThan(
			pay.indexOf('id="setup-foot"'),
		);
		expect(pay.slice(pay.indexOf('id="setup-foot"'))).toContain(
			"Yes, that's my pay",
		);
		const one = html(
			SetupOneBudget({
				ask: GROCERIES,
				month: "2026-10",
				needs: null,
				focus: false,
				error: null,
				amountOpen: false,
			}),
		);
		expect(one.slice(one.indexOf('id="setup-foot"'))).toContain("Yes, $650");
	});
});

/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import type { NeverSuggestRule } from "../src/db/never-suggest";
import type { SuggestionItem } from "../src/db/suggestions-queue";
import { NeverSuggestList } from "../src/views/merchant-rules";
import { AskFirst, SuggestionCard } from "../src/views/suggestion-review";

// #460: while an answer on the review screen runs, every answer button on the screen is disabled, and a
// second answer sent meanwhile is dropped by the screen's one request queue, so a double click or a
// second key press can't queue a second answer. Each Never suggest Remove on Settings disables only its
// own line's button while its request runs.

const ANSWER_GUARD = 'hx-disable="#suggestions-page button[type=submit]"';
const ANSWER_SYNC = 'hx-sync="#suggestions-page:drop"';
const REMOVE_GUARD = 'hx-disable="findAll button[type=submit]"';
const PATH = "/settings/suggestions";
const TODAY = "2026-10-11";

/** The forms that post, each as its whole markup. */
const postingForms = (html: string) =>
	[
		...html.matchAll(/<form\b[^>]*\bhx-post="[^"]+"[^>]*>[\s\S]*?<\/form>/g),
	].map((match) => match[0]);

const income: SuggestionItem = {
	kind: "income",
	id: "income-1",
	transactionId: 1,
	date: "2026-10-02",
	amountCents: -250000,
	bankText: "VENMO PAYMENT",
	merchantKey: "VENMO",
	merchant: "Venmo",
	label: "Venmo",
	sure: 52,
	categoryId: null,
	category: null,
};

const transfer: SuggestionItem = {
	kind: "transfer",
	id: "transfer-2",
	transactionId: 2,
	date: "2026-10-02",
	amountCents: 20000,
	bankText: "CHASE CARD PAYMENT",
	merchantKey: "CHASE CARD PAYMENT",
	merchant: "Chase card payment",
	label: "Chase card payment",
	sure: 50,
	categoryId: null,
	category: null,
};

const category: SuggestionItem = {
	kind: "category",
	id: "category-3",
	transactionId: 3,
	date: "2026-10-02",
	amountCents: 2300,
	bankText: "SQ *LUPITAS TAQ 2210",
	merchantKey: "SQ *LUPITAS TAQ 2210",
	merchant: "Lupita's Taqueria",
	label: "Lupita's Taqueria",
	sure: 64,
	categoryId: 2,
	category: "Eating Out",
};

const newCategory: SuggestionItem = {
	kind: "new_category",
	id: "new-4",
	suggestionId: 4,
	name: "Pet Care",
	existing: null,
	date: "2026-10-02",
	rows: [
		{
			transactionId: 5,
			date: "2026-10-02",
			amountCents: 4500,
			merchantKey: "CHEWY.COM 1",
			merchant: "Chewy",
			label: "Chewy",
		},
	],
	stores: [{ merchantKey: "CHEWY.COM 1", merchant: "Chewy" }],
};

const name: SuggestionItem = {
	kind: "name",
	id: "name-8",
	rowId: 8,
	merchantKey: "BLUE BOTTLE COF",
	date: "2026-10-02",
	totalCents: 1950,
	review: {
		key: "BLUE BOTTLE COF",
		id: 8,
		bankText: "SQ *BLUE BOTTLE COF 0412",
		tidied: "Blue bottle cof 0412",
		names: ["Blue Bottle Coffee"],
		source: "tally",
		count: 3,
		owned: 0,
	},
};

const card = (item: SuggestionItem) =>
	String(
		SuggestionCard({
			action: PATH,
			item,
			today: TODAY,
			skipHref: `${PATH}?skip=${item.id}`,
			categories: [{ id: 2, name: "Eating Out" }],
		}),
	);

const neverLine: NeverSuggestRule = {
	id: 7,
	merchantKey: "VENMO",
	merchant: "Venmo",
	kind: "income",
	decidedOn: "2026-10-03",
};

describe("the answer forms disable their submit buttons while a request runs (#460)", () => {
	const answers = [ANSWER_GUARD, ANSWER_SYNC];
	it.each<[string, string, number, string[]]>([
		["an income question", card(income), 1, answers],
		["a transfer question", card(transfer), 1, answers],
		["a category guess", card(category), 2, answers],
		["a new category", card(newCategory), 1, answers],
		["a name", card(name), 2, answers],
		[
			"the question after a No",
			String(
				AskFirst({
					action: PATH,
					kind: "income",
					id: "income-1",
					stores: [{ merchantKey: "VENMO", label: "Venmo" }],
					check: "Not counted as income",
				}),
			),
			1,
			answers,
		],
		[
			"a Never suggest Remove on Settings",
			String(
				NeverSuggestList({
					rules: [neverLine],
					today: TODAY,
					target: "merchant-rules",
				}),
			),
			1,
			[REMOVE_GUARD],
		],
	])(
		"%s: every form that posts carries its guards",
		(_label, html, count, guards) => {
			const forms = postingForms(html);
			expect(forms).toHaveLength(count);
			for (const form of forms)
				for (const guard of guards) expect(form).toContain(guard);
		},
	);

	it("leaves Skip a plain link, with no guard", () => {
		const skip = card(category).match(/<a\b[^>]*>\s*Skip\s*<\/a>/)?.[0];
		expect(skip).toBeDefined();
		expect(skip).not.toContain("hx-disable");
		expect(skip).not.toContain("hx-post");
	});
});

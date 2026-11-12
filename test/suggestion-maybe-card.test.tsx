/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import type { SuggestionItem } from "../src/db/suggestions-queue";
import { SuggestionCard } from "../src/views/suggestion-review";

// The Maybe card's three answers, in order (decision 156): Yes, the dashed "New category" row, then Something else's
// one select. The row is drawn only once Tally has a name, and it opens in place with the name editable.

const PATH = "/settings/suggestions";

const audible: SuggestionItem = {
	kind: "category",
	id: "category-9",
	transactionId: 9,
	date: "2026-10-02",
	amountCents: 1499,
	bankText: "AUDIBLE*TE3E10I7 WA",
	merchantKey: "AUDIBLE*TE3E10I7 WA",
	merchant: "Audible",
	label: "Audible",
	sure: 58,
	categoryId: 4,
	category: "Entertainment",
};

const categories = [
	{ id: 4, name: "Entertainment" },
	{ id: 2, name: "Eating Out" },
];

const card = (extra: Partial<Parameters<typeof SuggestionCard>[0]> = {}) =>
	String(
		SuggestionCard({
			action: PATH,
			item: audible,
			today: "2026-10-11",
			skipHref: `${PATH}?skip=category-9`,
			categories,
			...extra,
		}),
	);

describe("the Maybe card's three answers, in order (decision 156)", () => {
	it("draws Yes, then the dashed suggestion row, then Something else", () => {
		const html = card({ suggestedName: "Books & audio" });
		const yes = html.indexOf('value="yes"');
		const row = html.indexOf("New category:");
		const else_ = html.indexOf("Something else");
		expect(yes).toBeGreaterThan(-1);
		expect(row).toBeGreaterThan(yes);
		expect(else_).toBeGreaterThan(row);
	});

	it("draws the row dashed, with its name and no visible label, and Tally's suggestion as its accessible name (decision 166)", () => {
		const html = card({ suggestedName: "Books & audio" });
		expect(html).toMatch(/<details[^>]*border-dashed[^>]*>/);
		expect(html).toContain("New category: Books &amp; audio");
		// The visible small label is gone; screen readers still hear whose suggestion it is.
		expect(html).toContain(
			'<span class="sr-only">Tally&#39;s suggestion: </span>',
		);
		expect(html).not.toMatch(/text-muted">Tally&#39;s suggestion</);
	});

	it("opens the row in place with the name in a labelled, editable field and Create and next", () => {
		const html = card({ suggestedName: "Books & audio" });
		expect(html).toContain('<label for="new-category-name-category-9"');
		expect(html).toContain("New category name</label>");
		expect(html).toContain('name="new_name"');
		expect(html).toContain('value="Books &amp; audio"');
		expect(html).toMatch(
			/<button[^>]*name="answer"[^>]*value="create"[^>]*>\s*Create and next/,
		);
	});

	it("draws no row at all when Tally has no name, and asks for none without a loader address", () => {
		const html = card();
		expect(html).not.toContain("Tally&#39;s suggestion");
		expect(html).not.toContain("New category:");
		expect(html).not.toContain('hx-trigger="load"');
		expect(html).not.toContain('id="new-category-name-category-9"');
	});

	it("loads the name in place, from its address, when Tally has not asked yet", () => {
		const html = card({
			suggestUrl: `${PATH}/new-category?id=category-9&skip=income-1`,
		});

		expect(html).toContain('hx-trigger="load"');
		expect(html).toContain(
			`hx-get="${PATH}/new-category?id=category-9&amp;skip=income-1"`,
		);
		expect(html).not.toContain("Tally&#39;s suggestion");
	});

	it("keeps the typed name in the row, open, when the answer was refused", () => {
		const html = card({
			suggestedName: "Books & audio",
			values: { id: "category-9", newName: "Books and audio" },
			error: "Give the category a name.",
		});

		expect(html).toContain('value="Books and audio"');
		expect(html).toMatch(/<details[^>]*border-dashed[^>]*\bopen/);
		expect(html).toContain('role="alert"');
	});

	it("Something else holds one select with a real label and a blank first option", () => {
		const html = card();
		expect(html).toContain('<label for="category-choice-category-9"');
		expect(html).toContain("Choose a category</label>");
		expect(html).toMatch(
			/<select[^>]*id="category-choice-category-9"[^>]*name="category"/,
		);
		expect(html).toMatch(/<option value=""><\/option>/);
		expect(html).toContain('<option value="4">Entertainment</option>');
		expect(html).not.toContain('type="radio"');
	});

	it("keeps the Maybe tag and the guess above all three answers", () => {
		const html = card({ suggestedName: "Books & audio" });
		expect(html.indexOf("Maybe Entertainment")).toBeLessThan(
			html.indexOf('value="yes"'),
		);
		expect(html.indexOf("Tally&#39;s guess")).toBeLessThan(
			html.indexOf('value="yes"'),
		);
	});

	it("gives each card's fields their own ids, so two cards on one catalog page don't share a label", () => {
		const html = card({ suggestedName: "Books & audio", fieldId: "state-2" });
		expect(html).toContain('id="new-category-name-state-2"');
		expect(html).toContain('id="category-choice-state-2"');
		expect(html).not.toContain('id="new-category-name-category-9"');
	});
});

// Decision 165 (as amended by #965): a suggested name the family already has as an active category is one tap, "Put it in
// {name}", with no name field: it files the purchase in that category by its id. A name that is not one of them keeps the
// dashed "New category" row, whose field is labelled "New category name" and whose button reads "Create and next".
describe("an existing category: one tap, no name field (decision 165, #965)", () => {
	const withBooks = [...categories, { id: 7, name: "Books & media" }];

	it("draws one tap, Put it in the family's spelling, with its id in a hidden field, and no details or name field for it", () => {
		const html = card({
			suggestedName: "books & MEDIA",
			categories: withBooks,
		});

		expect(html).toContain("Put it in Books &amp; media");
		expect(html).toContain('<input type="hidden" name="category" value="7"');
		expect(html).toMatch(
			/<button[^>]*name="answer"[^>]*value="create"[^>]*>[\s\S]*Put it in Books &amp; media/,
		);
		expect(html).toContain("Tally&#39;s suggestion: ");
		expect(html).not.toContain("New category:");
		expect(html).not.toContain("Existing category");
		expect(html).not.toContain("Create and next");
		expect(html).not.toMatch(/value="create"[^>]*>\s*Save and next/);
		expect(html).not.toMatch(/<details[^>]*border-dashed/);
	});

	it("draws the one tap before Something else and inside the card's answer form", () => {
		const html = card({
			suggestedName: "Books & media",
			categories: withBooks,
		});

		const tap = html.indexOf("Put it in");
		expect(tap).toBeGreaterThan(html.indexOf('value="yes"'));
		expect(tap).toBeLessThan(html.indexOf("Something else"));
		expect(html.slice(html.lastIndexOf("<form", tap), tap)).toContain(
			'name="id" value="category-9"',
		);
	});

	it("opens Something else with both fields when the suggestion is an existing category, and no error is shown", () => {
		const html = card({
			suggestedName: "Books & media",
			categories: withBooks,
			values: { id: "category-9", elseName: "" },
		});

		expect(html).toMatch(/<details[^>]*border-rule[^>]*\bopen\b/);
		expect(html).toContain('<label for="category-choice-category-9"');
		expect(html).toContain('<label for="else-new-name-category-9"');
	});

	it("reads New category and Create and next for a name the family does not have", () => {
		const html = card({
			suggestedName: "Books & audio",
			categories: withBooks,
		});

		expect(html).toContain("New category: Books &amp; audio");
		expect(html).not.toContain("Put it in");
		expect(html).toMatch(
			/<button[^>]*name="answer"[^>]*value="create"[^>]*>\s*Create and next/,
		);
	});

	it("keeps a typed name that the family already has in the editable new row, not the one tap", () => {
		const html = card({
			suggestedName: "Books & media",
			categories: withBooks,
			values: { id: "category-9", newName: "books & MEDIA" },
		});

		expect(html).toContain('value="books &amp; MEDIA"');
		expect(html).toContain("New category: books &amp; MEDIA");
		expect(html).not.toContain("Put it in");
		expect(html).toContain("Create and next");
	});
});

// Something else on a category guess holds the choice and, when the card shows no new-category row, a second field to make
// one (#965). The wrapper is always drawn so the lazy answer can empty it out of band.
describe("Something else on a category guess: choose one, or make one (#965)", () => {
	it("draws the Or make a new category field, labelled, when the card has no new row yet", () => {
		const html = card();

		expect(html).toContain('<div id="else-new-category-9">');
		expect(html).toContain('<label for="else-new-name-category-9"');
		expect(html).toContain("Or make a new category</label>");
		expect(html).toMatch(
			/<input[^>]*id="else-new-name-category-9"[^>]*name="new_name"/,
		);
	});

	it("draws the new-name field with a length limit and no autocomplete, on paper", () => {
		const html = card();

		expect(html).toMatch(
			/<input[^>]*name="new_name"[^>]*maxlength="40"[^>]*autocomplete="off"/,
		);
	});

	it("draws an empty wrapper, and no field, when the card shows the new row", () => {
		const html = card({ suggestedName: "Books & audio" });

		expect(html).toContain('<div id="else-new-category-9"></div>');
		expect(html).not.toContain('id="else-new-name-category-9"');
	});

	it("keeps the field when the suggestion is the guess itself, which draws no row", () => {
		const html = card({ suggestedName: "Entertainment" });

		expect(html).toContain('id="else-new-name-category-9"');
	});

	it("opens on a refused typed name, keeps it in the field, and names the error on that field", () => {
		const html = card({
			values: {
				id: "category-9",
				elseName: "Books and audio",
				elseNameError: "Keep the name to 40 characters.",
			},
		});

		expect(html).toMatch(/<details[^>]*border-rule[^>]*\bopen\b/);
		expect(html).toContain('value="Books and audio"');
		expect(html).toContain('aria-invalid="true"');
		expect(html).toContain('id="else-new-name-category-9-error"');
	});

	it("keeps the chosen category selected when both fields were given", () => {
		const html = card({
			values: { id: "category-9", elseName: "Brunch", elseCategory: "2" },
			error: "Choose a category or type a new name, not both.",
		});

		expect(html).toMatch(/<option value="2"[^>]*\bselected\b[^>]*>Eating Out/);
		expect(html).toContain('value="Brunch"');
	});

	it("draws no loader on a card whose refused name is on screen, so the lazy answer cannot empty it", () => {
		const html = card({
			suggestUrl: `${PATH}/new-category?id=category-9`,
			values: { id: "category-9", elseName: "Brunch" },
		});

		expect(html).not.toContain('hx-trigger="load"');
		expect(html).toContain('value="Brunch"');
	});

	it("still draws the loader when no name is known yet, with the field open to type into", () => {
		const html = card({ suggestUrl: `${PATH}/new-category?id=category-9` });

		expect(html).toContain('hx-trigger="load"');
		expect(html).toContain('id="else-new-name-category-9"');
	});
});

// Decision 166: a suggested name that is the card's own guess (the Maybe category) is not offered as a row, since Yes
// already files the purchase there. A different category, or a new name, shows its row as before.
describe("the suggestion row is not shown when it is the guess's own category (decision 166)", () => {
	const shopping = { ...audible, category: "Shopping", categoryId: 9 };
	const withBooks = [...categories, { id: 7, name: "Books & media" }];

	it("hides the row when the suggested name is the guess, in any case, and still draws Yes", () => {
		for (const name of ["Entertainment", "entertainment", "  ENTERTAINMENT "]) {
			const html = card({ suggestedName: name });
			expect(html).not.toContain("Tally&#39;s suggestion");
			expect(html).not.toContain("New category");
			expect(html).not.toContain("Existing category");
			expect(html).toContain('id="else-new-name-category-9"');
			expect(html).toContain("Yes, Entertainment");
		}
	});

	it("draws no loader either when the pending name is the guess, so nothing asks for it", () => {
		const html = card({
			suggestedName: "Entertainment",
			suggestUrl: `${PATH}/new-category?id=category-9`,
		});

		expect(html).not.toContain('hx-trigger="load"');
		expect(html).toContain("Yes, Entertainment");
	});

	it("still shows the row, as Existing category, for an active category that is not the guess", () => {
		const html = card({
			item: shopping,
			suggestedName: "Books & media",
			categories: withBooks,
		});

		expect(html).toContain("Tally&#39;s suggestion: ");
		expect(html).toContain("Put it in Books &amp; media");
		expect(html).toContain("Yes, Shopping");
	});

	it("still shows the row, as New category, for a new name", () => {
		const html = card({ item: shopping, suggestedName: "Books & audio" });
		expect(html).toContain("New category: Books &amp; audio");
		expect(html).toContain("Create and next");
		expect(html).toContain("Yes, Shopping");
	});

	it("keeps a typed name on screen even when it is the guess, since the person typed it", () => {
		const html = card({
			suggestedName: "Entertainment",
			values: { id: "category-9", newName: "Entertainment" },
			error: "Give the category a name.",
		});

		expect(html).toContain('name="new_name"');
	});
});

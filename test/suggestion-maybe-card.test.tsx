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
		const row = html.indexOf("Tally&#39;s suggestion");
		const else_ = html.indexOf("Something else");
		expect(yes).toBeGreaterThan(-1);
		expect(row).toBeGreaterThan(yes);
		expect(else_).toBeGreaterThan(row);
	});

	it("draws the row dashed, labelled Tally's suggestion, with its name", () => {
		const html = card({ suggestedName: "Books & audio" });
		expect(html).toMatch(/<details[^>]*border-dashed[^>]*>/);
		expect(html).toContain("Tally&#39;s suggestion");
		expect(html).toContain("New category: Books &amp; audio");
	});

	it("opens the row in place with the name in a labelled, editable field and Create and next", () => {
		const html = card({ suggestedName: "Books & audio" });
		expect(html).toContain('<label for="new-category-name-category-9"');
		expect(html).toContain("Category name</label>");
		expect(html).toContain('name="new_name"');
		expect(html).toContain('value="Books &amp; audio"');
		expect(html).toMatch(
			/<button[^>]*name="answer"[^>]*value="create"[^>]*>\s*Create and next/,
		);
	});

	it("draws no row at all when Tally has no name, and asks for none without a loader address", () => {
		const html = card();
		expect(html).not.toContain("Tally&#39;s suggestion");
		expect(html).not.toContain('hx-trigger="load"');
		expect(html).not.toContain('name="new_name"');
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

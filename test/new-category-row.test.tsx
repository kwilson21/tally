/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { NewCategoryRow } from "../src/views/suggestion-review";

// A rejected create (decision 156) reopens the dashed row with its name in the field, and the field names the
// message that says why it was refused: aria-invalid on the input and aria-describedby pointing at the alert.

const row = (extra: Partial<Parameters<typeof NewCategoryRow>[0]> = {}) =>
	String(
		NewCategoryRow({
			action: "/settings/suggestions",
			itemId: "category-9",
			fieldId: "category-9",
			name: "",
			open: true,
			...extra,
		}),
	);

describe("NewCategoryRow: a refused name is named by its field", () => {
	it("marks the name field invalid and points it at the message", () => {
		const html = row({ error: "Give the category a name." });
		expect(html).toContain('aria-invalid="true"');
		const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1] ?? "";
		expect(describedBy).toContain("new-category-name-category-9-error");
		expect(html).toMatch(
			/<p id="new-category-name-category-9-error" role="alert"[^>]*>Give the category a name\.<\/p>/,
		);
	});

	it("draws no invalid mark and no message while the name is fine", () => {
		const html = row({ name: "Books & audio" });
		expect(html).not.toContain("aria-invalid");
		expect(html).not.toContain("-error");
	});

	it("keeps the typed name in the field and the row open", () => {
		const html = row({
			name: "Books and audio",
			error: "Keep the name to 40 characters.",
		});

		expect(html).toMatch(/<details[^>]*\bopen/);
		expect(html).toContain('value="Books and audio"');
	});
});

describe("NewCategoryRow: the field only ever says new (#965)", () => {
	it("labels the name field New category name, with the hint that says what happens", () => {
		const html = row({ name: "Pet Care" });
		expect(html).toContain('<label for="new-category-name-category-9"');
		expect(html).toContain("New category name</label>");
		expect(html).toContain(
			"Added to your categories and used for this transaction.",
		);
		expect(html).not.toContain("Category name</label>");
	});

	it("says Create and next, never Save and next", () => {
		const html = row({ name: "Pet Care" });
		expect(html).toMatch(
			/<button[^>]*name="answer"[^>]*value="create"[^>]*>\s*Create and next/,
		);
		expect(html).not.toContain("Save and next");
	});
});

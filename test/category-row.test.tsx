/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { AddCategoryRow, CategoryRow } from "../src/views/category-row";

const groceries = {
	id: 1,
	name: "Groceries",
	icon: "groceries",
	color: "cat-blue",
	budgetCents: 70000,
};
const gas = { ...groceries, id: 3, name: "Gas", budgetCents: null };

/** One row, as the Settings list draws it: the route passes first and last from the list's position. */
const row = (props: Partial<Parameters<typeof CategoryRow>[0]> = {}) =>
	renderToString(
		<CategoryRow
			category={groceries}
			first={false}
			last={false}
			open={false}
			focus={false}
			{...props}
		/>,
	);

/** The row's opening <details> tag, to read whether it is open. */
const detailsTag = (html: string) => html.match(/<details[^>]*>/)?.[0] ?? "";

describe("CategoryRow, closed", () => {
	it("shows the icon, the name, this month's budget and a chevron", () => {
		const html = row();
		expect(detailsTag(html)).toContain('data-row="1"');
		expect(detailsTag(html)).not.toMatch(/\sopen(\s|>|=)/);
		expect(html).toContain('data-category="1"');
		// The category's own icon, then the chevron.
		expect(html).toContain(">Groceries</span>");
		expect(html).toContain('id="cat-1-amount"');
		expect(html).toContain("$700");
		expect(html).toContain('<span class="text-muted"> a month</span>');
		expect(html).toContain('data-icon="chevron-right"');
	});

	it("says No budget when the category has none this month", () => {
		const html = row({ category: gas, first: true, last: true });
		expect(html).toContain('<span class="text-muted">No budget</span>');
		expect(html).not.toContain("a month");
		expect(html).toContain('id="cat-3-budget-note"');
		expect(html).toContain("No budget yet. ");
		expect(html).toContain(">Add one on Home</a>");
	});

	it("carries the month's changes out of band only when the household moved into another month", () => {
		expect(row()).not.toContain("hx-swap-oob");
		const html = row({ budgetsOob: true });
		expect(html.match(/hx-swap-oob="true"/g)).toHaveLength(2);
		expect(html).toMatch(
			/<span\s[^>]*id="cat-1-amount"[^>]*hx-swap-oob="true"/,
		);
		expect(html).toMatch(
			/<p\s[^>]*id="cat-1-budget-note"[^>]*hx-swap-oob="true"/,
		);
	});
});

describe("CategoryRow, open", () => {
	it("opens with its Name field, Save, Cancel, Archive and both moves in the middle of the list", () => {
		const html = row({ open: true });
		expect(detailsTag(html)).toMatch(/\sopen(\s|>|=)/);
		expect(html).toContain('id="cat-1-form"');
		expect(html).toContain('<label for="c1-name"');
		expect(html).toContain('value="Groceries"');
		expect(html).toContain('id="cat-1-save"');
		expect(html).toContain(">Save</span>");
		expect(html).toContain(">Cancel</a>");
		expect(html).toContain('id="cat-1-archive"');
		expect(html).toContain(">Archive</span>");
		expect(html).toContain('id="cat-1-move-up"');
		expect(html).toContain('id="cat-1-move-down"');
		expect(html).toContain("Move up");
		expect(html).toContain("Move down");
	});

	it("has no Move up on the first row, and Move down stays", () => {
		const html = row({ open: true, first: true });
		expect(html).not.toContain('id="cat-1-move-up"');
		expect(html).not.toContain("Move up");
		expect(html).toContain('id="cat-1-move-down"');
	});

	it("has no Move down on the last row, and Move up stays", () => {
		const html = row({ open: true, last: true });
		expect(html).not.toContain('id="cat-1-move-down"');
		expect(html).not.toContain("Move down");
		expect(html).toContain('id="cat-1-move-up"');
	});

	it("has neither move on the only row", () => {
		const html = row({ open: true, first: true, last: true });
		expect(html).not.toContain("Move up");
		expect(html).not.toContain("Move down");
		expect(html).toContain(">Archive</span>");
	});

	it("posts its form to its own address, and points the Archive and moves at it", () => {
		const html = row({ open: true });
		expect(html).toContain('action="/settings/categories/1"');
		expect(html).toContain('hx-post="/settings/categories/1"');
		expect(html).toContain('formaction="/settings/categories/1/archive"');
		expect(html).toContain('formaction="/settings/categories/1/move/up"');
		expect(html).toContain('formaction="/settings/categories/1/move/down"');
	});

	it("shows what was typed, and its name error in role=alert with focus on the field", () => {
		const html = row({
			open: true,
			values: { name: "" },
			errors: { name: "Give the category a name." },
		});
		expect(html).toMatch(
			/<p\s[^>]*role="alert"[^>]*>Give the category a name\.<\/p>/,
		);
		expect(html).toContain('aria-invalid="true"');
		expect(html).toMatch(/<input[^>]*id="c1-name"[^>]*autofocus/);
		expect(html).not.toContain('value="Groceries"');
	});

	it("keeps its saved name and no error while closed, whatever was typed in another row", () => {
		const html = row({
			values: { name: "Typed" },
			errors: { name: "Give the category a name." },
		});
		expect(detailsTag(html)).not.toMatch(/\sopen(\s|>|=)/);
		expect(html).not.toContain("Typed");
		expect(html).not.toContain('role="alert"');
		expect(html).toContain('value="Groceries"');
	});

	it("takes focus on its summary after a swap, unless there is an error", () => {
		expect(row({ focus: true })).toMatch(
			/<summary[^>]*autofocus[^>]*data-category="1"|<summary[^>]*data-category="1"[^>]*autofocus/,
		);
		expect(row()).not.toMatch(/<summary[^>]*autofocus/);
	});
});

describe("AddCategoryRow", () => {
	it("is closed as an Add category disclosure with a plus", () => {
		const html = renderToString(<AddCategoryRow open={false} />);
		expect(html).toContain('data-row="new"');
		expect(html).not.toMatch(/<details[^>]*\sopen(\s|>|=)/);
		expect(html).toContain('data-icon="plus"');
		expect(html).toContain("text-accent");
		expect(html).toContain("Add category");
	});

	it("opens with its Name field and an Add category button, and a name error in role=alert", () => {
		const html = renderToString(
			<AddCategoryRow
				open
				values={{ name: "Pets" }}
				errors={{ name: "That name is taken." }}
			/>,
		);
		expect(html).toMatch(/<details[^>]*\sopen(\s|>|=)/);
		expect(html).toContain('id="new-category-form"');
		expect(html).toContain('<label for="new-name"');
		expect(html).toContain('value="Pets"');
		expect(html).toMatch(
			/<p\s[^>]*role="alert"[^>]*>That name is taken\.<\/p>/,
		);
		expect(html).toContain('id="new-category-save"');
		expect(html).toContain(">Add category</span>");
	});

	it("shows an empty name when it is closed, even with values left over", () => {
		const html = renderToString(
			<AddCategoryRow open={false} values={{ name: "Pets" }} />,
		);
		expect(html).not.toContain('value="Pets"');
	});
});

describe("CategoryRow's swaps", () => {
	it("swaps the whole Categories section, and the Band above it, as the list always has", () => {
		const html = row({ open: true });
		expect(html).toContain('hx-target="#categories"');
		expect(html).toContain('hx-select="#categories"');
		expect(html).toContain('hx-select-oob="#names-band"');
	});
});

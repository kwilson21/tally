/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import designMd from "../DESIGN.md?raw";
import css from "../src/styles/app.css?raw";
import { CategoryGrid } from "../src/views/category-grid";
import { Chip } from "../src/views/chip";
import { FilterSelect } from "../src/views/filter-select";
import { MaybeCategory, MaybeIncome } from "../src/views/maybe-category";
import { SelectField } from "../src/views/select-field";

// Every source file that draws a native select or a date input, read as text for the guardrail below.
const SOURCES = import.meta.glob(
	["../src/views/*.tsx", "../src/routes/*.tsx"],
	{ query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const OPTIONS = [
	{ value: "1", label: "Groceries" },
	{ value: "2", label: "Eating Out" },
];

describe("no mid-word wraps", () => {
	it("a checkbox or radio Chip wraps only between words", () => {
		for (const type of ["radio", "checkbox"] as const) {
			const html = renderToString(
				<Chip type={type} name="category" value="1" dashed>
					Shopping · Suggested
				</Chip>,
			);
			expect(html).not.toContain("wrap-anywhere");
			expect(html).toContain("break-normal");
			expect(html).toContain("whitespace-normal");
		}
	});

	it("a Maybe tag wraps between words and is never truncated", () => {
		const html = renderToString(
			<MaybeCategory name="Household and garden supplies" kind="category" />,
		);
		expect(html).not.toContain("wrap-anywhere");
		expect(html).not.toContain("truncate");
		expect(html).toContain("whitespace-normal break-normal");
		expect(renderToString(<MaybeIncome />)).not.toContain("truncate");
	});

	it("the suggested category cell spans both grid columns", () => {
		const html = renderToString(
			<CategoryGrid
				categories={[{ id: 1, name: "Groceries", icon: "cart", color: "blue" }]}
				leading={<span>Shopping · Suggested</span>}
			/>,
		);
		expect(html).toContain('<div class="col-span-2 min-w-0"><span>Shopping');
	});
});

describe("SelectField", () => {
	it("draws its own centred chevron, which takes no clicks and is hidden from screen readers", () => {
		const html = renderToString(
			<SelectField name="month" id="month" options={OPTIONS} variant="pill" />,
		);
		expect(html).toContain("appearance-none");
		expect(html).toMatch(
			/<svg [^>]*data-icon="chevron"[^>]*aria-hidden="true"|<svg [^>]*aria-hidden="true"[^>]*data-icon="chevron"/,
		);
		expect(html).toContain("pointer-events-none");
		expect(html).toContain("top-1/2");
		expect(html).toContain("-translate-y-1/2");
		expect(html).toContain("rounded-full");
	});

	it("keeps the chevron at the same inset as the pill's text padding", () => {
		const html = renderToString(
			<SelectField name="month" id="month" options={OPTIONS} variant="pill" />,
		);
		expect(html).toContain("pl-4");
		expect(html).toContain("right-4");
	});

	it("keeps the real select with its name first, so the DueRow markup still reads it", () => {
		const html = renderToString(
			<SelectField
				name="due_day"
				id="due-day"
				options={OPTIONS}
				variant="ledger"
			/>,
		);
		expect(html).toMatch(/<select name="due_day"/);
		expect(html).toContain("border-b");
		expect(html).not.toContain("rounded-full");
	});

	it("is what FilterSelect draws, with no bare native select", () => {
		const html = renderToString(
			<FilterSelect
				id="month"
				name="month"
				label="Month"
				options={OPTIONS}
				selected="1"
			/>,
		);
		expect(html).toContain("appearance-none");
		expect(html).toContain("data-select-field");
		expect(html).not.toContain("wrap-anywhere");
	});
});

describe("guardrails", () => {
	it("no view or route draws a native select outside SelectField", () => {
		const offenders = Object.entries(SOURCES)
			.filter(([path]) => !path.endsWith("/select-field.tsx"))
			.filter(([, source]) => /<select[\s>]/.test(source))
			.map(([path]) => path);
		expect(offenders).toEqual([]);
	});

	it("no view or route draws a wrap-anywhere class on a chip, select or Maybe tag", () => {
		for (const path of [
			"../src/views/chip.tsx",
			"../src/views/maybe-category.tsx",
			"../src/views/filter-select.tsx",
			"../src/views/select-field.tsx",
			"../src/views/category-grid.tsx",
		]) {
			expect(SOURCES[path] ?? "").not.toContain("wrap-anywhere");
		}
	});

	it("the date inputs' calendar icon is centred and inset by a base-layer rule", () => {
		expect(css).toMatch(/@layer base \{[\s\S]*input\[type="date"\][\s\S]*\}/);
		expect(css).toContain("::-webkit-calendar-picker-indicator");
		expect(css).toMatch(
			/::-webkit-calendar-picker-indicator \{[^}]*position: absolute;[^}]*top: 50%;/,
		);
	});

	it("DESIGN.md states the rule", () => {
		expect(designMd).toContain("No mid-word wraps");
		expect(designMd).toContain("no native select arrows or date icons");
		expect(designMd).toContain("gap under a dashed underline");
	});
});

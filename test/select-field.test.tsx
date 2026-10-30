/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import designMd from "../DESIGN.md?raw";
import css from "../src/styles/app.css?raw";
import { CategoryGrid } from "../src/views/category-grid";
import { Chip } from "../src/views/chip";
import { DueRow } from "../src/views/due-row";
import { FilterSelect } from "../src/views/filter-select";
import { MaybeCategory, MaybeIncome } from "../src/views/maybe-category";
import { SelectField } from "../src/views/select-field";
import { TextInput } from "../src/views/text-input";

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

	it("a Maybe tag wraps between words and never breaks mid-word", () => {
		const html = renderToString(
			<MaybeCategory name="Household and garden supplies" kind="category" />,
		);
		expect(html).not.toContain("wrap-anywhere");
		expect(html).not.toContain("truncate");
		expect(html).toContain("whitespace-normal break-normal");
		expect(renderToString(<MaybeIncome />)).not.toContain("truncate");
	});

	it("a Maybe tag ends one too-long word in an ellipsis inside the tag", () => {
		const html = renderToString(
			<MaybeCategory
				name="Householdandgardensuppliesandmore"
				kind="category"
			/>,
		);
		expect(html).toContain(
			'<span class="min-w-0 overflow-hidden text-ellipsis">Maybe Householdandgardensuppliesandmore</span>',
		);
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

	it("fills its wrapper, and the wrapper takes its parent's width, so the chevron stays at the select's edge", () => {
		// The wrapper is never self-start: in a stretched flex column it takes the column's width, and the select (w-full)
		// fills the wrapper, so the chevron sits at the select's right edge. In a content-sized row both shrink to fit.
		const html = renderToString(
			<div class="flex flex-col gap-1">
				<SelectField name="month" id="month" options={OPTIONS} variant="pill" />
			</div>,
		);
		expect(html).toMatch(/<select [^>]*class="(?:[^"]* )?w-full(?: [^"]*)?"/);
		expect(html).not.toMatch(
			/<span data-select-field="" class="[^"]*\bself-start\b/,
		);
		expect(html).toMatch(
			/<span data-select-field="" class="[^"]*\bmax-w-full\b/,
		);
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

// Tailwind's spacing scale: px-N and pl-N are N x 0.25rem.
const rem = (n: string) => `${Number(n) * 0.25}rem`;
// The class list of the date input in a render, whatever order its attributes come in.
const dateClass = (html: string) =>
	html
		.match(/<input\b[^>]*\btype="date"[^>]*>/)?.[0]
		.match(/class="([^"]*)"/)?.[1];

describe("the arrow and the date icon sit at their variant's text inset", () => {
	it.each(["pill", "control", "ledger"] as const)(
		"%s: the arrow's right inset equals the text's left padding",
		(variant) => {
			const html = renderToString(
				<SelectField name="x" id="x" options={OPTIONS} variant={variant} />,
			);
			const padding = html.match(/\bpl-(\d+)\b/)?.[1];
			const inset = html.match(/\bright-(\d+)\b/)?.[1];
			expect(padding).toBeDefined();
			expect(inset).toBe(padding);
		},
	);

	it("the native date input's calendar icon uses --field-inset, which the base layer defaults to 0.75rem", () => {
		expect(css).toMatch(
			/::-webkit-calendar-picker-indicator \{[^}]*right: var\(--field-inset\);/,
		);
		expect(css).toMatch(/input\[type="date"\] \{[^}]*--field-inset: 0\.75rem;/);
	});

	it("a TextInput date (px-3) has the default inset", () => {
		const html = renderToString(
			<TextInput id="d" name="date" label="Date" type="date" surface="paper" />,
		);
		const input = dateClass(html);
		const padding = input?.match(/\bpx-(\d+)\b/)?.[1];
		expect(padding).toBeDefined();
		expect(rem(padding ?? "")).toBe("0.75rem");
	});

	it("DueRow's ledger date (px-1) sets its own --field-inset to match", () => {
		const html = renderToString(<DueRow frequency="monthly" dueDay={1} />);
		const input = dateClass(html);
		const padding = input?.match(/\bpx-(\d+)\b/)?.[1];
		const inset = input?.match(/--field-inset:([\d.]+rem)/)?.[1];
		expect(padding).toBeDefined();
		expect(inset).toBe(rem(padding ?? ""));
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

	it("a fieldset may shrink to its column, so one long word in a chip stays inside its group", () => {
		// A fieldset's default minimum width is its content's; a long unbroken word would widen the group past the sheet.
		expect(css).toMatch(/\bfieldset \{\s*min-width: 0;/);
	});

	it("DESIGN.md states the rule", () => {
		expect(designMd).toContain("No mid-word wraps");
		expect(designMd).toContain("no native select arrows or date icons");
		expect(designMd).toContain("gap under a dashed underline");
	});
});

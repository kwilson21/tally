/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import billsSource from "../src/routes/bills.tsx?raw";
import css from "../src/styles/app.css?raw";
import { DueRow } from "../src/views/due-row";

const selectOf = (html: string, name: string) =>
	html.match(
		new RegExp(`<select name="${name}"[^>]*>[\\s\\S]*?</select>`),
	)?.[0] ?? "";

describe("DueRow", () => {
	it("reads a monthly bill as Due on the 1st every month, with those pickers selected", () => {
		const html = renderToString(<DueRow frequency="monthly" dueDay={1} />);
		expect(html).toContain('<span class="due-lead-the">Due on the</span>');
		const day = selectOf(html, "due_day");
		expect(day).toContain('aria-label="Day of the month"');
		expect(day).toContain('<option value="1" selected="">1st</option>');
		const frequency = selectOf(html, "frequency");
		expect(frequency).toContain(
			'<option value="monthly" selected="">every month</option>',
		);
	});

	it("reads a weekly bill as Due on Fridays every week, with Friday selected for due day 5", () => {
		const html = renderToString(<DueRow frequency="weekly" dueDay={5} />);
		expect(html).toContain('<span class="due-lead-on">Due on</span>');
		const weekday = selectOf(html, "weekly_day");
		expect(weekday).toContain('aria-label="Day of the week"');
		expect(weekday).toContain('<option value="5" selected="">Fridays</option>');
		expect(weekday).toContain('<option value="1">Mondays</option>');
		expect(weekday).toContain('<option value="7">Sundays</option>');
		expect(selectOf(html, "frequency")).toContain(
			'<option value="weekly" selected="">every week</option>',
		);
	});

	it("reads an every-two-weeks bill as Due on a date picker every two weeks, with its date", () => {
		const html = renderToString(
			<DueRow frequency="biweekly" dueDay={1} anchorDate="2026-10-03" />,
		);
		expect(html).toContain('<span class="due-lead-on">Due on</span>');
		expect(html).toMatch(
			/<input type="date" name="anchor_date" value="2026-10-03" aria-label="One date it's due"|<input type="date" name="anchor_date"[^>]*value="2026-10-03"[^>]*aria-label="One date it(?:'|&#39;)s due"/,
		);
		expect(selectOf(html, "frequency")).toContain(
			'<option value="biweekly" selected="">every two weeks</option>',
		);
	});

	it("reads a quarterly bill as Due on the 15th every quarter, starting in January", () => {
		const html = renderToString(
			<DueRow frequency="quarterly" dueDay={15} anchorMonth={1} />,
		);
		expect(html).toContain('<span class="due-quarter-word">starting in</span>');
		expect(html).toContain('<option value="15" selected="">15th</option>');
		expect(selectOf(html, "anchor_month")).toContain(
			'<option value="1" selected="">January</option>',
		);
		expect(selectOf(html, "frequency")).toContain(
			'<option value="quarterly" selected="">every quarter</option>',
		);
	});

	it("reads a yearly bill as Due on the 14th every year, in March", () => {
		const html = renderToString(
			<DueRow frequency="yearly" dueDay={14} anchorMonth={3} />,
		);
		expect(html).toContain('<span class="due-year-word">in</span>');
		expect(html).toContain('<option value="14" selected="">14th</option>');
		expect(selectOf(html, "anchor_month")).toContain(
			'<option value="3" selected="">March</option>',
		);
		expect(selectOf(html, "frequency")).toContain(
			'<option value="yearly" selected="">every year</option>',
		);
	});

	it("carries every frequency's pickers, so the form posts the chosen one's fields", () => {
		const html = renderToString(
			<DueRow frequency="monthly" dueDay={1} anchorMonth={1} />,
		);
		for (const name of [
			"due_day",
			"weekly_day",
			"anchor_date",
			"anchor_month",
			"frequency",
		]) {
			expect(html).toContain(`name="${name}"`);
		}
		const frequency = selectOf(html, "frequency");
		expect(
			[...frequency.matchAll(/<option value="([a-z]+)"/g)].map((m) => m[1]),
		).toEqual(["weekly", "biweekly", "monthly", "quarterly", "yearly"]);
	});

	it("uses the field names and values the Add a bill handler reads today", () => {
		// The form's weekday posts as weekly_day for a weekly bill, and bills.tsx reads it so.
		expect(billsSource).toContain(
			'raw("frequency") === "weekly" ? "weekly_day" : "due_day"',
		);
		for (const name of ["anchor_month", "anchor_date", "frequency"]) {
			expect(billsSource).toContain(`name="${name}"`);
		}
	});

	it("names its group When it's due, and names each picker by what it picks, at 44px", () => {
		const html = renderToString(<DueRow frequency="monthly" dueDay={1} />);
		expect(html).toMatch(
			/<fieldset class="due-row[^"]*">\s*<legend class="sr-only">When it(?:'|&#39;)s due<\/legend>/,
		);
		const selects = [...html.matchAll(/<select [^>]*>/g)].map((m) => m[0]);
		// The weekday, the day of the month, the frequency and the month.
		expect(selects).toHaveLength(4);
		for (const tag of selects) {
			expect(tag).toMatch(/aria-label="[^"]+"/);
			expect(tag).toContain("min-h-11");
		}
	});

	it("says a form error under the sentence, in role=alert", () => {
		const html = renderToString(
			<DueRow frequency="monthly" dueDay={1} error="Choose a day." />,
		);
		expect(html).toContain(
			'<p role="alert" class="text-sm text-over">Choose a day.</p>',
		);
	});

	it("hides every picker by default, and shows only the chosen frequency's, keyed off the frequency select", () => {
		// Biome wraps long selectors, so compare the rules with their line breaks and padding removed.
		const flat = css
			.replace(/\s+/g, " ")
			.replace(/\(\s/g, "(")
			.replace(/\s\)/g, ")");
		expect(flat).toContain(
			".due-row :is(.due-lead-the, .due-lead-on, .due-weekly, .due-biweekly, .due-day, .due-month, .due-quarter-word, .due-year-word) {",
		);
		for (const [frequency, shown] of [
			["weekly", ".due-lead-on, .due-weekly"],
			["biweekly", ".due-lead-on, .due-biweekly"],
			["monthly", ".due-lead-the, .due-day"],
			["quarterly", ".due-lead-the, .due-day, .due-quarter-word"],
			["yearly", ".due-lead-the, .due-day, .due-year-word"],
		] as const) {
			expect(flat).toContain(
				`.due-row:has(select[name="frequency"] option[value="${frequency}"]:checked) :is(${shown})`,
			);
		}
		// The month line (starting in, in) shows for a quarterly or yearly bill only.
		for (const frequency of ["quarterly", "yearly"]) {
			expect(flat).toContain(
				`.due-row:has(select[name="frequency"] option[value="${frequency}"]:checked) .due-month`,
			);
		}
	});
});

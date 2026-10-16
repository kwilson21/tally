/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { MoneyInput, moneyChip } from "../src/views/money-input";

const inputTag = (error?: string) =>
	String(
		MoneyInput({
			id: "amount",
			name: "amount",
			label: "Amount",
			value: "20.00",
			error,
		}),
	).match(/<input [^>]*data-money-input[^>]*>/)?.[0] ?? "";

describe("MoneyInput", () => {
	it("waits for a number: a blank amount disables −$1 and the cent-down arrow, and +$1 stays on", () => {
		const html = renderToString(
			<MoneyInput id="amount" name="amount" label="Amount" value="" />,
		);
		// The disabled attribute (rendered as disabled=""), not the disabled: Tailwind class in each class list.
		expect(html).toMatch(/data-nudge="-100"[^>]*\sdisabled(="")?[\s>]/);
		expect(html).toMatch(/data-nudge="-1"[^>]*\sdisabled(="")?[\s>]/);
		expect(html).not.toMatch(/data-nudge="100"[^>]*\sdisabled(="")?[\s>]/);
		expect(html).not.toMatch(/data-nudge="1"[^>]*\sdisabled(="")?[\s>]/);
	});

	it("draws a three-month average chip with its pressed state and 44px target", () => {
		const html = renderToString(
			<MoneyInput
				id="amount"
				name="amount"
				label="Budget"
				value="650.00"
				averageCents={65000}
			/>,
		);
		expect(html).toMatch(/data-set="65000"[^>]*aria-pressed="true"/);
		expect(html).toContain("3-month average: $650.00");
		expect(html).toMatch(/data-set="65000"[^>]*class="[^"]*min-h-11/);
	});

	it("makes the input fill the whole 90px box, so tapping anywhere in the box focuses it", () => {
		// The box is a div, not a label: an input only as tall as its text (42px) leaves the box's top and
		// bottom bands dead. self-stretch and -my-3 (undoing the box's py-3) give the input the box's
		// height, as the cent arrows beside it have.
		const input = inputTag();
		expect(input).toMatch(/class="[^"]*\bself-stretch\b/);
		expect(input).toMatch(/class="(?:[^"]* )?-my-3[ "]/);
	});

	// Guard (decision 128): the amount and its chips are already tabular; this keeps them so.
	it("keeps the typed amount and its chips in tabular figures", () => {
		expect(inputTag()).toMatch(/class="[^"]*\btabular-nums\b/);
		expect(moneyChip.split(" ")).toContain("tabular-nums");
	});

	it("keeps the field-shake class on the same input when there is an error", () => {
		const input = inputTag("Enter a dollar amount.");
		expect(input).toContain("field-shake");
		expect(input).toMatch(/class="[^"]*\bself-stretch\b/);
	});
});

/** The whole start tag of the button with this data-nudge value (1, -1, 100 or -100). */
const stepTag = (html: string, nudge: string) =>
	html.match(new RegExp(`<button[^>]*data-nudge="${nudge}"[^>]*>`))?.[0] ?? "";

/** The whole start tag of the chip with this marker attribute. */
const chipTag = (html: string, marker: string) =>
	html.match(new RegExp(`<button[^>]*${marker}[^>]*>`))?.[0] ?? "";

describe("MoneyInput's words and steps (decision 117)", () => {
	it("shows a muted 0.00 placeholder in the box, in normal weight", () => {
		const html = renderToString(
			<MoneyInput id="amount" name="amount" label="Budget" value="" />,
		);
		expect(html).toMatch(/<input [^>]*placeholder="0\.00"[^>]*>/);
		expect(html).toContain("placeholder:text-muted");
		expect(html).toContain("placeholder:font-normal");
	});

	it("gives each chip a check slot that keeps its width, shown only when the chip is pressed", () => {
		const html = renderToString(
			<MoneyInput
				id="amount"
				name="amount"
				label="Budget"
				value="571.80"
				lastMonthCents={57180}
				averageCents={60245}
			/>,
		);
		const last = chipTag(html, 'data-set="57180"');
		expect(last).toContain("group");
		expect(last).toContain("aria-pressed:text-ink");
		expect(last).not.toContain("aria-pressed:opacity-50");
		// The check's span is always in the chip, invisible until its pressed state shows it.
		expect(html).toMatch(
			/<span class="inline-flex invisible group-aria-pressed:visible">/,
		);
		expect(html.match(/group-aria-pressed:visible/g)).toHaveLength(3);
	});

	it("starts Round to unpressed, with its label kept apart from its check", () => {
		const html = renderToString(
			<MoneyInput id="amount" name="amount" label="Budget" value="612.45" />,
		);
		const round = chipTag(html, "data-roundup");
		expect(round).toContain('aria-pressed="false"');
		expect(html).toContain(
			'<span data-roundup-label="true">Round to $613</span>',
		);
	});

	it("turns all four steps off while the text can't be read, and hides Round to", () => {
		const html = renderToString(
			<MoneyInput
				id="amount"
				name="amount"
				label="Budget"
				value="six hundred"
				error="Enter a dollar amount, like 250 or 250.50."
			/>,
		);
		for (const nudge of ["100", "1", "-1", "-100"]) {
			expect(stepTag(html, nudge)).toMatch(/\sdisabled[\s>=]/);
		}
		expect(chipTag(html, "data-roundup")).toMatch(/\shidden[\s>=]/);
	});

	it.each(["-5", "-0.05", "-0"])(
		"turns all four steps off for %s, which money.js can't read either, and hides Round to",
		(value) => {
			const html = renderToString(
				<MoneyInput id="amount" name="amount" label="Budget" value={value} />,
			);
			for (const nudge of ["100", "1", "-1", "-100"]) {
				expect(stepTag(html, nudge)).toMatch(/\sdisabled[\s>=]/);
			}
			expect(chipTag(html, "data-roundup")).toMatch(/\shidden[\s>=]/);
		},
	);

	it("keeps every step on for a readable amount", () => {
		const html = renderToString(
			<MoneyInput id="amount" name="amount" label="Budget" value="612.40" />,
		);
		for (const nudge of ["100", "1", "-1", "-100"]) {
			expect(stepTag(html, nudge)).not.toMatch(/\sdisabled[\s>=]/);
		}
	});

	it("waits for a number: the empty box keeps +$1 and ▲ on, and turns − and ▼ off", () => {
		const html = renderToString(
			<MoneyInput id="amount" name="amount" label="Budget" value="" />,
		);
		expect(stepTag(html, "-100")).toMatch(/\sdisabled[\s>=]/);
		expect(stepTag(html, "-1")).toMatch(/\sdisabled[\s>=]/);
		expect(stepTag(html, "100")).not.toMatch(/\sdisabled[\s>=]/);
		expect(stepTag(html, "1")).not.toMatch(/\sdisabled[\s>=]/);
	});
});

const draw = () =>
	renderToString(
		<MoneyInput id="amount" name="amount" label="Budget" value="700.00" />,
	);

describe("MoneyInput's corners (decision 85, Q61 A)", () => {
	it("draws the box in the 12px control corner, like every input", () => {
		const html = draw();
		// The box that holds the $ and the amount, found by its fixed width and height.
		const box =
			html.match(/<div class="([^"]*min-h-\[90px\][^"]*)"/)?.[1] ?? "";
		expect(box).toContain("rounded-control");
		expect(box).not.toContain("rounded-lg");
	});

	it("rounds the cent arrows' outer corners with the same token", () => {
		const html = draw();
		expect(html).toContain("rounded-tr-control");
		expect(html).toContain("rounded-br-control");
	});

	it("keeps no 8px corner anywhere", () => {
		expect(draw()).not.toMatch(/rounded(-[a-z]{1,2})?-lg/);
	});
});

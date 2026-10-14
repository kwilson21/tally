/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { LedgerField } from "../src/views/ledger-field";

describe("LedgerField", () => {
	it("ties its small muted label to the field by for and id", () => {
		const html = renderToString(
			<LedgerField id="bill-name" name="name" label="Name" value="" />,
		);
		expect(html).toContain(
			'<label for="bill-name" class="text-sm text-muted">Name</label>',
		);
		expect(html).toMatch(/<input id="bill-name" name="name"[^>]*>/);
		expect(html).toContain('autocomplete="off"');
	});

	it("keeps the label for screen readers only when it is hidden", () => {
		const html = renderToString(
			<LedgerField
				id="match"
				name="merchant_raw_name"
				label="Match payments from"
				hideLabel
				value=""
			/>,
		);
		expect(html).toContain('<label for="match" class="sr-only">');
	});

	it("names its hint and its error in aria-describedby, marks the error, and says it in role=alert", () => {
		const html = renderToString(
			<LedgerField
				id="bill-name"
				name="name"
				label="Name"
				value=""
				hint="The name you'll see on the bill."
				error="Enter a name for the bill."
			/>,
		);
		expect(html).toContain('id="bill-name-hint"');
		expect(html).toContain(
			'<p id="bill-name-error" role="alert" class="text-sm text-over">Enter a name for the bill.</p>',
		);
		const input = html.match(/<input [^>]*>/)?.[0] ?? "";
		expect(input).toContain(
			'aria-describedby="bill-name-hint bill-name-error"',
		);
		expect(input).toContain('aria-invalid="true"');
		expect(input).toContain("field-shake");
		// The line turns brick, and the error's words are what a screen reader hears.
		expect(html).toMatch(/class="[^"]*border-b border-over/);
	});

	it("draws no invalid state, and no describedby, without a hint or an error", () => {
		const html = renderToString(
			<LedgerField id="bill-name" name="name" label="Name" value="Water" />,
		);
		const input = html.match(/<input [^>]*>/)?.[0] ?? "";
		expect(input).not.toContain("aria-invalid");
		expect(input).not.toContain("aria-describedby");
		expect(input).not.toContain("field-shake");
		expect(html).toMatch(/class="[^"]*border-b border-muted/);
		expect(html).not.toContain('role="alert"');
	});

	it("draws the big amount with an aria-hidden $ in serif 4xl, and its field at 56px tall", () => {
		const html = renderToString(
			<LedgerField
				id="bill-amount"
				name="amount"
				label="Amount"
				value="1500.00"
				big
				prefix="$"
				inputmode="decimal"
			/>,
		);
		expect(html).toContain(
			'<span aria-hidden="true" class="font-serif text-4xl text-muted">$</span>',
		);
		const input = html.match(/<input [^>]*>/)?.[0] ?? "";
		expect(input).toContain(
			"min-h-14 font-serif text-4xl font-semibold tabular-nums",
		);
		expect(input).toContain('inputmode="decimal"');
		expect(input).toContain('value="1500.00"');
	});

	it("draws an ordinary field at 44px tall with no prefix", () => {
		const html = renderToString(
			<LedgerField id="where" name="where" label="Where" value="" />,
		);
		expect(html).not.toContain("aria-hidden");
		expect(html).toMatch(/<input [^>]*class="[^"]*min-h-11 text-lg/);
	});

	it("passes autofocus and required to the field", () => {
		const html = renderToString(
			<LedgerField
				id="bill-name"
				name="name"
				label="Name"
				value=""
				autofocus
				required
			/>,
		);
		const input = html.match(/<input [^>]*>/)?.[0] ?? "";
		expect(input).toContain("autofocus");
		expect(input).toContain("required");
	});
});

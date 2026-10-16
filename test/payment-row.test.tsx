/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import {
	BillPaymentPicker,
	type PaymentPickerCandidate,
} from "../src/views/bill-payment-picker";
import { PlanPaymentPicker } from "../src/views/planned-expense";

// #645, P138 A (decision 126): a picker's payments are 44px rows, the five closest first, then "Show all N charges",
// which opens the rest in the same order. A turned-away payment stays last, inside the fold.

const bill = (
	candidates: PaymentPickerCandidate[],
	selectedTransactionId?: number,
) =>
	String(
		BillPaymentPicker({
			billId: 1,
			billName: "Electric",
			billAmountCents: 14200,
			openedPeriod: "2026-10",
			dueDateLabel: "Oct 24",
			bill: { frequency: "monthly", anchorMonth: null },
			candidates,
			periods: [{ value: "2026-10", label: "October" }],
			selectedTransactionId,
		}),
	);

const plan = (candidates: ReturnType<typeof planPayment>[]) =>
	String(
		PlanPaymentPicker({
			planId: 1,
			name: "Lawn service",
			amountCents: 9000,
			candidates,
		}),
	);

const payment = (
	id: number,
	extra: Partial<PaymentPickerCandidate> = {},
): PaymentPickerCandidate => ({
	id,
	displayName: `Shop ${id}`,
	date: "2026-10-03",
	dateLabel: "Oct 3",
	amountCents: 9000 + id,
	...extra,
});

function planPayment(id: number, excluded = false) {
	return {
		id,
		date: "2026-10-03",
		dateLabel: "Oct 3",
		amountCents: 9000 + id,
		displayName: `Shop ${id}`,
		excluded,
	};
}

/** Each payment radio's own label, from its opening tag to its closing tag. */
function rowsOf(html: string) {
	return html
		.split("<label")
		.filter((part) => part.includes('name="transaction_id"'))
		.map((part) => `<label${part.slice(0, part.indexOf("</label>") + 8)}`);
}

/** The words a row reads out, in order: the tags and the hidden check mark taken out. */
const wordsOf = (row: string) =>
	row
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();

const radioInputs = (html: string) =>
	html.match(/<input[^>]*name="transaction_id"[^>]*>/g) ?? [];

const valuesOf = (html: string) =>
	[...html.matchAll(/name="transaction_id" value="(\d+)"/g)].map((m) => m[1]);

describe("PlanPaymentPicker's payments as rows (#645)", () => {
	it("draws each payment as a 44px row with the transaction row's look, not a chip", () => {
		const rows = rowsOf(plan([1, 2, 3, 4, 5].map((id) => planPayment(id))));
		expect(rows).toHaveLength(5);
		for (const row of rows) {
			const open = row.slice(0, row.indexOf(">"));
			expect(open).toContain("min-h-11");
			expect(open).not.toContain("rounded-full");
			expect(row).toContain("selection-mark");
		}
	});

	it("reads each row's name, date, then amount, with Excluded beside the date", () => {
		const [row] = rowsOf(plan([planPayment(1, true)]));
		expect(wordsOf(row ?? "")).toBe("Shop 1 Oct 3 · Excluded $90.01");
	});

	it("shows the closest five in the order given, then Show all N charges holding the rest", () => {
		const html = plan([1, 2, 3, 4, 5, 6, 7].map((id) => planPayment(id)));
		expect(valuesOf(html)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
		expect(html.match(/<details/g)).toHaveLength(1);
		const fold = html.slice(
			html.indexOf("<details"),
			html.indexOf("</details>"),
		);
		expect(fold).toContain("Show all 7 charges");
		expect(fold).toContain('value="6"');
		expect(fold).toContain('value="7"');
		expect(fold).not.toContain('value="5"');
		expect(html.indexOf('value="5"')).toBeLessThan(html.indexOf("<details"));
	});

	it("has no fold at five or fewer payments", () => {
		const html = plan([1, 2, 3, 4, 5].map((id) => planPayment(id)));
		expect(valuesOf(html)).toHaveLength(5);
		expect(html).not.toContain("<details");
		expect(html).not.toContain("Show all");
	});

	it("makes only the first radio required, so the group needs a choice", () => {
		const html = plan([1, 2, 3, 4, 5, 6].map((id) => planPayment(id)));
		const inputs = radioInputs(html);
		expect(inputs).toHaveLength(6);
		expect(inputs.filter((input) => / required/.test(input))).toHaveLength(1);
		expect(inputs[0]).toContain(" required");
	});
});

describe("BillPaymentPicker's payments as rows (#645)", () => {
	const SEVEN = [1, 2, 3, 4, 5, 6, 7].map((id) => payment(id));

	it("draws each payment as a 44px row, with the month explanation's hx-get on every radio", () => {
		const html = bill(SEVEN);
		const rows = rowsOf(html);
		// Seven rows in all: the first five drawn, the other two inside the closed fold.
		expect(rows).toHaveLength(7);
		expect(html.indexOf('value="5"')).toBeLessThan(html.indexOf("<details"));
		expect(html.indexOf('value="6"')).toBeGreaterThan(html.indexOf("<details"));
		for (const row of rows) {
			expect(row.slice(0, row.indexOf(">"))).toContain("min-h-11");
			expect(row).not.toContain("rounded-full border border-rule px-4");
		}
		const inputs = radioInputs(html);
		expect(inputs).toHaveLength(7);
		for (const input of inputs) {
			expect(input).toContain('hx-get="/bills/1/month-explanation"');
			expect(input).toContain('hx-target="#bill-month-explanation"');
		}
	});

	it("reads each row's name, date, then amount, with Excluded beside the date", () => {
		const html = bill([
			payment(1, {
				displayName: "Zelle",
				dateLabel: "Oct 1",
				amountCents: 185000,
				excluded: true,
			}),
		]);
		expect(wordsOf(rowsOf(html)[0] ?? "")).toBe(
			"Zelle Oct 1 · Excluded $1,850.00",
		);
	});

	it("lists the address's payment first, checked and required, and the rest in their order", () => {
		const html = bill(SEVEN, 4);
		expect(valuesOf(html)).toEqual(["4", "1", "2", "3", "5", "6", "7"]);
		const first = radioInputs(html)[0] ?? "";
		expect(first).toContain('value="4"');
		expect(first).toMatch(/\bchecked\b/);
		expect(first).toContain(" required");
	});

	it("folds the rest under Show all N charges, which counts the turned-away payment too", () => {
		const html = bill([
			...[1, 2, 3, 4, 5].map((id) => payment(id)),
			payment(6, { turnedAway: true }),
		]);
		expect(html).toContain('<details class="group border-b border-rule">');
		expect(html).toContain("Show all 6 charges");
	});

	it("opens the fold when a turned-away payment is checked, and lists it last inside the fold", () => {
		const html = bill(
			[
				...[1, 2, 3, 4, 5].map((id) => payment(id)),
				payment(6, { turnedAway: true }),
			],
			6,
		);
		expect(html).toMatch(/<details[^>]* open=""/);
		const fold = html.slice(
			html.indexOf("<details"),
			html.indexOf("</details>"),
		);
		expect(fold.indexOf("You said not this one")).toBeGreaterThan(
			fold.indexOf("Show all 6 charges"),
		);
		expect(fold.indexOf('value="6"')).toBeGreaterThan(
			fold.indexOf("You said not this one"),
		);
		expect(html.indexOf('value="5"')).toBeLessThan(html.indexOf("<details"));
	});

	it("keeps the fold shut when a turned-away payment is not checked", () => {
		const html = bill([
			...[1, 2, 3, 4, 5].map((id) => payment(id)),
			payment(6, { turnedAway: true }),
		]);
		expect(html).toContain("<details");
		expect(html).not.toMatch(/<details[^>]* open=""/);
	});

	it("has no fold at five or fewer, and the turned-away group follows the rows", () => {
		const html = bill([
			payment(1),
			payment(2),
			payment(3, { turnedAway: true }),
		]);
		expect(html).not.toContain("<details");
		expect(html.indexOf("You said not this one")).toBeGreaterThan(
			html.indexOf('value="2"'),
		);
		expect(html.indexOf('value="3"')).toBeGreaterThan(
			html.indexOf("You said not this one"),
		);
	});
});

/** A row's label class tokens, read from its opening tag. */
const classTokensOf = (row: string) =>
	(row.slice(0, row.indexOf(">")).match(/ class="([^"]*)"/)?.[1] ?? "").split(
		/\s+/,
	);

/** A row's check mark answers to its own radio (the named group `payment`), and its fill and focus ring stay on the row. */
function expectRowOwnsItsCheck(row: string) {
	const tokens = classTokensOf(row);
	expect(tokens).toContain("group/payment");
	expect(tokens).not.toContain("group");
	expect(row).toContain("group-has-[:checked]/payment:flex");
	expect(row).toContain("peer-checked:border-ink peer-checked:bg-band");
	expect(row).toContain(
		"has-[:focus-visible]:[&amp;_.selection-mark]:outline-2",
	);
}

describe("a picker's check mark in Show all N charges (#645, Codex 4299994834)", () => {
	it("scopes each row's check mark to its own radio with the named group payment, so a checked row in Show all marks only itself (Codex 4299994834)", () => {
		const html = bill(
			[1, 2, 3, 4, 5, 6]
				.map((id) => payment(id))
				.concat(payment(7, { turnedAway: true })),
			7,
		);
		const fold = html.slice(
			html.indexOf("<details"),
			html.indexOf("</details>"),
		);
		expect(html).toMatch(/<details[^>]* open=""/);
		expect(radioInputs(fold)).toHaveLength(2);
		const checked = radioInputs(fold).filter((input) =>
			/\bchecked\b/.test(input),
		);
		expect(checked).toHaveLength(1);
		expect(checked[0]).toContain('value="7"');
		const rows = rowsOf(html);
		expect(rows).toHaveLength(7);
		for (const row of rows) expectRowOwnsItsCheck(row);
		expect(html).not.toContain("group-has-[:checked]:flex");
		expect(html).toContain('<details class="group border-b border-rule"');
		expect(html).toContain("group-open:rotate-90");

		const planHtml = plan([1, 2, 3, 4, 5, 6, 7].map((id) => planPayment(id)));
		const planRows = rowsOf(planHtml);
		expect(planRows).toHaveLength(7);
		for (const row of planRows) expectRowOwnsItsCheck(row);
		expect(planHtml).not.toContain("group-has-[:checked]:flex");
		expect(planHtml).toContain('<details class="group border-b border-rule"');
	});
});

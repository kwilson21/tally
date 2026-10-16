/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { BillFindingRow } from "../src/views/bill-finding";
import { BillOccurrenceRow } from "../src/views/bill-occurrence-row";
import { BillPaymentPicker } from "../src/views/bill-payment-picker";
import { BillRow } from "../src/views/bill-row";

// P36 B (decision 72): "Price changed?" on the bill's row, and the question on the bill's page.

const NETFLIX = {
	id: 1,
	name: "Netflix",
	amountCents: 1549,
	status: "overdue" as const,
	dueDate: "2026-10-02",
	icon: "household",
	color: "cat-brown",
};

describe("BillRow with a price change", () => {
	const row = String(
		BillRow({
			bill: {
				...NETFLIX,
				priceOffer: { amountCents: 1799, date: "2026-10-03" },
			},
			today: "2026-10-05",
			href: "/bills/1",
		}),
	);

	it("gains two caption lines, in ink and then muted, in place of the due line", () => {
		expect(row).toContain(
			'<span class="block leading-6">Price changed?</span>',
		);
		expect(row).toContain(
			'<span class="block leading-6 text-muted">Paid $17.99 on Oct 3</span>',
		);
		expect(row).not.toContain("Was due");
	});

	it("keeps the bill's name, its own amount and the link to its page", () => {
		expect(row).toContain("Netflix");
		expect(row).toContain("$15.49");
		expect(row).toMatch(/<a href="\/bills\/1" class="[^"]*min-h-16[^"]*py-2/);
	});

	it("draws the row as before without an offer", () => {
		const plain = String(
			BillRow({ bill: NETFLIX, today: "2026-10-05", href: "/bills/1" }),
		);
		expect(plain).toContain("Was due Oct 2");
		expect(plain).not.toContain("Price changed?");
		expect(plain).not.toContain("py-2");
	});

	it("names the year of a payment from another year", () => {
		const html = String(
			BillRow({
				bill: {
					...NETFLIX,
					priceOffer: { amountCents: 1799, date: "2025-12-31" },
				},
				today: "2026-01-02",
			}),
		);
		expect(html).toContain("Paid $17.99 on Dec 31, 2025");
	});
});

// Decision 128: a bill row's own amount is a column of figures, so it is tabular; its name and status are prose.
describe("BillRow amount (decision 128)", () => {
	it("sets the bill's own amount in tabular figures", () => {
		const row = String(
			BillRow({ bill: NETFLIX, today: "2026-10-05", href: "/bills/1" }),
		);
		expect(row).toContain(
			'<span class="shrink-0 text-lg tabular-nums">$15.49</span>',
		);
	});
});

// Decision 128 (#676): a found bill's "About $X" is a figure; its name is prose.
describe("BillFindingRow amount (decision 128)", () => {
	it("sets the About amount in tabular figures, and the name outside them", () => {
		const row = String(
			BillFindingRow({
				suggestion: {
					rawName: "GYM MEMBERSHIP",
					bankText: "GYM MEMBERSHIP 0042",
					displayName: "Gym",
					amountCents: 8415,
					dueDay: 12,
					categoryId: null,
					chargeCount: 4,
				},
			}),
		);
		expect(row).toContain(
			'<span class="shrink-0 text-right tabular-nums">About $84.15</span>',
		);
		expect(row).toContain("<span>Gym</span>");
	});
});

describe("BillOccurrenceRow with a price change", () => {
	const offer = {
		transactionId: 7,
		merchant: "Netflix",
		amountCents: 1799,
		dateLabel: "Oct 3",
		billAmountCents: 1549,
		currentCents: 1549,
		frequency: "monthly" as const,
	};
	const html = String(
		BillOccurrenceRow({
			billId: 1,
			period: "2026-10",
			label: "October",
			status: "overdue",
			priceOffer: offer,
		}),
	);

	it("says what was charged against what the bill says", () => {
		expect(html).toContain("Netflix charged $17.99 on Oct 3, not $15.49.");
		expect(html).toContain("Overdue");
	});

	it("explains what updating does, in the plain words the bill's header uses", () => {
		expect(html).toContain(
			"Updating the bill links that payment and makes it $17.99 a month.",
		);
		const yearly = String(
			BillOccurrenceRow({
				billId: 1,
				period: "2026",
				label: "2026",
				status: "due",
				priceOffer: { ...offer, frequency: "yearly" },
			}),
		);
		expect(yearly).toContain("$17.99 a year.");
	});

	it("has one primary action and a terracotta text action, each a form that posts", () => {
		const accept = "/bills/1/occurrences/2026-10/price/accept";
		const dismiss = "/bills/1/occurrences/2026-10/price/dismiss";
		expect(html).toContain(
			`method="post" action="${accept}" hx-post="${accept}"`,
		);
		expect(html).toContain(
			`method="post" action="${dismiss}" hx-post="${dismiss}"`,
		);
		expect(html.match(/name="transaction_id" value="7"/g)).toHaveLength(2);
		// Yes carries the prices the person saw, in integer cents, so a stale page can't save others.
		const yes = html.slice(html.indexOf(accept), html.indexOf(dismiss));
		expect(yes).toContain('name="bill_cents" value="1549"');
		expect(yes).toContain('name="charge_cents" value="1799"');
		// The bill's current amount too, so an edit made since the page was drawn stops the save.
		expect(yes).toContain('name="current_cents" value="1549"');
		expect(html.match(/name="current_cents"/g)).toHaveLength(1);
		expect(html.match(/name="bill_cents"/g)).toHaveLength(1);
		expect(html).toContain("Update the bill to $17.99");
		expect(html).toMatch(/bg-ink[^>]*>[\s\S]*Update the bill to \$17\.99/);
		expect(html).toMatch(/text-accent[^>]*>\s*Not this bill\s*</);
		// One primary action; the quiet one is text, and neither is the plain link or unlink.
		expect(html.match(/bg-ink/g)).toHaveLength(1);
		expect(html).not.toContain("Link a payment");
		expect(html).not.toContain("No payment linked yet");
		expect(html).not.toContain("Not this one");
	});

	it("keeps the occurrence as before without an offer", () => {
		const plain = String(
			BillOccurrenceRow({
				billId: 1,
				period: "2026-10",
				label: "October",
				status: "overdue",
			}),
		);
		expect(plain).toContain("Link a payment");
		expect(plain).toContain("No payment linked yet");
		expect(plain).not.toContain("charged");
	});
});

describe("BillPaymentPicker with an excluded payment", () => {
	const picker = (excluded: boolean) =>
		String(
			BillPaymentPicker({
				billId: 1,
				billName: "Rent",
				billAmountCents: 185000,
				openedPeriod: "2026-10",
				dueDateLabel: "Oct 1",
				bill: { frequency: "monthly", anchorMonth: null },
				candidates: [
					{
						id: 1,
						displayName: "Zelle",
						date: "2026-10-01",
						dateLabel: "Oct 1",
						amountCents: 185000,
						excluded,
					},
				],
				periods: [{ value: "2026-10", label: "October" }],
			}),
		);

	it("says Excluded in words beside it, so a person knows linking brings it back", () => {
		expect(picker(true)).toContain("Zelle · Oct 1 · $1,850.00 · Excluded");
		expect(picker(false)).not.toContain("Excluded");
	});
});

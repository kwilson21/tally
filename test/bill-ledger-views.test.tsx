/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import {
	LedgerDisclosure,
	LedgerMonth,
	LedgerPriceRow,
} from "../src/views/bill-ledger";

// Decision 128 (#676): a month's status words carry figures, so they are tabular; the month's name and the
// sentence under it are prose.
const STATUSES = [
	"Paid Oct 16 · $2.99",
	"Part paid: $600 of $1,200",
	"No payment",
];

describe("LedgerMonth's words (decision 128)", () => {
	it("sets the status words in tabular figures for each status, and the month's name outside them", () => {
		for (const words of STATUSES) {
			const html = String(
				LedgerMonth({
					href: "/bills/1/occurrences/2026-10",
					month: "October",
					words,
				}),
			);
			expect(html).toContain(
				`<span class="text-sm tabular-nums text-muted">${words}</span>`,
			);
			expect(html).toContain('<span class="block text-lg">October</span>');
		}
	});

	it("keeps its own words class, so a LedgerMonth with text-over keeps text-over", () => {
		const html = String(
			LedgerMonth({
				href: "/bills/1/occurrences/2026-09",
				month: "September",
				words: "Overdue Sep 15 · $2.99",
				wordsClass: "text-over",
			}),
		);
		expect(html).toContain(
			'<span class="text-sm tabular-nums text-over">Overdue Sep 15 · $2.99</span>',
		);
	});

	it("leaves its sub sentence in normal figures", () => {
		const html = String(
			LedgerMonth({
				href: "/bills/1/occurrences/2026-10",
				month: "October",
				sub: "Found: APPLE.COM/BILL on Oct 15",
				words: "Paid Oct 15 · $2.99",
			}),
		);
		expect(html).toContain(
			'<span class="block text-sm text-muted">Found: APPLE.COM/BILL on Oct 15</span>',
		);
	});
});

describe("LedgerDisclosure's words (decision 128)", () => {
	it("sets the status words in tabular figures for each status, and the month's name outside them", () => {
		for (const words of STATUSES) {
			const html = String(LedgerDisclosure({ month: "October", words }));
			expect(html).toContain(
				`<span class="text-sm tabular-nums text-muted">${words}</span>`,
			);
			expect(html).toContain('<span class="relative min-w-0 flex-1 text-lg">');
		}
	});

	it("keeps a folded run's words hidden from a screen reader, in tabular figures, and its count in the name", () => {
		const html = String(
			LedgerDisclosure({
				month: "April to August",
				words: "No payment",
				sr: "5 months with no payment",
			}),
		);
		expect(html).toContain(
			'<span class="text-sm tabular-nums text-muted" aria-hidden="true">No payment</span>',
		);
		expect(html).toContain(
			'<span class="relative min-w-0 flex-1 text-lg">April to August<span class="sr-only">, 5 months with no payment</span></span>',
		);
	});
});

describe("LedgerPriceRow's words (decision 128)", () => {
	it("sets the status words in tabular figures for each status, and the month's name outside them", () => {
		for (const words of STATUSES) {
			const html = String(LedgerPriceRow({ month: "October", words }));
			expect(html).toContain(
				`<span class="text-sm tabular-nums text-muted">${words}</span>`,
			);
			expect(html).toContain('<span class="text-lg">October</span>');
		}
	});
});

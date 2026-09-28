import { describe, expect, it } from "vitest";
import { AccountRow } from "../src/views/account-row";
import { AccountsTop } from "../src/views/accounts-top";
import { BankGroup } from "../src/views/bank-group";

const render = async (node: unknown) => String(await node);

// The Accounts screen's pieces (round 5 study, spec §8): net worth, accounts grouped by bank, Fix connection.
describe("AccountRow", () => {
	it("shows a bank account's icon, name, last four digits and balance", async () => {
		const html = await render(
			AccountRow({
				name: "Checking",
				mask: "4521",
				type: "depository",
				balanceCents: 390412,
				isLiability: false,
			}),
		);
		expect(html).toContain("Checking");
		expect(html).toContain("4521");
		expect(html).toContain("$3,904.12");
		expect(html).toContain('data-icon="bank"');
	});

	it("shows debt as negative, with the card icon for a credit card", async () => {
		const html = await render(
			AccountRow({
				name: "Credit card",
				mask: "9012",
				type: "credit",
				balanceCents: 212240,
				isLiability: true,
			}),
		);
		expect(html).toContain("-$2,122.40");
		expect(html).toContain('data-icon="card"');
	});

	it("reads the last four digits as words, and hides the dots from screen readers", async () => {
		const html = await render(
			AccountRow({
				name: "Savings",
				mask: "5678",
				type: "depository",
				balanceCents: 1260000,
				isLiability: false,
			}),
		);
		expect(html).toContain('<span class="sr-only">ending in </span>');
		expect(html).toMatch(/<span aria-hidden="true">••<\/span>5678/);
	});

	it("leaves out the digits when there's no mask", async () => {
		const html = await render(
			AccountRow({
				name: "Loan",
				mask: null,
				type: "loan",
				balanceCents: 100,
				isLiability: true,
			}),
		);
		expect(html).not.toContain("ending in");
	});
});

describe("BankGroup", () => {
	const rows = [
		{
			id: 1,
			name: "Checking",
			mask: "4521",
			type: "depository",
			balanceCents: 390412,
			isLiability: false,
		},
	];

	it("names the bank above its accounts, as a section heading", async () => {
		const html = await render(
			BankGroup({ name: "First Harbor Bank", accounts: rows }),
		);
		expect(html).toMatch(/<h2[^>]*>First Harbor Bank<\/h2>/);
		expect(html.indexOf("First Harbor Bank")).toBeLessThan(
			html.indexOf("Checking"),
		);
		expect(html).not.toContain("Fix connection");
	});

	it("shows when a bank last synced beneath its name", async () => {
		const html = await render(
			BankGroup({
				name: "First Harbor Bank",
				accounts: rows,
				lastSyncedAt: "2026-09-28 11:48:00",
				now: new Date("2026-09-28T12:00:00Z"),
			}),
		);
		expect(html).toContain("Synced 12 minutes ago");
		expect(html.indexOf("Synced 12 minutes ago")).toBeLessThan(
			html.indexOf("Checking"),
		);
	});

	it("says when a bank's accounts haven't synced yet, with no empty list", async () => {
		const html = await render(BankGroup({ name: "New Bank", accounts: [] }));
		expect(html).toContain("Accounts appear after the first sync.");
		expect(html).not.toContain("<ul");
	});

	it("says a connection needs attention in words with an icon, and offers Fix connection", async () => {
		const html = await render(
			BankGroup({
				name: "Northline Card Services",
				accounts: rows,
				needsAttention: true,
			}),
		);
		expect(html).toContain("Needs attention: sign in again");
		expect(html).toContain('data-icon="alert"');
		expect(html).toMatch(/<button[^>]*type="button"[^>]*>/);
		expect(html).toContain("Fix connection");
		expect(html).toContain("Fixing…");
	});
});

describe("AccountsTop", () => {
	it("puts the title, then Net worth and its amount in whole dollars", async () => {
		const html = await render(AccountsTop({ netWorthCents: 1438200 }));
		expect(html).toMatch(/<h1[^>]*>Accounts<\/h1>/);
		expect(html.indexOf("Net worth")).toBeLessThan(html.indexOf("$14,382"));
		expect(html).not.toContain("$14,382.00");
	});

	it("shows negative net worth with a minus sign", async () => {
		const html = await render(AccountsTop({ netWorthCents: -50000 }));
		expect(html).toContain("-$500");
	});

	it("keeps a ruled space for the Phase 4 chart, hidden from screen readers, with a note that it comes later", async () => {
		const html = await render(AccountsTop({ netWorthCents: 0 }));
		expect(html).toMatch(/<div data-chart-space[^>]*aria-hidden="true"/);
		expect(html).toContain("Net worth over time arrives later");
	});
});

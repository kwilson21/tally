import { describe, expect, it } from "vitest";
import { netWorthView } from "../src/net-worth";
import { AccountRow } from "../src/views/account-row";
import { AccountsTop } from "../src/views/accounts-top";
import { BankGroup } from "../src/views/bank-group";
import { NetWorthChart } from "../src/views/net-worth-chart";

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

	it("leaves the line out when a bank has no sync time yet or none is given", async () => {
		const never = await render(
			BankGroup({ name: "New Bank", accounts: [], lastSyncedAt: null }),
		);
		// A bank linked before sync times were kept has none yet; it isn't "never synced".
		expect(never).not.toMatch(/synced yet|Synced/);
		const omitted = await render(BankGroup({ name: "New Bank", accounts: [] }));
		expect(omitted).not.toMatch(/synced yet|Synced/);
		const unreadable = await render(
			BankGroup({ name: "New Bank", accounts: [], lastSyncedAt: "garbage" }),
		);
		expect(unreadable).not.toMatch(/synced yet|Synced|Invalid/);
	});

	it("gives a disconnected bank no Synced line, since it no longer syncs", async () => {
		const html = await render(
			BankGroup({
				name: "Old Bank",
				accounts: [],
				disconnected: true,
				lastSyncedAt: "2026-09-28 11:48:00",
				now: new Date("2026-09-28T12:00:00Z"),
			}),
		);
		expect(html).toContain("Disconnected");
		expect(html).not.toMatch(/Synced/);
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

const TODAY = "2026-10-05";
const rising = netWorthView(
	[
		{ date: "2026-05-01", cents: 1200000 },
		{ date: "2026-07-15", cents: 1400000 },
		{ date: TODAY, cents: 1560000 },
	],
	TODAY,
);
const firstDay = netWorthView([{ date: TODAY, cents: 1560000 }], TODAY);
const noDays = netWorthView([], TODAY);

describe("AccountsTop", () => {
	it("puts the title, then Net worth and its amount in whole dollars", async () => {
		const html = await render(
			AccountsTop({ netWorthCents: 1438200, history: rising }),
		);
		expect(html).toMatch(/<h1[^>]*>Accounts<\/h1>/);
		expect(html.indexOf("Net worth")).toBeLessThan(html.indexOf("$14,382"));
		expect(html).not.toContain("$14,382.00");
	});

	it("shows negative net worth with a minus sign", async () => {
		const html = await render(
			AccountsTop({ netWorthCents: -50000, history: noDays }),
		);
		expect(html).toContain("-$500");
	});

	it("puts the net-worth chart under the headline, where the ruled space was", async () => {
		const html = await render(
			AccountsTop({ netWorthCents: 1560000, history: rising }),
		);
		expect(html.indexOf("$15,600")).toBeLessThan(
			html.indexOf("Up $3,600 since May."),
		);
		expect(html.indexOf("Up $3,600 since May.")).toBeLessThan(
			html.indexOf("<svg"),
		);
		expect(html).not.toContain("arrives later");
	});
});

describe("NetWorthChart", () => {
	it("writes the change in the status sentence's voice, then draws one line on the ledger rules", async () => {
		const html = await render(NetWorthChart({ view: rising }));
		expect(html).toContain(
			'<span class="font-serif text-lg italic">Up $3,600 since May.</span>',
		);
		expect(html.match(/<polyline/g)).toHaveLength(1);
		expect(html.match(/<line /g)).toHaveLength(4);
		expect(html).toContain('class="stroke-rule"');
		expect(html).toContain('class="stroke-ink"');
	});

	it("puts a Why? link after the sentence, separated by a dot, to the net-worth section of How Tally works (decision 65)", async () => {
		const html = await render(NetWorthChart({ view: rising }));
		expect(html).toMatch(
			/Up \$3,600 since May\.<\/span><span class="[^"]*whitespace-nowrap[^"]*"><span aria-hidden="true">·<\/span><a href="\/how-it-works#net-worth" aria-label="Why\? net worth"/,
		);
		expect(html).toContain("min-h-11");
		// Beside the sentence, in the early states too; with no sentence there is nothing to explain.
		expect(await render(NetWorthChart({ view: firstDay }))).toContain(
			'href="/how-it-works#net-worth"',
		);
		expect(await render(NetWorthChart({ view: noDays }))).not.toContain("Why?");
	});

	it("gives the picture a text alternative in numbers, and hides the labels under it as the same words", async () => {
		const html = await render(NetWorthChart({ view: rising }));
		expect(html).toMatch(
			/<svg[^>]*role="img"[^>]*aria-label="Net worth over time\. Up \$3,600 since May\. It was \$12,000 on May 1 and is \$15,600 today\."/,
		);
		expect(html).toMatch(
			/<p[^>]*aria-hidden="true"[^>]*><span>May<\/span><span>Today<\/span><\/p>/,
		);
	});

	it("stays one color of ink on paper: no amounts on the chart, no status colors", async () => {
		const html = await render(NetWorthChart({ view: rising }));
		expect(html).not.toMatch(/stroke-(ok|over|accent)|fill-(ok|over|accent)/);
		expect(html).not.toContain("<text");
	});

	it("fills the width at any size without distorting its line or dot", async () => {
		const html = await render(NetWorthChart({ view: rising }));
		expect(html).toContain('preserveAspectRatio="none"');
		expect(html).toContain('vector-effect="non-scaling-stroke"');
		// The dot is a round-capped point, so it stays round when the box stretches.
		expect(html).toMatch(
			/<path d="M100 [\d.]+h0\.01"[^>]*stroke-linecap="round"/,
		);
	});

	it("before two days, shows the ruled space with when the chart starts, as P31 draws it", async () => {
		const html = await render(NetWorthChart({ view: firstDay }));
		expect(html).toContain("Tally started following your balances today.");
		expect(html).toContain(
			"The chart starts tomorrow, with a second day of balances.",
		);
		expect(html).toMatch(/<div[^>]*aria-hidden="true"[^>]*h-20/);
		expect(html.match(/border-t border-rule/g)).toHaveLength(5);
		expect(html).not.toContain("<svg");
	});

	it("with no balances yet, has no sentence, only the note", async () => {
		const html = await render(NetWorthChart({ view: noDays }));
		expect(html).not.toContain("font-serif");
		expect(html).toContain("The chart starts with the next sync.");
	});
});

describe("BankGroup, Manage", () => {
	it("leads the Manage disclosure with a chevron that turns when it opens", async () => {
		const html = await render(
			BankGroup({
				name: "First Harbor Bank",
				accounts: [],
				manageHref: "/accounts/1/disconnect",
			}),
		);
		const details = html.match(
			/<details[^>]*>\s*<summary[^>]*>[\s\S]*?<\/summary>/,
		);
		expect(details?.[0]).toMatch(/<details class="group /);
		expect(details?.[0]).toContain("group-open:rotate-90");
		expect(details?.[0]).toContain('data-icon="chevron-right"');
		expect(details?.[0]).toContain("list-none");
		expect(details?.[0]).toMatch(/Manage\s*<\/summary>/);
		expect(html).toContain("Disconnect this bank");
	});
});

describe("BankGroup, disconnected", () => {
	it("says Disconnected and hides Needs attention, Fix connection and Manage", async () => {
		const html = await render(
			BankGroup({
				name: "Old Bank",
				accounts: [],
				needsAttention: true,
				disconnected: true,
				manageHref: "/accounts/1/disconnect",
				fixAttrs: { "data-fix-connection": "", "data-item-id": "1" },
			}),
		);
		expect(html).toContain("Disconnected");
		expect(html).not.toContain("Needs attention");
		expect(html).not.toContain("Fix connection");
		expect(html).not.toContain("Disconnect this bank");
	});
});

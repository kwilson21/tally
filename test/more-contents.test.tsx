/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import type { Bank } from "../src/db/accounts";
import {
	Colophon,
	ContentsList,
	contentsPlaces,
} from "../src/views/contents-list";

const TODAY = "2026-10-14";
const RECENT = "2026-10-13 09:00:00";

const account = (id: number, name: string, balanceCents = 1000) => ({
	id,
	name,
	mask: null,
	type: "checking",
	balanceCents,
	isLiability: false,
});

const bank = (overrides: Partial<Bank>): Bank => ({
	id: 1,
	name: "First Harbor Bank",
	needsAttention: false,
	lastSyncedAt: RECENT,
	accounts: [account(1, "Checking"), account(2, "Savings")],
	...overrides,
});

const TWO_BANKS = [
	bank({}),
	bank({
		id: 2,
		name: "Northline Card Services",
		accounts: [account(3, "Credit card")],
	}),
];

const places = (overrides: Partial<Parameters<typeof contentsPlaces>[0]>) =>
	contentsPlaces({
		demo: false,
		banks: TWO_BANKS,
		today: TODAY,
		toCheck: 0,
		...overrides,
	});

const accountsPlace = (banks: Bank[]) => places({ banks })[0]?.folio?.text;

describe("contentsPlaces", () => {
	it("lists Accounts, Settings and How Tally works in that order, with the sidebar's names, links and icons", () => {
		const [accounts, settings, how] = places({});
		expect(accounts).toMatchObject({
			name: "Accounts",
			href: "/accounts",
			icon: "accounts",
			desc: "Balances, net worth and your banks",
		});
		expect(settings).toMatchObject({
			name: "Settings",
			href: "/settings",
			icon: "settings",
			desc: "Categories, rules, your household and your data",
		});
		expect(how).toMatchObject({
			name: "How Tally works",
			href: "/how-it-works",
			mark: true,
		});
		expect(how?.icon).toBeUndefined();
	});

	it("counts the accounts of the connected banks, in plain plural words", () => {
		expect(accountsPlace(TWO_BANKS)).toBe("3 accounts");
	});

	it("says 1 account in the singular", () => {
		expect(accountsPlace([bank({ accounts: [account(1, "Checking")] })])).toBe(
			"1 account",
		);
	});

	it("leaves a disconnected bank's accounts out of the count", () => {
		const banks = [
			...TWO_BANKS,
			bank({
				id: 3,
				name: "Old Harbor Bank",
				disconnected: true,
				accounts: [account(4, "Old checking"), account(5, "Old savings")],
			}),
		];
		expect(accountsPlace(banks)).toBe("3 accounts");
	});

	it("says None linked yet before any bank is linked, as Accounts' empty state does", () => {
		expect(accountsPlace([])).toBe("None linked yet");
	});

	it("says Needs attention, in brick, when a bank needs signing in, and that wins over the count", () => {
		const banks = [
			bank({ needsAttention: true }),
			bank({ id: 2, name: "Northline", accounts: [account(3, "Card")] }),
		];
		expect(places({ banks })[0]?.folio).toEqual({
			text: "Needs attention",
			tone: "attention",
		});
	});

	it("does not say Needs attention for a bank that has only stopped syncing", () => {
		const banks = [bank({ lastSyncedAt: "2026-10-02 09:00:00" })];
		expect(accountsPlace(banks)).toBe("2 accounts");
	});

	it("does not say Needs attention for a disconnected bank that needs signing in", () => {
		// Its accounts stay out of the count too, so the one bank left counts none.
		const banks = [bank({ needsAttention: true, disconnected: true })];
		expect(accountsPlace(banks)).toBe("0 accounts");
	});

	it("shows Settings' count in ink, as N to check, and nothing when none wait", () => {
		expect(places({ toCheck: 3 })[1]?.folio).toEqual({
			text: "3 to check",
			tone: "ink",
		});
		expect(places({ toCheck: 1 })[1]?.folio?.text).toBe("1 to check");
		expect(places({ toCheck: 0 })[1]?.folio).toBeUndefined();
	});

	it("gives How Tally works no folio, and the demo's own words for it", () => {
		const how = places({ demo: true })[2];
		expect(how?.folio).toBeUndefined();
		expect(how?.desc).toBe("What each number means, with the Riveras' numbers");
		expect(places({ demo: false })[2]?.desc).toBe(
			"What each number means, with your numbers",
		);
	});
});

describe("ContentsList", () => {
	const html = (list: Parameters<typeof ContentsList>[0]["places"]): string =>
		String(ContentsList({ places: list }));

	it("draws one ruled list of links, each with its accessible name in order", () => {
		const out = html(places({ toCheck: 3 }));
		expect(out).toMatch(
			/^<ul class="mt-6 divide-y divide-rule border-y border-rule">/,
		);
		expect(out).toContain(
			'aria-label="Accounts, 3 accounts, Balances, net worth and your banks"',
		);
		expect(out).toContain(
			'aria-label="Settings, 3 to check, Categories, rules, your household and your data"',
		);
		expect(out).toContain(
			'aria-label="How Tally works, What each number means, with your numbers"',
		);
	});

	it("opens each place with the press tint, and draws the leader only beside a folio", () => {
		const out = html(places({ toCheck: 0 }));
		expect(out.match(/class="[^"]*row-opens[^"]*"/g)).toHaveLength(3);
		// Accounts has a folio, Settings none, How Tally works none: one leader.
		expect(out.match(/aria-hidden="true" class="min-w-4 flex-1/g)).toHaveLength(
			1,
		);
	});

	it("lets a name's line wrap, and keeps each name whole, so a folio can drop under it", () => {
		const out = html(places({ toCheck: 3 }));
		expect(out).toContain(
			'<span class="flex flex-wrap items-baseline gap-x-2">',
		);
		expect(out).toContain('<span class="shrink-0 text-lg">Settings</span>');
	});

	it("groups the leader and the folio, so they wrap together under the name and the folio stays at the right", () => {
		const out = html(places({ toCheck: 3 }));
		expect(out).toMatch(
			/<span class="flex min-w-0 flex-auto items-baseline gap-2"><span aria-hidden="true" class="min-w-4 flex-1 border-b-2 border-dotted border-rule"><\/span><span class="text-right text-sm tabular-nums text-ink">3 to check<\/span><\/span>/,
		);
	});

	it("lets a plain folio wider than a line wrap at its spaces, rather than overflow the phone", () => {
		const out = html(places({ toCheck: 3 }));
		expect(out).toContain(
			'<span class="text-right text-sm tabular-nums text-ink">3 to check</span>',
		);
	});

	it("draws Needs attention with the alert icon in brick", () => {
		const out = html([
			{
				name: "Accounts",
				href: "/accounts",
				icon: "accounts",
				desc: "Balances, net worth and your banks",
				folio: { text: "Needs attention", tone: "attention" },
			},
		]);
		expect(out).toContain('data-icon="alert"');
		expect(out).toMatch(/text-over[^>]*>\s*<svg[\s\S]*Needs attention/);
	});
});

describe("Colophon", () => {
	it("says the demo resets every night, with the tally mark, and ignores the version", () => {
		const out = String(Colophon({ demo: true, version: "demo 9e5e14d" }));
		expect(out).toContain("Tally demo · resets every night");
		expect(out).not.toContain("9e5e14d");
	});

	it("shows the deploy's release and commit as the family's version line", () => {
		const out = String(
			Colophon({ demo: false, version: "v2026.10.12 9e5e14d" }),
		);
		expect(out).toContain("Tally v2026.10.12 · 9e5e14d");
	});

	it("draws nothing for the family when no version is set", () => {
		expect(Colophon({ demo: false })).toBeNull();
		expect(Colophon({ demo: false, version: "   " })).toBeNull();
	});
});

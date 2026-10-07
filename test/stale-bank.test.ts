import { describe, expect, it } from "vitest";
import {
	type BankSync,
	flaggedBanks,
	homeBankNotice,
	STALE_AFTER_DAYS,
	staleBankWords,
} from "../src/stale-bank";

// A bank that stopped syncing means Safe to spend may be too high (spec §8.5, decision 72 P37 A).
// Pure date logic: "today" is the household's date, passed in; a sync time is `plaid_items.last_synced_at`
// (UTC, "YYYY-MM-DD HH:MM:SS"), and only its date counts.
const TODAY = "2026-10-05";

const bank = (overrides: Partial<BankSync> = {}): BankSync => ({
	name: "Chase",
	needsAttention: false,
	lastSyncedAt: "2026-10-05 08:00:00",
	...overrides,
});

describe("flaggedBanks", () => {
	it("waits 3 days", () => {
		expect(STALE_AFTER_DAYS).toBe(3);
	});

	it("flags a bank that needs attention, however recently it synced", () => {
		expect(flaggedBanks([bank({ needsAttention: true })], TODAY)).toEqual([
			{ name: "Chase", reason: "sign-in", since: "2026-10-05" },
		]);
	});

	it("flags a bank that needs attention and never synced", () => {
		expect(
			flaggedBanks([bank({ needsAttention: true, lastSyncedAt: null })], TODAY),
		).toEqual([{ name: "Chase", reason: "sign-in" }]);
	});

	it("does not flag a bank that synced 2 days ago", () => {
		expect(
			flaggedBanks([bank({ lastSyncedAt: "2026-10-03 00:00:00" })], TODAY),
		).toEqual([]);
	});

	it("flags a bank that last synced 3 days ago, from the start of that day", () => {
		for (const at of ["2026-10-02 00:00:00", "2026-10-02 23:59:59"]) {
			expect(flaggedBanks([bank({ lastSyncedAt: at })], TODAY)).toEqual([
				{ name: "Chase", reason: "stale", since: "2026-10-02" },
			]);
		}
	});

	it("flags a bank that last synced weeks ago", () => {
		expect(
			flaggedBanks([bank({ lastSyncedAt: "2026-09-01 12:00:00" })], TODAY),
		).toEqual([{ name: "Chase", reason: "stale", since: "2026-09-01" }]);
	});

	it("counts across a month and a year", () => {
		expect(
			flaggedBanks(
				[bank({ lastSyncedAt: "2026-09-30 12:00:00" })],
				"2026-10-03",
			),
		).toEqual([{ name: "Chase", reason: "stale", since: "2026-09-30" }]);
		expect(
			flaggedBanks(
				[bank({ lastSyncedAt: "2025-12-30 12:00:00" })],
				"2026-01-02",
			),
		).toEqual([{ name: "Chase", reason: "stale", since: "2025-12-30" }]);
		expect(
			flaggedBanks(
				[bank({ lastSyncedAt: "2025-12-31 12:00:00" })],
				"2026-01-02",
			),
		).toEqual([]);
	});

	it("says sign-in when a bank both needs it and hasn't synced", () => {
		expect(
			flaggedBanks(
				[bank({ needsAttention: true, lastSyncedAt: "2026-09-01 12:00:00" })],
				TODAY,
			),
		).toEqual([{ name: "Chase", reason: "sign-in", since: "2026-09-01" }]);
	});

	it("never flags a disconnected bank", () => {
		expect(
			flaggedBanks(
				[
					bank({
						disconnected: true,
						needsAttention: true,
						lastSyncedAt: "2026-09-01 12:00:00",
					}),
				],
				TODAY,
			),
		).toEqual([]);
	});

	it("has nothing true to say about a bank with no sync time, or one it can't read", () => {
		expect(flaggedBanks([bank({ lastSyncedAt: null })], TODAY)).toEqual([]);
		expect(flaggedBanks([bank({ lastSyncedAt: "not a time" })], TODAY)).toEqual(
			[],
		);
	});

	it("does not flag a sync time in the future", () => {
		expect(
			flaggedBanks([bank({ lastSyncedAt: "2026-10-09 00:00:00" })], TODAY),
		).toEqual([]);
	});

	it("keeps the order the banks were given in and skips the healthy ones", () => {
		expect(
			flaggedBanks(
				[
					bank({ name: "Ally", lastSyncedAt: "2026-10-04 08:00:00" }),
					bank({ name: "Chase", needsAttention: true }),
					bank({ name: "Citi", lastSyncedAt: "2026-09-20 08:00:00" }),
				],
				TODAY,
			).map((b) => b.name),
		).toEqual(["Chase", "Citi"]);
	});
});

describe("staleBankWords", () => {
	it("says nothing when no bank is flagged", () => {
		expect(staleBankWords([], TODAY)).toBeNull();
	});

	it("names a bank that hasn't synced, and since when", () => {
		expect(
			staleBankWords(
				[{ name: "Chase", reason: "stale", since: "2026-10-01" }],
				TODAY,
			),
		).toBe(
			"Chase hasn't synced since Oct 1, so Safe to spend may be too high.",
		);
	});

	it("names a bank that needs signing in", () => {
		expect(staleBankWords([{ name: "Chase", reason: "sign-in" }], TODAY)).toBe(
			"Chase needs you to sign in again, so Safe to spend may be too high.",
		);
	});

	it("adds the year to a sync date from another year", () => {
		expect(
			staleBankWords(
				[{ name: "Chase", reason: "stale", since: "2025-12-30" }],
				"2026-01-02",
			),
		).toBe(
			"Chase hasn't synced since Dec 30, 2025, so Safe to spend may be too high.",
		);
	});

	it("names the first of two and counts the other", () => {
		expect(
			staleBankWords(
				[
					{ name: "Chase", reason: "sign-in" },
					{ name: "Citi", reason: "stale", since: "2026-10-01" },
				],
				TODAY,
			),
		).toBe(
			"Chase needs you to sign in again, and 1 other bank needs a look, so Safe to spend may be too high.",
		);
	});

	it("names the first of three and counts the rest", () => {
		expect(
			staleBankWords(
				[
					{ name: "Chase", reason: "stale", since: "2026-10-01" },
					{ name: "Citi", reason: "sign-in" },
					{ name: "Ally", reason: "sign-in" },
				],
				TODAY,
			),
		).toBe(
			"Chase hasn't synced since Oct 1, and 2 other banks need a look, so Safe to spend may be too high.",
		);
	});
});

describe("homeBankNotice", () => {
	it("keeps the oldest stale bank and names the sign-in bank", () => {
		expect(
			homeBankNotice(
				[
					{ name: "Login Bank", reason: "sign-in", since: "2026-10-01" },
					{ name: "Old Bank", reason: "stale", since: "2026-09-20" },
				],
				TODAY,
			),
		).toEqual({
			words:
				"Old Bank stopped updating Sep 20, and 1 more: Login Bank needs signing in",
			asOf: "Sep 20",
		});
	});

	it("counts another stale bank while naming the oldest one", () => {
		expect(
			homeBankNotice(
				[
					{ name: "Recent Bank", reason: "stale", since: "2026-10-02" },
					{ name: "Old Bank", reason: "stale", since: "2026-09-20" },
				],
				TODAY,
			),
		).toEqual({
			words: "Old Bank stopped updating Sep 20, and 1 more bank needs a fix",
			asOf: "Sep 20",
		});
	});

	it("keeps a single sign-in bank's warning", () => {
		expect(
			homeBankNotice([{ name: "Login Bank", reason: "sign-in" }], TODAY),
		).toEqual({ words: "Login Bank needs signing in" });
	});

	it("names the oldest stale bank in either link order", () => {
		const banks = [
			{ name: "Recent Bank", reason: "stale" as const, since: "2026-10-02" },
			{ name: "Older Bank", reason: "stale" as const, since: "2026-09-20" },
		];
		for (const order of [banks, [...banks].reverse()]) {
			expect(homeBankNotice(order, TODAY)).toEqual({
				words:
					"Older Bank stopped updating Sep 20, and 1 more bank needs a fix",
				asOf: "Sep 20",
			});
		}
	});

	it("uses the oldest stale bank when a sign-in bank is first", () => {
		expect(
			homeBankNotice(
				[
					{ name: "Login Bank", reason: "sign-in", since: "2026-10-01" },
					{ name: "Older Bank", reason: "stale", since: "2026-09-20" },
				],
				TODAY,
			),
		).toEqual({
			words:
				"Older Bank stopped updating Sep 20, and 1 more: Login Bank needs signing in",
			asOf: "Sep 20",
		});
	});

	it("uses a sign-in bank's sync date when it is the oldest", () => {
		expect(
			homeBankNotice(
				[
					{ name: "Login Bank", reason: "sign-in", since: "2026-09-15" },
					{ name: "Stale Bank", reason: "stale", since: "2026-09-20" },
				],
				TODAY,
			),
		).toEqual({
			words: "Login Bank needs signing in, and 1 more bank needs a fix",
			asOf: "Sep 15",
		});
	});

	it("keeps the one-bank stale notice", () => {
		expect(
			homeBankNotice(
				[{ name: "One Bank", reason: "stale", since: "2026-10-02" }],
				TODAY,
			),
		).toEqual({
			words: "One Bank stopped updating Oct 2",
			asOf: "Oct 2",
		});
	});
});

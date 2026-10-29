import { describe, expect, it } from "vitest";
import {
	asOfDate,
	type BankSync,
	bankFlag,
	flaggedBanks,
	homeBankNotice,
	STALE_AFTER_DAYS,
} from "../src/stale-bank";

describe("bankFlag", () => {
	const bank = (overrides: Partial<BankSync> = {}): BankSync => ({
		id: 1,
		name: "Chase",
		needsAttention: false,
		lastSyncedAt: "2026-10-04 08:00:00",
		...overrides,
	});

	it("flags a bank that needs signing in, with its sync date when it has one", () => {
		expect(bankFlag(bank({ needsAttention: true }), TODAY)).toEqual({
			id: 1,
			name: "Chase",
			reason: "sign-in",
			since: "2026-10-04",
		});
		expect(
			bankFlag(bank({ needsAttention: true, lastSyncedAt: null }), TODAY),
		).toEqual({ id: 1, name: "Chase", reason: "sign-in" });
	});

	it("flags a bank whose last sync is 3 days back, and not one synced yesterday", () => {
		expect(
			bankFlag(bank({ lastSyncedAt: "2026-10-02 23:59:59" }), TODAY),
		).toEqual({ id: 1, name: "Chase", reason: "stale", since: "2026-10-02" });
		expect(
			bankFlag(bank({ lastSyncedAt: "2026-10-04 00:00:00" }), TODAY),
		).toBeNull();
	});

	it("never flags a bank with no sync time, or a disconnected one", () => {
		expect(bankFlag(bank({ lastSyncedAt: null }), TODAY)).toBeNull();
		expect(
			bankFlag(bank({ disconnected: true, needsAttention: true }), TODAY),
		).toBeNull();
	});
});

// A bank that stopped syncing means Safe to spend may be too high (spec §8.5, decision 72 P37 A).
// Pure date logic: "today" is the household's date, passed in; a sync time is `plaid_items.last_synced_at`
// (UTC, "YYYY-MM-DD HH:MM:SS"), and only its date counts.
const TODAY = "2026-10-05";

const bank = (overrides: Partial<BankSync> = {}): BankSync => ({
	id: 1,
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
			{ id: 1, name: "Chase", reason: "sign-in", since: "2026-10-05" },
		]);
	});

	it("flags a bank that needs attention and never synced", () => {
		expect(
			flaggedBanks([bank({ needsAttention: true, lastSyncedAt: null })], TODAY),
		).toEqual([{ id: 1, name: "Chase", reason: "sign-in" }]);
	});

	it("does not flag a bank that synced 2 days ago", () => {
		expect(
			flaggedBanks([bank({ lastSyncedAt: "2026-10-03 00:00:00" })], TODAY),
		).toEqual([]);
	});

	it("flags a bank that last synced 3 days ago, from the start of that day", () => {
		for (const at of ["2026-10-02 00:00:00", "2026-10-02 23:59:59"]) {
			expect(flaggedBanks([bank({ lastSyncedAt: at })], TODAY)).toEqual([
				{ id: 1, name: "Chase", reason: "stale", since: "2026-10-02" },
			]);
		}
	});

	it("flags a bank that last synced weeks ago", () => {
		expect(
			flaggedBanks([bank({ lastSyncedAt: "2026-09-01 12:00:00" })], TODAY),
		).toEqual([{ id: 1, name: "Chase", reason: "stale", since: "2026-09-01" }]);
	});

	it("counts across a month and a year", () => {
		expect(
			flaggedBanks(
				[bank({ lastSyncedAt: "2026-09-30 12:00:00" })],
				"2026-10-03",
			),
		).toEqual([{ id: 1, name: "Chase", reason: "stale", since: "2026-09-30" }]);
		expect(
			flaggedBanks(
				[bank({ lastSyncedAt: "2025-12-30 12:00:00" })],
				"2026-01-02",
			),
		).toEqual([{ id: 1, name: "Chase", reason: "stale", since: "2025-12-30" }]);
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
		).toEqual([
			{ id: 1, name: "Chase", reason: "sign-in", since: "2026-09-01" },
		]);
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

describe("homeBankNotice", () => {
	it("keeps one line per bank, with the oldest first and one oldest as-of date", () => {
		expect(
			homeBankNotice(
				[
					{ name: "Login Bank", reason: "sign-in", since: "2026-10-01" },
					{ name: "Old Bank", reason: "stale", since: "2026-09-20" },
				],
				TODAY,
			),
		).toEqual({
			words: [
				"Old Bank stopped updating Sep 20",
				"Login Bank needs signing in",
			],
			asOf: "Sep 20",
			since: "2026-09-20",
		});
	});

	it("keeps a single sign-in bank's warning", () => {
		expect(
			homeBankNotice([{ name: "Login Bank", reason: "sign-in" }], TODAY),
		).toEqual({ words: ["Login Bank needs signing in"] });
	});

	it("names the oldest stale bank in either link order", () => {
		const banks = [
			{ name: "Recent Bank", reason: "stale" as const, since: "2026-10-02" },
			{ name: "Older Bank", reason: "stale" as const, since: "2026-09-20" },
		];
		for (const order of [banks, [...banks].reverse()]) {
			expect(homeBankNotice(order, TODAY)).toEqual({
				words: [
					"Older Bank stopped updating Sep 20",
					"Recent Bank stopped updating Oct 2",
				],
				asOf: "Sep 20",
				since: "2026-09-20",
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
			words: [
				"Older Bank stopped updating Sep 20",
				"Login Bank needs signing in",
			],
			asOf: "Sep 20",
			since: "2026-09-20",
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
			words: [
				"Login Bank needs signing in",
				"Stale Bank stopped updating Sep 20",
			],
			asOf: "Sep 15",
			since: "2026-09-15",
		});
	});

	it("keeps the one-bank stale notice", () => {
		expect(
			homeBankNotice(
				[{ name: "One Bank", reason: "stale", since: "2026-10-02" }],
				TODAY,
			),
		).toEqual({
			words: ["One Bank stopped updating Oct 2"],
			asOf: "Oct 2",
			since: "2026-10-02",
		});
	});

	it("sorts equal and undated banks by name after dated banks, in either link order", () => {
		const banks = [
			{ name: "No Date Z", reason: "sign-in" as const },
			{ name: "Same B", reason: "stale" as const, since: "2026-09-20" },
			{ name: "No Date A", reason: "sign-in" as const },
			{ name: "Same A", reason: "stale" as const, since: "2026-09-20" },
		];
		for (const order of [banks, [...banks].reverse()]) {
			expect(homeBankNotice(order, TODAY)?.words).toEqual([
				"Same A stopped updating Sep 20",
				"Same B stopped updating Sep 20",
				"No Date A needs signing in",
				"and 1 more bank needs a fix",
			]);
		}
	});
});

describe("homeBankNotice's since", () => {
	it("is the raw date its asOf was formatted from, and is left out with no asOf", () => {
		expect(
			homeBankNotice(
				[{ name: "Old Bank", reason: "stale", since: "2025-12-30" }],
				"2026-01-08",
			),
		).toEqual({
			words: ["Old Bank stopped updating Dec 30, 2025"],
			asOf: "Dec 30, 2025",
			since: "2025-12-30",
		});
		expect(
			homeBankNotice([{ name: "Login Bank", reason: "sign-in" }], TODAY),
		).not.toHaveProperty("since");
	});
});

describe("asOfDate", () => {
	it("formats the earlier of two dates, in either order", () => {
		expect(asOfDate(["2026-10-02", "2026-09-28"], "2026-10-05")).toBe("Sep 28");
		expect(asOfDate(["2026-09-28", "2026-10-02"], "2026-10-05")).toBe("Sep 28");
	});

	it("ignores undefined, and is undefined when none is given", () => {
		expect(asOfDate([undefined, "2026-09-28"], "2026-10-05")).toBe("Sep 28");
		expect(asOfDate(["2026-09-28", undefined], "2026-10-05")).toBe("Sep 28");
		expect(asOfDate([undefined, undefined], "2026-10-05")).toBeUndefined();
		expect(asOfDate([], "2026-10-05")).toBeUndefined();
	});

	it("names the year when the date is from another year", () => {
		expect(asOfDate(["2025-12-30", "2026-01-02"], "2026-01-08")).toBe(
			"Dec 30, 2025",
		);
	});
});

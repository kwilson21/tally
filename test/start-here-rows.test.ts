import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import {
	DEMO_BAKERY_ID,
	listRowsByIds,
	listTransactions,
	saveSplit,
	startHereRows,
} from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";

const thisMonth = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);

/** The newest bank line of the month with the flag, as Start here should pick it. */
const latestId = async (flag: "flag_income" | "flag_transfer", month: string) =>
	(
		await env.DB.prepare(
			`SELECT id FROM transactions WHERE ${flag} = 1 AND parent_id IS NULL AND substr(date, 1, 7) = ? ORDER BY date DESC, id DESC LIMIT 1`,
		)
			.bind(month)
			.first<{ id: number }>()
	)?.id;

/** The count the raw list shows for the month: /transactions?raw=1&month=<month>. */
const rawTotal = async (month: string) =>
	(
		await listTransactions(env.DB, {
			q: "",
			month,
			category: null,
			account: null,
			show: "all",
			uncategorized: false,
			page: 1,
			raw: true,
		})
	).total;

/** Splits transaction 110 ($12.00) into two parts, as a visitor would in the edit panel. */
const splitBakery = () =>
	saveSplit(
		env.DB,
		DEMO_BAKERY_ID,
		[
			{ categoryId: 1, amountCents: 700 },
			{ categoryId: 4, amountCents: 500 },
		],
		"person@example.com",
	);

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
});

describe("startHereRows (spec §8.8)", () => {
	it("returns the month, this month's latest paycheck, its latest transfer, and transaction 110 (Local Bakery after a reset)", async () => {
		expect(DEMO_BAKERY_ID).toBe(110);
		const lines = await startHereRows(env.DB, thisMonth);
		expect(lines.month).toBe(thisMonth);
		expect(lines.paycheck?.id).toBe(await latestId("flag_income", thisMonth));
		expect(lines.transfer?.id).toBe(await latestId("flag_transfer", thisMonth));
		expect(lines.bakery?.id).toBe(110);
	});

	it("gives each line Tally's own row: the bank's text as the raw name, and the name Tally shows", async () => {
		const { paycheck, transfer, bakery } = await startHereRows(
			env.DB,
			thisMonth,
		);
		expect(paycheck?.rawName).toBe("ACME CORP PAYROLL");
		expect(paycheck?.displayName).toBe("Paycheck, Acme Corp");
		expect(transfer?.rawName).toBe("ONLINE TRANSFER TO SAV ...5678");
		expect(transfer?.excluded).toBe(true);
		expect(bakery?.rawName).toBe("SQ *LOCAL BAKERY 4432");
	});

	it("leaves a line this month doesn't have as null, and keeps the others", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET flag_transfer = 0 WHERE flag_transfer = 1 AND substr(date, 1, 7) = ?",
		)
			.bind(thisMonth)
			.run();
		const { transfer, paycheck, bakery } = await startHereRows(
			env.DB,
			thisMonth,
		);
		expect(transfer).toBeNull();
		expect(paycheck?.id).toBe(await latestId("flag_income", thisMonth));
		expect(bakery?.id).toBe(110);
	});

	it("falls back to the caller's month, with no bakery line, when transaction 110 is gone", async () => {
		await env.DB.prepare("DELETE FROM transactions WHERE id = 110").run();
		const lines = await startHereRows(env.DB, thisMonth);
		expect(lines.month).toBe(thisMonth);
		expect(lines.bakery).toBeNull();
		expect(lines.paycheck?.id).toBe(await latestId("flag_income", thisMonth));
	});
});

describe("startHereRows at a month boundary (the seed's month, not today's)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps October's lines on November 1, since the bakery line is dated in October", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-31T16:00:00Z"));
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		vi.setSystemTime(new Date("2026-11-01T16:00:00Z"));
		const lines = await startHereRows(env.DB, "2026-11");
		expect(lines.month).toBe("2026-10");
		expect(lines.paycheck?.id).toBe(await latestId("flag_income", "2026-10"));
		expect(lines.transfer?.id).toBe(await latestId("flag_transfer", "2026-10"));
		expect(lines.bakery?.id).toBe(110);
		expect(lines.lineCount).toBe(await rawTotal("2026-10"));
	});
});

describe("a visitor splits transaction 110", () => {
	it("still returns 110 as the bakery line, marked as a split parent", async () => {
		await splitBakery();
		const { bakery } = await startHereRows(env.DB, thisMonth);
		expect(bakery?.id).toBe(110);
		expect(bakery?.isSplit).toBe(true);
	});

	it("keeps the list's selection rule (#350): listRowsByIds still drops a split parent", async () => {
		await splitBakery();
		expect(await listRowsByIds(env.DB, [110])).toEqual([]);
	});
});

describe("lineCount (the list's bank-dated count for the month)", () => {
	it("equals the raw list's total for the month", async () => {
		const { lineCount } = await startHereRows(env.DB, thisMonth);
		expect(lineCount).toBe(await rawTotal(thisMonth));
		expect(lineCount).toBeGreaterThan(0);
	});

	it("does not count a split's parts, so it still equals the raw list after a split", async () => {
		const before = (await startHereRows(env.DB, thisMonth)).lineCount;
		await splitBakery();
		const after = await startHereRows(env.DB, thisMonth);
		expect(after.lineCount).toBe(before);
		expect(after.lineCount).toBe(await rawTotal(thisMonth));
	});
});

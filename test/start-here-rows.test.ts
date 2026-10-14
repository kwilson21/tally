import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { DEMO_BAKERY_ID, startHereRows } from "../src/db/transactions";
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

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
});

describe("startHereRows (spec §8.8)", () => {
	it("returns this month's latest paycheck, its latest transfer, then transaction 110 (Local Bakery after a reset)", async () => {
		expect(DEMO_BAKERY_ID).toBe(110);
		const rows = await startHereRows(env.DB, thisMonth);
		expect(rows.map((row) => row.id)).toEqual([
			await latestId("flag_income", thisMonth),
			await latestId("flag_transfer", thisMonth),
			110,
		]);
	});

	it("gives each line Tally's own row: the bank's text as the raw name, and the name Tally shows", async () => {
		const [paycheck, transfer, bakery] = await startHereRows(env.DB, thisMonth);
		expect(paycheck?.rawName).toBe("ACME CORP PAYROLL");
		expect(paycheck?.displayName).toBe("Paycheck, Acme Corp");
		expect(transfer?.rawName).toBe("ONLINE TRANSFER TO SAV ...5678");
		expect(transfer?.excluded).toBe(true);
		expect(bakery?.rawName).toBe("SQ *LOCAL BAKERY 4432");
	});

	it("leaves out a line this month doesn't have, and keeps the others in order", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET flag_transfer = 0 WHERE flag_transfer = 1 AND substr(date, 1, 7) = ?",
		)
			.bind(thisMonth)
			.run();
		const rows = await startHereRows(env.DB, thisMonth);
		expect(rows.map((row) => row.id)).toEqual([
			await latestId("flag_income", thisMonth),
			110,
		]);
	});
});

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { amountRowsByBill } from "../src/db/bill-amounts";

// `amountRowsByBill` (spec §5 `bill_amounts`, decision 101): every bill's amount rows in month order, or
// only one bill's when a bill id is given.

const FIRST = 9601;
const SECOND = 9602;

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM bill_amounts WHERE bill_id IN (?, ?)").bind(
			FIRST,
			SECOND,
		),
		env.DB.prepare("DELETE FROM bills WHERE id IN (?, ?)").bind(FIRST, SECOND),
		env.DB.prepare(
			"INSERT INTO bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (?, 'Gym', 1000, 5, 'monthly', 'GYM'), (?, 'Water', 2000, 9, 'monthly', 'WATER')",
		).bind(FIRST, SECOND),
		// Inserted out of month order, and interleaved between the two bills.
		env.DB.prepare(
			"INSERT INTO bill_amounts (bill_id, effective_month, amount_cents) VALUES (?, '2026-10', 1799), (?, '2026-03', 2100), (?, '2026-01', 1000), (?, '2026-07', 2400)",
		).bind(FIRST, SECOND, FIRST, SECOND),
	]);
});

describe("amountRowsByBill", () => {
	it("groups every bill's rows by bill id, each list in month order", async () => {
		const byBill = await amountRowsByBill(env.DB);

		expect(byBill.get(FIRST)).toEqual([
			{ effectiveMonth: "2026-01", amountCents: 1000 },
			{ effectiveMonth: "2026-10", amountCents: 1799 },
		]);
		expect(byBill.get(SECOND)).toEqual([
			{ effectiveMonth: "2026-03", amountCents: 2100 },
			{ effectiveMonth: "2026-07", amountCents: 2400 },
		]);
	});

	it("with a bill id, holds only that bill's rows, in month order", async () => {
		const byBill = await amountRowsByBill(env.DB, SECOND);

		expect([...byBill.keys()]).toEqual([SECOND]);
		expect(byBill.get(SECOND)).toEqual([
			{ effectiveMonth: "2026-03", amountCents: 2100 },
			{ effectiveMonth: "2026-07", amountCents: 2400 },
		]);
	});

	it("with a bill id that has no rows, holds no list for it", async () => {
		const byBill = await amountRowsByBill(env.DB, 9699);

		expect(byBill.has(9699)).toBe(false);
	});
});

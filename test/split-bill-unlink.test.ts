import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { billOccurrence } from "../src/bills/status";
import { removeSplit, saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";

// Decision 99: removing a split, or replacing its parts, unlinks a part's bill payment and says so, as
// refunds do (decision 60). The payment is not left to the parts' ON DELETE CASCADE, and the bills are named.

const db = env.DB;
const GROCERIES = 1;
const KIDS = 4;
const MEMBERSHIP = 9800; // a yearly bill, due September 15
const WATER = 9801; // a monthly bill
const PURCHASE = 9810;
const PART_MEMBERSHIP = 9811;
const PART_WATER = 9812;
const PART_GROCERIES = 9813;

const MEMBERSHIP_SCHEDULE = {
	frequency: "yearly",
	dueDay: 15,
	anchorMonth: 9,
} as const;
const TODAY = "2026-09-22";

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await db.batch([
		db
			.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, anchor_month, category_id, merchant_raw_name, active) VALUES (?, 'Costco membership', 4000, 15, 'yearly', 9, NULL, 'COSTCO', 1)",
			)
			.bind(MEMBERSHIP),
		db
			.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, anchor_month, category_id, merchant_raw_name, active) VALUES (?, 'Water', 600, 3, 'monthly', NULL, NULL, 'CITY WATER', 1)",
			)
			.bind(WATER),
	]);
});

/** A $50.00 Costco purchase split into the given parts; a part may pay a bill for a period. */
async function seedSplit(
	parts: {
		id: number;
		cents: number;
		categoryId: number;
		bill?: { id: number; period: string };
	}[],
	/** The period of a membership payment linked to the purchase itself. */
	wholePeriod?: string,
) {
	const total = parts.reduce((sum, part) => sum + part.cents, 0);
	await db.batch([
		db
			.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, is_split) VALUES (?, 3, '2026-09-15', ?, 'COSTCO', 1)",
			)
			.bind(PURCHASE, total),
		...parts.map((part) =>
			db
				.prepare(
					"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, category_source, parent_id) VALUES (?, 3, '2026-09-15', ?, 'COSTCO', ?, 'user', ?)",
				)
				.bind(part.id, part.cents, part.categoryId, PURCHASE),
		),
		...parts.flatMap((part) =>
			part.bill
				? [
						db
							.prepare(
								"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, ?, ?, 'auto', 'linked')",
							)
							.bind(part.bill.id, part.bill.period, part.id),
					]
				: [],
		),
		...(wholePeriod
			? [
					db
						.prepare(
							"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, ?, ?, 'user', 'linked')",
						)
						.bind(MEMBERSHIP, wholePeriod, PURCHASE),
				]
			: []),
	]);
}

/** The periods a bill's payments are linked for, as the bill's status reads them. */
async function linkedPeriods(billId: number) {
	const { results } = await db
		.prepare(
			"SELECT period FROM bill_payments WHERE bill_id = ? AND status = 'linked'",
		)
		.bind(billId)
		.all<{ period: string }>();
	return new Set(results.map((row) => row.period));
}

async function membershipStatus() {
	return billOccurrence(
		MEMBERSHIP_SCHEDULE,
		TODAY,
		await linkedPeriods(MEMBERSHIP),
	).status;
}

const membershipPart = {
	id: PART_MEMBERSHIP,
	cents: 4000,
	categoryId: KIDS,
	bill: { id: MEMBERSHIP, period: "2026" },
};
const groceriesPart = {
	id: PART_GROCERIES,
	cents: 1000,
	categoryId: GROCERIES,
};

describe("removing a split unlinks its parts' bill payments (decision 99)", () => {
	it("removes the link, names the bill, and leaves the bill unpaid", async () => {
		await seedSplit([membershipPart, groceriesPart]);
		expect(await membershipStatus()).toBe("paid");

		const result = await removeSplit(db, PURCHASE, "test");

		expect(result).toEqual({
			unlinked: [],
			bills: [{ name: "Costco membership", period: "2026" }],
		});
		expect(await linkedPeriods(MEMBERSHIP)).toEqual(new Set());
		expect(await membershipStatus()).toBe("overdue");
		// The whole purchase is back, and its parts are gone.
		expect(
			await db
				.prepare(
					"SELECT is_split, (SELECT COUNT(*) FROM transactions WHERE parent_id = ?) AS parts FROM transactions WHERE id = ?",
				)
				.bind(PURCHASE, PURCHASE)
				.first(),
		).toEqual({ is_split: 0, parts: 0 });
	});

	it("names each bill a split pays, one entry per payment", async () => {
		await seedSplit([
			membershipPart,
			{
				id: PART_WATER,
				cents: 600,
				categoryId: GROCERIES,
				bill: { id: WATER, period: "2026-09" },
			},
			{ ...groceriesPart, cents: 400 },
		]);

		const result = await removeSplit(db, PURCHASE, "test");

		expect(result.bills).toEqual([
			{ name: "Costco membership", period: "2026" },
			{ name: "Water", period: "2026-09" },
		]);
		expect(await linkedPeriods(WATER)).toEqual(new Set());
	});

	it("leaves a payment linked to the purchase itself, which a part never held", async () => {
		await seedSplit([{ ...groceriesPart, cents: 5000 }], "2026");

		const result = await removeSplit(db, PURCHASE, "test");

		expect(result.bills).toEqual([]);
		expect(await linkedPeriods(MEMBERSHIP)).toEqual(new Set(["2026"]));
	});

	it("unlinks nothing when the split has no bill payment", async () => {
		await seedSplit([{ ...groceriesPart, cents: 5000 }]);
		expect(await removeSplit(db, PURCHASE, "test")).toEqual({
			unlinked: [],
			bills: [],
		});
	});
});

describe("replacing a split's parts unlinks their bill payments (decision 99)", () => {
	it("unlinks the bill of a replaced part and names it", async () => {
		await seedSplit([membershipPart, groceriesPart]);

		const result = await saveSplit(
			db,
			PURCHASE,
			[
				{ categoryId: KIDS, amountCents: 4000 },
				{ categoryId: GROCERIES, amountCents: 1000 },
			],
			"test",
		);

		expect(result).toEqual({
			saved: true,
			unlinked: [],
			bills: [{ name: "Costco membership", period: "2026" }],
		});
		expect(await linkedPeriods(MEMBERSHIP)).toEqual(new Set());
		expect(await membershipStatus()).toBe("overdue");
	});

	it("unlinks nothing and names nothing when the parts don't add up to the purchase", async () => {
		await seedSplit([membershipPart, groceriesPart]);

		const result = await saveSplit(
			db,
			PURCHASE,
			[
				{ categoryId: KIDS, amountCents: 4000 },
				{ categoryId: GROCERIES, amountCents: 999 },
			],
			"test",
		);

		expect(result).toEqual({ saved: false, unlinked: [], bills: [] });
		expect(await linkedPeriods(MEMBERSHIP)).toEqual(new Set(["2026"]));
	});
});

import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { matchBillPayments } from "../src/bills/match";
import { billOccurrence } from "../src/bills/status";
import { removeSplit, saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";

// Decision 99: removing a split, or replacing its parts, unlinks a part's bill payment and says so, as
// refunds do (decision 60). The payment is not left to the parts' ON DELETE CASCADE, and the bills are named.

const db = env.DB;
const GROCERIES = 1;
const EATING_OUT = 2;
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
				{ categoryId: KIDS, amountCents: 3500 },
				{ categoryId: GROCERIES, amountCents: 1500 },
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
		expect(await dismissedPayments(MEMBERSHIP)).toEqual([]);
	});
});

/** The dismissed payments of a bill, as the matcher reads them. */
async function dismissedPayments(billId: number) {
	const { results } = await db
		.prepare(
			"SELECT transaction_id, period, matched_by, status FROM bill_payments WHERE bill_id = ? AND status = 'dismissed' ORDER BY transaction_id",
		)
		.bind(billId)
		.all<{
			transaction_id: number;
			period: string;
			matched_by: string;
			status: string;
		}>();
	return results;
}

describe("a split change leaves no dismissal, so the matcher may link the bill again (decision 105)", () => {
	// The parts sum to $42.00, which the bill's tolerance accepts once they are one purchase again.
	const smallPart = { ...groceriesPart, cents: 200 };

	it("links the bill to the whole purchase again when the split is removed and it still matches", async () => {
		await seedSplit([membershipPart, smallPart]);

		await removeSplit(db, PURCHASE, "test");
		await matchBillPayments(db, TODAY);

		expect(await dismissedPayments(MEMBERSHIP)).toEqual([]);
		expect(await linkedOn(MEMBERSHIP)).toMatchObject([
			{ transactionId: PURCHASE, parentId: null, matchedBy: "auto" },
		]);
		expect(await membershipStatus()).toBe("paid");
	});

	it("leaves no dismissal on the new parts when the parts are replaced", async () => {
		await seedSplit([membershipPart, smallPart]);

		await saveSplit(
			db,
			PURCHASE,
			[
				{ categoryId: KIDS, amountCents: 3800 },
				{ categoryId: GROCERIES, amountCents: 400 },
			],
			"test",
		);
		await matchBillPayments(db, TODAY);

		expect(await partIds(PURCHASE)).toHaveLength(2);
		expect(await dismissedPayments(MEMBERSHIP)).toEqual([]);
	});
});

/** The part ids of a purchase, oldest first: a replacement inserts its parts in the order they were sent. */
async function partIds(purchaseId: number) {
	const { results } = await db
		.prepare("SELECT id FROM transactions WHERE parent_id = ? ORDER BY id")
		.bind(purchaseId)
		.all<{ id: number }>();
	return results.map((row) => row.id);
}

/** Each linked payment of a bill with the part it is on, oldest payment first. */
async function linkedOn(billId: number) {
	const { results } = await db
		.prepare(
			`SELECT bp.transaction_id AS transactionId, part.parent_id AS parentId, part.amount_cents AS amountCents,
				part.category_id AS categoryId, bp.period AS period, bp.matched_by AS matchedBy
			FROM bill_payments bp JOIN transactions part ON part.id = bp.transaction_id
			WHERE bp.bill_id = ? AND bp.status = 'linked' ORDER BY bp.id`,
		)
		.bind(billId)
		.all<{
			transactionId: number;
			parentId: number | null;
			amountCents: number;
			categoryId: number | null;
			period: string;
			matchedBy: string;
		}>();
	return results;
}

describe("a replaced part keeps its bill payment when its amount and category are unchanged (decision 99)", () => {
	it("keeps the link on the new part when only another part's category changes", async () => {
		await seedSplit([membershipPart, groceriesPart]);

		const result = await saveSplit(
			db,
			PURCHASE,
			[
				{ categoryId: KIDS, amountCents: 4000 },
				{ categoryId: EATING_OUT, amountCents: 1000 },
			],
			"test",
		);

		expect(result).toEqual({ saved: true, unlinked: [], bills: [] });
		const [newMembership] = await partIds(PURCHASE);
		expect(await linkedOn(MEMBERSHIP)).toEqual([
			{
				transactionId: newMembership,
				parentId: PURCHASE,
				amountCents: 4000,
				categoryId: KIDS,
				period: "2026",
				matchedBy: "auto",
			},
		]);
		expect(await membershipStatus()).toBe("paid");
		expect(await dismissedPayments(MEMBERSHIP)).toEqual([]);
	});

	it("unlinks the bill when the linked part's amount changes, leaving no dismissal", async () => {
		await seedSplit([membershipPart, groceriesPart]);

		const result = await saveSplit(
			db,
			PURCHASE,
			[
				{ categoryId: KIDS, amountCents: 3500 },
				{ categoryId: GROCERIES, amountCents: 1500 },
			],
			"test",
		);

		expect(result).toEqual({
			saved: true,
			unlinked: [],
			bills: [{ name: "Costco membership", period: "2026" }],
		});
		expect(await linkedPeriods(MEMBERSHIP)).toEqual(new Set());
		expect(await dismissedPayments(MEMBERSHIP)).toEqual([]);
	});

	it("unlinks the bill when the linked part's category changes", async () => {
		await seedSplit([membershipPart, groceriesPart]);

		const result = await saveSplit(
			db,
			PURCHASE,
			[
				{ categoryId: GROCERIES, amountCents: 4000 },
				{ categoryId: KIDS, amountCents: 1000 },
			],
			"test",
		);

		expect(result).toEqual({
			saved: true,
			unlinked: [],
			bills: [{ name: "Costco membership", period: "2026" }],
		});
		expect(await linkedPeriods(MEMBERSHIP)).toEqual(new Set());
		expect(await dismissedPayments(MEMBERSHIP)).toEqual([]);
	});

	it("keeps each link when two identical parts are linked to different bills", async () => {
		await seedSplit([
			membershipPart,
			{
				id: PART_WATER,
				cents: 4000,
				categoryId: KIDS,
				bill: { id: WATER, period: "2026-09" },
			},
			groceriesPart,
		]);

		const result = await saveSplit(
			db,
			PURCHASE,
			[
				{ categoryId: KIDS, amountCents: 4000 },
				{ categoryId: KIDS, amountCents: 4000 },
				{ categoryId: GROCERIES, amountCents: 1000 },
			],
			"test",
		);

		expect(result).toEqual({ saved: true, unlinked: [], bills: [] });
		const [first, second] = await partIds(PURCHASE);
		expect(await linkedOn(MEMBERSHIP)).toEqual([
			{
				transactionId: first,
				parentId: PURCHASE,
				amountCents: 4000,
				categoryId: KIDS,
				period: "2026",
				matchedBy: "auto",
			},
		]);
		expect(await linkedOn(WATER)).toEqual([
			{
				transactionId: second,
				parentId: PURCHASE,
				amountCents: 4000,
				categoryId: KIDS,
				period: "2026-09",
				matchedBy: "auto",
			},
		]);
	});
});

describe("Link a payment lists a split change's dismissal, and linking it links it (decision 99)", () => {
	const BASE = "http://tally.test";
	const LISTED = 9815;
	const NOT_THIS_ONE = 9816;
	const smallPart = { ...groceriesPart, cents: 200 };

	const post = (path: string, body: Record<string, string>) =>
		exports.default.fetch(`${BASE}${path}`, {
			method: "POST",
			redirect: "manual",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(body),
		});
	const picker = async () =>
		(
			await exports.default.fetch(
				`${BASE}/bills/${MEMBERSHIP}/occurrences/2026/link`,
			)
		).text();

	it("lists the purchase after its split is removed", async () => {
		await seedSplit([membershipPart, smallPart]);
		await removeSplit(db, PURCHASE, "test");

		expect(await picker()).toContain(`value="${PURCHASE}"`);
	});

	it("links the listed purchase, leaving one linked payment and no dismissal", async () => {
		await seedSplit([membershipPart, smallPart]);
		await removeSplit(db, PURCHASE, "test");

		await post(`/bills/${MEMBERSHIP}/link`, {
			transaction_id: String(PURCHASE),
			period: "2026",
			opened_period: "2026",
		});

		expect(
			(
				await db
					.prepare(
						"SELECT transaction_id, period, matched_by, status FROM bill_payments WHERE bill_id = ?",
					)
					.bind(MEMBERSHIP)
					.all()
			).results,
		).toEqual([
			{
				transaction_id: PURCHASE,
				period: "2026",
				matched_by: "user",
				status: "linked",
			},
		]);
		expect(await membershipStatus()).toBe("paid");
	});

	it("still hides a payment a person marked Not this one", async () => {
		await db.batch([
			db
				.prepare(
					"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name) VALUES (?, 3, '2026-09-15', 4000, 'COSTCO')",
				)
				.bind(NOT_THIS_ONE),
			db
				.prepare(
					"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name) VALUES (?, 3, '2026-09-15', 4000, 'COSTCO')",
				)
				.bind(LISTED),
			db
				.prepare(
					"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, '2026', ?, 'user', 'linked')",
				)
				.bind(MEMBERSHIP, NOT_THIS_ONE),
		]);
		await post(`/bills/${MEMBERSHIP}/occurrences/2026/unlink`, {});

		const html = await picker();
		expect(html).toContain(`value="${LISTED}"`);
		expect(html).not.toContain(`value="${NOT_THIS_ONE}"`);
	});
});

/** A person's Not this one for the membership's 2026 payment, on a transaction, as the matcher reads it. */
const notThisOne = (transactionId: number) =>
	db
		.prepare(
			"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, '2026', ?, 'user', 'dismissed')",
		)
		.bind(MEMBERSHIP, transactionId)
		.run();

/** The dismissal a person's Not this one leaves on a transaction, as dismissedPayments reads it. */
const userDismissal = (transactionId: number) => ({
	transaction_id: transactionId,
	period: "2026",
	matched_by: "user",
	status: "dismissed",
});

/** An unsplit $42.00 Costco purchase, as the bank sent it. */
const seedPurchase = () =>
	db
		.prepare(
			"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name) VALUES (?, 3, '2026-09-15', 4200, 'COSTCO')",
		)
		.bind(PURCHASE)
		.run();

describe("a person's own Not this one survives a split change (decision 105)", () => {
	const smallPart = { ...groceriesPart, cents: 200 };
	const partWithoutBill = {
		id: PART_MEMBERSHIP,
		cents: 4000,
		categoryId: KIDS,
	};
	// The parts a $42.00 purchase splits into, one of which the membership's $40.00 still matches within 10%.
	const replacement = [
		{ categoryId: KIDS, amountCents: 3800 },
		{ categoryId: GROCERIES, amountCents: 400 },
	];

	it("leaves no dismissal through two replacements", async () => {
		await seedSplit([membershipPart, smallPart]);
		await saveSplit(
			db,
			PURCHASE,
			[
				{ categoryId: KIDS, amountCents: 3500 },
				{ categoryId: GROCERIES, amountCents: 700 },
			],
			"test",
		);
		await saveSplit(
			db,
			PURCHASE,
			[
				{ categoryId: KIDS, amountCents: 3000 },
				{ categoryId: GROCERIES, amountCents: 1200 },
			],
			"test",
		);
		await matchBillPayments(db, TODAY);

		expect(await dismissedPayments(MEMBERSHIP)).toEqual([]);
		expect(await linkedPeriods(MEMBERSHIP)).toEqual(new Set());
	});

	it("keeps a person's own Not this one on the purchase when the split is removed", async () => {
		await seedSplit([membershipPart, smallPart]);
		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, '2026', ?, 'user', 'dismissed')",
			)
			.bind(MEMBERSHIP, PURCHASE)
			.run();

		await removeSplit(db, PURCHASE, "test");
		await matchBillPayments(db, TODAY);

		expect(await linkedPeriods(MEMBERSHIP)).toEqual(new Set());
		expect(await dismissedPayments(MEMBERSHIP)).toEqual([
			{
				transaction_id: PURCHASE,
				period: "2026",
				matched_by: "user",
				status: "dismissed",
			},
		]);
	});

	it("keeps a person's own Not this one on the purchase when the parts are replaced", async () => {
		await seedSplit([membershipPart, smallPart]);
		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, '2026', ?, 'user', 'dismissed')",
			)
			.bind(MEMBERSHIP, PURCHASE)
			.run();

		await saveSplit(
			db,
			PURCHASE,
			[
				{ categoryId: KIDS, amountCents: 3500 },
				{ categoryId: GROCERIES, amountCents: 700 },
			],
			"test",
		);

		// The purchase keeps its own, and each new part starts with it.
		expect(await dismissedPayments(MEMBERSHIP)).toEqual(
			[PURCHASE, ...(await partIds(PURCHASE))].map(userDismissal),
		);
	});

	it("keeps a person's Not this one on a part on the purchase when the split is removed", async () => {
		await seedSplit([partWithoutBill, smallPart]);
		await notThisOne(PART_MEMBERSHIP);

		await removeSplit(db, PURCHASE, "test");
		await matchBillPayments(db, TODAY);

		expect(await linkedPeriods(MEMBERSHIP)).toEqual(new Set());
		expect(await dismissedPayments(MEMBERSHIP)).toEqual([
			userDismissal(PURCHASE),
		]);
	});

	it("keeps a person's Not this one on a part on the purchase and on each new part when the parts are replaced", async () => {
		await seedSplit([partWithoutBill, smallPart]);
		await notThisOne(PART_MEMBERSHIP);

		await saveSplit(db, PURCHASE, replacement, "test");
		await matchBillPayments(db, TODAY);

		expect(await dismissedPayments(MEMBERSHIP)).toEqual(
			[PURCHASE, ...(await partIds(PURCHASE))].map(userDismissal),
		);
		expect(await linkedPeriods(MEMBERSHIP)).toEqual(new Set());
	});

	it("gives every part of a first split the Not this one the unsplit purchase has", async () => {
		await seedPurchase();
		await notThisOne(PURCHASE);

		await saveSplit(db, PURCHASE, replacement, "test");
		await matchBillPayments(db, TODAY);

		expect(await dismissedPayments(MEMBERSHIP)).toEqual(
			[PURCHASE, ...(await partIds(PURCHASE))].map(userDismissal),
		);
		expect(await linkedPeriods(MEMBERSHIP)).toEqual(new Set());
	});

	it("starts a split made after a removal with the purchase's Not this one", async () => {
		await seedPurchase();
		await notThisOne(PURCHASE);
		await saveSplit(db, PURCHASE, replacement, "test");
		await removeSplit(db, PURCHASE, "test");

		await saveSplit(db, PURCHASE, replacement, "test");
		await matchBillPayments(db, TODAY);

		expect(await dismissedPayments(MEMBERSHIP)).toEqual(
			[PURCHASE, ...(await partIds(PURCHASE))].map(userDismissal),
		);
		expect(await linkedPeriods(MEMBERSHIP)).toEqual(new Set());
	});

	it("keeps a payment a person linked by hand on its new part, with no dismissal left behind", async () => {
		await seedSplit([membershipPart, smallPart]);
		await db
			.prepare(
				"UPDATE bill_payments SET matched_by = 'user' WHERE transaction_id = ?",
			)
			.bind(PART_MEMBERSHIP)
			.run();

		await saveSplit(
			db,
			PURCHASE,
			[
				{ categoryId: KIDS, amountCents: 4000 },
				{ categoryId: GROCERIES, amountCents: 200 },
			],
			"test",
		);

		const [kept] = await partIds(PURCHASE);
		expect(await linkedOn(MEMBERSHIP)).toMatchObject([
			{ transactionId: kept, parentId: PURCHASE, matchedBy: "user" },
		]);
		expect(await dismissedPayments(MEMBERSHIP)).toEqual([]);
	});

	it("keeps a part's Not this one when a hand-linked payment for the same bill is kept beside it", async () => {
		await seedSplit([membershipPart, smallPart]);
		await db
			.prepare(
				"UPDATE bill_payments SET matched_by = 'user' WHERE transaction_id = ?",
			)
			.bind(PART_MEMBERSHIP)
			.run();
		await notThisOne(PART_GROCERIES);

		await saveSplit(
			db,
			PURCHASE,
			[
				{ categoryId: KIDS, amountCents: 4000 },
				{ categoryId: GROCERIES, amountCents: 200 },
			],
			"test",
		);

		const parts = await partIds(PURCHASE);
		expect(await linkedOn(MEMBERSHIP)).toMatchObject([
			{ transactionId: parts[0], matchedBy: "user" },
		]);
		expect(await dismissedPayments(MEMBERSHIP)).toEqual(
			[PURCHASE, ...parts].map(userDismissal),
		);
	});

	it("gives a new split of the purchase no dismissal, after removeSplit", async () => {
		await seedSplit([membershipPart, smallPart]);
		await removeSplit(db, PURCHASE, "test");
		await saveSplit(
			db,
			PURCHASE,
			[
				{ categoryId: KIDS, amountCents: 4000 },
				{ categoryId: GROCERIES, amountCents: 200 },
			],
			"test",
		);
		await matchBillPayments(db, TODAY);

		const parts = await partIds(PURCHASE);
		expect(parts).toHaveLength(2);
		expect(await dismissedPayments(MEMBERSHIP)).toEqual([]);
		// The part that is $40.00 matches the bill again, so the matcher links it.
		expect(await linkedOn(MEMBERSHIP)).toMatchObject([
			{ transactionId: parts[0], amountCents: 4000, matchedBy: "auto" },
		]);
	});

	it("links the bill to the purchase when a replacement unlinked it and the split is then removed", async () => {
		await seedSplit([membershipPart, smallPart]);
		await saveSplit(
			db,
			PURCHASE,
			[
				{ categoryId: KIDS, amountCents: 3500 },
				{ categoryId: GROCERIES, amountCents: 700 },
			],
			"test",
		);
		await removeSplit(db, PURCHASE, "test");
		await matchBillPayments(db, TODAY);

		expect(await dismissedPayments(MEMBERSHIP)).toEqual([]);
		expect(await linkedOn(MEMBERSHIP)).toMatchObject([
			{ transactionId: PURCHASE, parentId: null, matchedBy: "auto" },
		]);
	});
});

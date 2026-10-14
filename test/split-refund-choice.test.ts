import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { loadMonth } from "../src/db/month";
import { saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";

const db = env.DB;
const GROCERIES = 1;
const KIDS = 4;
const HOUSEHOLD = 5;
const PURCHASE = 9101;
/** $45.00 on Sep 5, and $20.00 on Sep 6: both refund the purchase. */
const FIRST = 9102;
const SECOND = 9103;
const PARTS = [
	{ categoryId: KIDS, amountCents: 6000 },
	{ categoryId: HOUSEHOLD, amountCents: 4000 },
];

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare(`INSERT INTO transactions
			(id, account_id, date, amount_cents, raw_name, category_id, category_source, is_split, parent_id) VALUES
			(${PURCHASE}, 3, '2026-09-01', 10000, 'WAREHOUSE CLUB', ${GROCERIES}, 'user', 0, NULL)`),
		db.prepare(`INSERT INTO transactions
			(id, account_id, date, amount_cents, raw_name, category_id, category_source, is_split, parent_id, refund_of_id, credit_reviewed, credit_reviewed_by) VALUES
			(${FIRST}, 3, '2026-09-05', -4500, 'WAREHOUSE CLUB', ${GROCERIES}, 'user', 0, NULL, ${PURCHASE}, 1, 'user'),
			(${SECOND}, 3, '2026-09-06', -2000, 'WAREHOUSE CLUB', ${GROCERIES}, 'user', 0, NULL, ${PURCHASE}, 1, 'user')`),
	]);
});

const linkOf = async (id: number) =>
	(
		await db
			.prepare("SELECT refund_of_id AS r FROM transactions WHERE id = ?")
			.bind(id)
			.first<{ r: number | null }>()
	)?.r ?? null;

/** The purchase's parts in sheet order (ids ascend with the insert order). */
const partIds = async (parent: number) =>
	(
		await db
			.prepare("SELECT id FROM transactions WHERE parent_id = ? ORDER BY id")
			.bind(parent)
			.all<{ id: number }>()
	).results.map((row) => row.id);

const spent = async (categoryId: number) =>
	(await loadMonth(db, "2026-09")).transactions
		.filter((t) => !t.income && t.categoryId === categoryId)
		.reduce((sum, t) => sum + t.amountCents, 0);

describe("saveSplit keeps a linked refund on the part it is chosen for", () => {
	it("moves the chosen refund onto that part and unlinks the one left Not linked", async () => {
		const result = await saveSplit(db, PURCHASE, PARTS, "test", {
			[FIRST]: 0,
			[SECOND]: null,
		});
		const [kids] = await partIds(PURCHASE);
		expect(result).toEqual({
			saved: true,
			unlinked: ["2026-09-06"],
			bills: [],
			moved: [{ date: "2026-09-05", part: 0 }],
		});
		expect(await linkOf(FIRST)).toBe(kids);
		expect(await linkOf(SECOND)).toBeNull();
		expect(await linkOf(PURCHASE)).toBeNull();
	});

	it("counts the chosen refund in that part's category and month", async () => {
		const before = await spent(KIDS);
		await saveSplit(db, PURCHASE, PARTS, "test", { [FIRST]: 0 });
		// The new Kids part adds $60.00; the $45.00 refund it keeps takes its share off the same category.
		expect((await spent(KIDS)) - before).toBe(1500);
	});

	it("unlinks every linked refund when no choice is given, as before", async () => {
		const result = await saveSplit(db, PURCHASE, PARTS, "test");
		expect(result).toEqual({
			saved: true,
			unlinked: ["2026-09-05", "2026-09-06"],
			bills: [],
			moved: [],
		});
		expect(await linkOf(FIRST)).toBeNull();
		expect(await linkOf(SECOND)).toBeNull();
	});

	it("keeps two refunds on two different parts", async () => {
		const result = await saveSplit(db, PURCHASE, PARTS, "test", {
			[FIRST]: 0,
			[SECOND]: 1,
		});
		const [kids, household] = await partIds(PURCHASE);
		expect(result.unlinked).toEqual([]);
		expect(result.moved).toEqual([
			{ date: "2026-09-05", part: 0 },
			{ date: "2026-09-06", part: 1 },
		]);
		expect(await linkOf(FIRST)).toBe(kids);
		expect(await linkOf(SECOND)).toBe(household);
	});

	it("checks two refunds chosen for one part together", async () => {
		// $45.00 fits the $60.00 part; the $20.00 that follows does not (it would make $65.00).
		const result = await saveSplit(db, PURCHASE, PARTS, "test", {
			[FIRST]: 0,
			[SECOND]: 0,
		});
		const [kids] = await partIds(PURCHASE);
		expect(result.moved).toEqual([{ date: "2026-09-05", part: 0 }]);
		expect(result.unlinked).toEqual(["2026-09-06"]);
		expect(await linkOf(FIRST)).toBe(kids);
		expect(await linkOf(SECOND)).toBeNull();
	});

	it("refuses a refund too big for its part, and unlinks it rather than leaving it dangling", async () => {
		// $45.00 does not fit the $40.00 part.
		const result = await saveSplit(db, PURCHASE, PARTS, "test", {
			[FIRST]: 1,
			[SECOND]: null,
		});
		expect(result.moved).toEqual([]);
		expect(result.unlinked).toEqual(["2026-09-05", "2026-09-06"]);
		expect(await linkOf(FIRST)).toBeNull();
	});

	it("refuses a refund chosen for a part that is not among the new parts", async () => {
		const result = await saveSplit(db, PURCHASE, PARTS, "test", {
			[FIRST]: 5,
		});
		expect(result.moved).toEqual([]);
		expect(await linkOf(FIRST)).toBeNull();
	});

	it("writes nothing when the purchase changed before the save, so a chosen refund stays where it was", async () => {
		await db
			.prepare("UPDATE transactions SET amount_cents = 9000 WHERE id = ?")
			.bind(PURCHASE)
			.run();
		const result = await saveSplit(db, PURCHASE, PARTS, "test", {
			[FIRST]: 0,
			[SECOND]: 1,
		});
		expect(result).toEqual({
			saved: false,
			unlinked: [],
			bills: [],
			moved: [],
		});
		expect(await linkOf(FIRST)).toBe(PURCHASE);
		expect(await linkOf(SECOND)).toBe(PURCHASE);
	});

	it("re-splitting moves a refund from an old part to the new part it is chosen for", async () => {
		await saveSplit(db, PURCHASE, PARTS, "test", { [FIRST]: 0 });
		const [oldKids] = await partIds(PURCHASE);
		expect(await linkOf(FIRST)).toBe(oldKids);
		const again = [
			{ categoryId: HOUSEHOLD, amountCents: 5000 },
			{ categoryId: KIDS, amountCents: 5000 },
		];
		const result = await saveSplit(db, PURCHASE, again, "test", {
			[FIRST]: 1,
		});
		const [, newKids] = await partIds(PURCHASE);
		expect(result.moved).toEqual([{ date: "2026-09-05", part: 1 }]);
		expect(await linkOf(FIRST)).toBe(newKids);
	});

	it("re-splitting unlinks a refund from an old part when the new part is too small for it", async () => {
		await saveSplit(db, PURCHASE, PARTS, "test", { [FIRST]: 0 });
		const smaller = [
			{ categoryId: KIDS, amountCents: 4000 },
			{ categoryId: HOUSEHOLD, amountCents: 6000 },
		];
		const result = await saveSplit(db, PURCHASE, smaller, "test", {
			[FIRST]: 0,
		});
		expect(result.moved).toEqual([]);
		expect(result.unlinked).toEqual(["2026-09-05"]);
		expect(await linkOf(FIRST)).toBeNull();
	});
});

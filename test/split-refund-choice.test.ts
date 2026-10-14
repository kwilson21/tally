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

	it("counts a split refund once, by its own row, not once for each of its parts", async () => {
		// FIRST ($45.00) is split in two parts that stay linked to the purchase; the purchase's split then unlinks it.
		await saveSplit(
			db,
			FIRST,
			[
				{ categoryId: KIDS, amountCents: -2500 },
				{ categoryId: HOUSEHOLD, amountCents: -2000 },
			],
			"test",
		);
		const result = await saveSplit(db, PURCHASE, PARTS, "test");
		expect(result.unlinked).toEqual(["2026-09-05", "2026-09-06"]);
		expect(await linkOf(FIRST)).toBeNull();
	});

	it("names a split refund linked only through one of its parts", async () => {
		await saveSplit(
			db,
			FIRST,
			[
				{ categoryId: KIDS, amountCents: -2500 },
				{ categoryId: HOUSEHOLD, amountCents: -2000 },
			],
			"test",
		);
		const [kids, household] = await partIds(FIRST);
		// The refund's own row, its Kids part and the second refund are not linked.
		// Only the Household part still points at the purchase.
		await db.batch([
			db
				.prepare(
					"UPDATE transactions SET refund_of_id = NULL WHERE id IN (?, ?, ?)",
				)
				.bind(FIRST, kids, SECOND),
			db
				.prepare("UPDATE transactions SET refund_of_id = ? WHERE id = ?")
				.bind(PURCHASE, household),
		]);
		const result = await saveSplit(db, PURCHASE, PARTS, "test");
		expect(result.unlinked).toEqual(["2026-09-05"]);
	});

	it("names a split refund once when both of its parts are linked and its own row is not", async () => {
		await saveSplit(
			db,
			FIRST,
			[
				{ categoryId: KIDS, amountCents: -2500 },
				{ categoryId: HOUSEHOLD, amountCents: -2000 },
			],
			"test",
		);
		const [kids, household] = await partIds(FIRST);
		await db.batch([
			db
				.prepare(
					"UPDATE transactions SET refund_of_id = NULL WHERE id IN (?, ?)",
				)
				.bind(FIRST, SECOND),
			db
				.prepare("UPDATE transactions SET refund_of_id = ? WHERE id IN (?, ?)")
				.bind(PURCHASE, kids, household),
		]);
		const result = await saveSplit(db, PURCHASE, PARTS, "test");
		expect(result.unlinked).toEqual(["2026-09-05"]);
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

/** A $100.00 purchase that a competing save can relink a refund to while a split is saving. */
const OTHER = 9104;

/**
 * A db whose batch first runs one statement, as a competing save landing between this save's read and its write.
 * The save reads its linked refunds before the batch, so the statement is what that read did not see.
 */
const racingWith = (race: string, bind: (number | null)[]) =>
	new Proxy(env.DB, {
		get(target, prop) {
			if (prop === "batch")
				return async (statements: D1PreparedStatement[]) => {
					await env.DB.prepare(race)
						.bind(...bind)
						.run();
					return env.DB.batch(statements);
				};
			const value = Reflect.get(target, prop);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as unknown as D1Database;

describe("a chosen refund moves only while it is still linked to the purchase when the save writes", () => {
	beforeEach(async () => {
		await db
			.prepare(`INSERT INTO transactions
			(id, account_id, date, amount_cents, raw_name, category_id, category_source, is_split, parent_id) VALUES
			(${OTHER}, 3, '2026-09-01', 10000, 'OTHER SHOP', ${GROCERIES}, 'user', 0, NULL)`)
			.run();
	});

	it("leaves a refund a competing save relinked to another purchase where it is, and names nothing", async () => {
		const racing = racingWith(
			"UPDATE transactions SET refund_of_id = ? WHERE id = ?",
			[OTHER, FIRST],
		);
		const result = await saveSplit(racing, PURCHASE, PARTS, "test", {
			[FIRST]: 0,
			[SECOND]: 1,
		});
		const [, household] = await partIds(PURCHASE);
		expect(result.saved).toBe(true);
		expect(await linkOf(FIRST)).toBe(OTHER);
		expect(await linkOf(SECOND)).toBe(household);
		expect(result.moved).toEqual([{ date: "2026-09-06", part: 1 }]);
		expect(result.unlinked).toEqual([]);
	});

	it("leaves a refund on an old part that a competing save relinked elsewhere, and names nothing", async () => {
		await saveSplit(db, PURCHASE, PARTS, "test", {
			[FIRST]: 0,
			[SECOND]: null,
		});
		const racing = racingWith(
			"UPDATE transactions SET refund_of_id = ? WHERE id = ?",
			[OTHER, FIRST],
		);
		const result = await saveSplit(racing, PURCHASE, PARTS, "test", {
			[FIRST]: 0,
			[SECOND]: null,
		});
		expect(result.saved).toBe(true);
		expect(await linkOf(FIRST)).toBe(OTHER);
		expect(result.moved).toEqual([]);
		expect(result.unlinked).toEqual([]);
	});

	it("leaves a refund a competing save unlinked where it is, and names nothing", async () => {
		const racing = racingWith(
			"UPDATE transactions SET refund_of_id = NULL WHERE id = ?",
			[FIRST],
		);
		const result = await saveSplit(racing, PURCHASE, PARTS, "test", {
			[FIRST]: 0,
			[SECOND]: 1,
		});
		expect(result.saved).toBe(true);
		expect(await linkOf(FIRST)).toBeNull();
		expect(result.moved).toEqual([{ date: "2026-09-06", part: 1 }]);
		expect(result.unlinked).toEqual([]);
	});

	it("unlinks and names a chosen refund that a competing save marked as income, rather than moving it", async () => {
		const racing = racingWith(
			"UPDATE transactions SET flag_income = 1 WHERE id = ?",
			[FIRST],
		);
		const result = await saveSplit(racing, PURCHASE, PARTS, "test", {
			[FIRST]: 0,
			[SECOND]: 1,
		});
		const [, household] = await partIds(PURCHASE);
		expect(result).toEqual({
			saved: true,
			unlinked: ["2026-09-05"],
			bills: [],
			moved: [{ date: "2026-09-06", part: 1 }],
		});
		expect(await linkOf(FIRST)).toBeNull();
		expect(await linkOf(SECOND)).toBe(household);
	});

	it("unlinks and names a chosen refund that a competing save left unreviewed, rather than moving it", async () => {
		const racing = racingWith(
			"UPDATE transactions SET credit_reviewed = 0 WHERE id = ?",
			[FIRST],
		);
		const result = await saveSplit(racing, PURCHASE, PARTS, "test", {
			[FIRST]: 0,
			[SECOND]: 1,
		});
		const [, household] = await partIds(PURCHASE);
		expect(result).toEqual({
			saved: true,
			unlinked: ["2026-09-05"],
			bills: [],
			moved: [{ date: "2026-09-06", part: 1 }],
		});
		expect(await linkOf(FIRST)).toBeNull();
		expect(await linkOf(SECOND)).toBe(household);
	});

	it("unlinks and names a chosen refund that a competing save split, rather than moving it", async () => {
		const racing = racingWith(
			"UPDATE transactions SET is_split = 1 WHERE id = ?",
			[FIRST],
		);
		const result = await saveSplit(racing, PURCHASE, PARTS, "test", {
			[FIRST]: 0,
			[SECOND]: 1,
		});
		const [, household] = await partIds(PURCHASE);
		expect(result).toEqual({
			saved: true,
			unlinked: ["2026-09-05"],
			bills: [],
			moved: [{ date: "2026-09-06", part: 1 }],
		});
		expect(await linkOf(FIRST)).toBeNull();
		expect(await linkOf(SECOND)).toBe(household);
	});

	it("names a chosen refund's date as the competing save wrote it, not as it was read", async () => {
		const racing = racingWith(
			"UPDATE transactions SET date = '2026-09-08' WHERE id = ?",
			[FIRST],
		);
		const result = await saveSplit(racing, PURCHASE, PARTS, "test", {
			[FIRST]: 0,
			[SECOND]: 1,
		});
		expect(result.saved).toBe(true);
		expect(result.moved).toEqual([
			{ date: "2026-09-08", part: 0 },
			{ date: "2026-09-06", part: 1 },
		]);
		expect(result.unlinked).toEqual([]);
	});

	it("unlinks and names every chosen refund when a competing save excludes the purchase", async () => {
		const racing = racingWith(
			"UPDATE transactions SET excluded = 1 WHERE id = ?",
			[PURCHASE],
		);
		const result = await saveSplit(racing, PURCHASE, PARTS, "test", {
			[FIRST]: 0,
			[SECOND]: 1,
		});
		expect(result).toEqual({
			saved: true,
			unlinked: ["2026-09-05", "2026-09-06"],
			bills: [],
			moved: [],
		});
		expect(await linkOf(FIRST)).toBeNull();
		expect(await linkOf(SECOND)).toBeNull();
	});

	it("unlinks and names a chosen refund on an old part that a competing save marked as income", async () => {
		await saveSplit(db, PURCHASE, PARTS, "test", { [FIRST]: 0 });
		const racing = racingWith(
			"UPDATE transactions SET flag_income = 1 WHERE id = ?",
			[FIRST],
		);
		const result = await saveSplit(racing, PURCHASE, PARTS, "test", {
			[FIRST]: 0,
		});
		expect(result).toEqual({
			saved: true,
			unlinked: ["2026-09-05"],
			bills: [],
			moved: [],
		});
		expect(await linkOf(FIRST)).toBeNull();
	});

	it("names only the refunds this save unlinked, not one a competing save relinked after the read", async () => {
		const racing = racingWith(
			"UPDATE transactions SET refund_of_id = ? WHERE id = ?",
			[OTHER, SECOND],
		);
		const result = await saveSplit(racing, PURCHASE, PARTS, "test", {
			[FIRST]: 0,
			[SECOND]: null,
		});
		expect(result).toEqual({
			saved: true,
			unlinked: [],
			bills: [],
			moved: [{ date: "2026-09-05", part: 0 }],
		});
		expect(await linkOf(SECOND)).toBe(OTHER);
	});

	it("names a refund the split unlinks even when a competing save linked it after the read", async () => {
		await db
			.prepare(`INSERT INTO transactions
			(id, account_id, date, amount_cents, raw_name, category_id, category_source, is_split, parent_id, credit_reviewed, credit_reviewed_by) VALUES
			(9105, 3, '2026-09-07', -500, 'WAREHOUSE CLUB', ${GROCERIES}, 'user', 0, NULL, 1, 'user')`)
			.run();
		const racing = racingWith(
			"UPDATE transactions SET refund_of_id = ? WHERE id = ?",
			[PURCHASE, 9105],
		);
		const result = await saveSplit(racing, PURCHASE, PARTS, "test", {
			[FIRST]: 0,
			[SECOND]: 1,
		});
		expect(result.unlinked).toEqual(["2026-09-07"]);
		expect(await linkOf(9105)).toBeNull();
	});
});

describe("a purchase with a dormant refund link of its own still names the refunds a split unlinks", () => {
	beforeEach(async () => {
		// PURCHASE was a refund of OTHER before its bank amount turned positive, so its own link is dormant: the parts keep it.
		await db
			.prepare(`INSERT INTO transactions
			(id, account_id, date, amount_cents, raw_name, category_id, category_source, is_split, parent_id) VALUES
			(${OTHER}, 3, '2026-09-01', 10000, 'OTHER SHOP', ${GROCERIES}, 'user', 0, NULL)`)
			.run();
		await db
			.prepare("UPDATE transactions SET refund_of_id = ? WHERE id = ?")
			.bind(OTHER, PURCHASE)
			.run();
	});

	it("names every linked refund a person answers Not linked", async () => {
		const result = await saveSplit(db, PURCHASE, PARTS, "test", {
			[FIRST]: null,
			[SECOND]: null,
		});
		expect(result).toEqual({
			saved: true,
			unlinked: ["2026-09-05", "2026-09-06"],
			bills: [],
			moved: [],
		});
		expect(await linkOf(FIRST)).toBeNull();
		expect(await linkOf(SECOND)).toBeNull();
	});

	it("names the one refund answered Not linked, and moves the other to its part", async () => {
		const result = await saveSplit(db, PURCHASE, PARTS, "test", {
			[FIRST]: 0,
			[SECOND]: null,
		});
		expect(result.moved).toEqual([{ date: "2026-09-05", part: 0 }]);
		expect(result.unlinked).toEqual(["2026-09-06"]);
		expect(await linkOf(SECOND)).toBeNull();
	});
});

describe("a split refund moves with its parts, which count once in the chosen part's category and month", () => {
	const SPLIT_PURCHASE = 9401;
	const SPLIT_REFUND = 9402;
	const REFUND_KIDS = 9403;
	const REFUND_HOUSEHOLD = 9404;
	const ELSEWHERE = 9405;

	beforeEach(async () => {
		// A $100.00 purchase on Aug 20, refunded by a split refund dated Sep 5 ($30.00 and $20.00 parts, all linked to it).
		await db.batch([
			db.prepare(`INSERT INTO transactions
				(id, account_id, date, amount_cents, raw_name, category_id, category_source, is_split, parent_id) VALUES
				(${SPLIT_PURCHASE}, 3, '2026-08-20', 10000, 'BIG STORE', ${GROCERIES}, 'user', 0, NULL),
				(${ELSEWHERE}, 3, '2026-08-02', 2000, 'ELSEWHERE SHOP', ${GROCERIES}, 'user', 0, NULL)`),
			db.prepare(`INSERT INTO transactions
				(id, account_id, date, amount_cents, raw_name, category_id, category_source, is_split, parent_id, refund_of_id, credit_reviewed, credit_reviewed_by) VALUES
				(${SPLIT_REFUND}, 3, '2026-09-05', -5000, 'BIG STORE', ${GROCERIES}, 'user', 1, NULL, ${SPLIT_PURCHASE}, 1, 'user'),
				(${REFUND_KIDS}, 3, '2026-09-05', -3000, 'BIG STORE', ${GROCERIES}, 'user', 0, ${SPLIT_REFUND}, ${SPLIT_PURCHASE}, 1, 'user'),
				(${REFUND_HOUSEHOLD}, 3, '2026-09-05', -2000, 'BIG STORE', ${GROCERIES}, 'user', 0, ${SPLIT_REFUND}, ${SPLIT_PURCHASE}, 1, 'user')`),
		]);
	});

	/** What a category counts in a month, as the month's transactions show it (a linked refund in its purchase's). */
	const spentIn = async (month: string, categoryId: number) =>
		(await loadMonth(db, month)).transactions
			.filter((t) => !t.income && t.categoryId === categoryId)
			.reduce((sum, t) => sum + t.amountCents, 0);

	it("moves the split refund onto the part chosen for it, and both of its parts follow it", async () => {
		const result = await saveSplit(db, SPLIT_PURCHASE, PARTS, "test", {
			[SPLIT_REFUND]: 0,
		});
		const [kids] = await partIds(SPLIT_PURCHASE);
		expect(result).toEqual({
			saved: true,
			unlinked: [],
			bills: [],
			moved: [{ date: "2026-09-05", part: 0 }],
		});
		expect(await linkOf(SPLIT_REFUND)).toBe(kids);
		expect(await linkOf(REFUND_KIDS)).toBe(kids);
		expect(await linkOf(REFUND_HOUSEHOLD)).toBe(kids);
	});

	it("counts the parts once each, in the chosen part's category and in the purchase's month", async () => {
		const augustBefore = await spentIn("2026-08", KIDS);
		const septemberBefore = await spentIn("2026-09", KIDS);
		await saveSplit(db, SPLIT_PURCHASE, PARTS, "test", { [SPLIT_REFUND]: 0 });
		// The new Kids part adds $60.00 to August; the $50.00 refund's two parts take $50.00 off it, once each.
		expect((await spentIn("2026-08", KIDS)) - augustBefore).toBe(1000);
		expect((await spentIn("2026-09", KIDS)) - septemberBefore).toBe(0);
	});

	it("moves only the parts that still follow the split refund, leaving one linked elsewhere where it is", async () => {
		await db
			.prepare("UPDATE transactions SET refund_of_id = ? WHERE id = ?")
			.bind(ELSEWHERE, REFUND_HOUSEHOLD)
			.run();
		const result = await saveSplit(db, SPLIT_PURCHASE, PARTS, "test", {
			[SPLIT_REFUND]: 0,
		});
		const [kids] = await partIds(SPLIT_PURCHASE);
		expect(result.moved).toEqual([{ date: "2026-09-05", part: 0 }]);
		expect(await linkOf(SPLIT_REFUND)).toBe(kids);
		expect(await linkOf(REFUND_KIDS)).toBe(kids);
		expect(await linkOf(REFUND_HOUSEHOLD)).toBe(ELSEWHERE);
	});

	it("refuses a split refund too big for the part chosen for it, and names it once with its parts", async () => {
		const result = await saveSplit(
			db,
			SPLIT_PURCHASE,
			[
				{ categoryId: KIDS, amountCents: 4000 },
				{ categoryId: HOUSEHOLD, amountCents: 6000 },
			],
			"test",
			{ [SPLIT_REFUND]: 0 },
		);
		expect(result.moved).toEqual([]);
		expect(result.unlinked).toEqual(["2026-09-05"]);
		expect(await linkOf(SPLIT_REFUND)).toBeNull();
		expect(await linkOf(REFUND_KIDS)).toBeNull();
		expect(await linkOf(REFUND_HOUSEHOLD)).toBeNull();
	});

	it("unlinks a split refund answered Not linked with its parts, and names it once", async () => {
		const result = await saveSplit(db, SPLIT_PURCHASE, PARTS, "test", {
			[SPLIT_REFUND]: null,
		});
		expect(result).toEqual({
			saved: true,
			unlinked: ["2026-09-05"],
			bills: [],
			moved: [],
		});
		expect(await linkOf(SPLIT_REFUND)).toBeNull();
		expect(await linkOf(REFUND_KIDS)).toBeNull();
		expect(await linkOf(REFUND_HOUSEHOLD)).toBeNull();
	});

	it("re-splitting moves a split refund and its parts from an old part to the new part chosen for it", async () => {
		await saveSplit(db, SPLIT_PURCHASE, PARTS, "test", { [SPLIT_REFUND]: 0 });
		// The purchase is split again with the Household part first, and the refund is chosen for the Kids part.
		const again = [
			{ categoryId: HOUSEHOLD, amountCents: 4000 },
			{ categoryId: KIDS, amountCents: 6000 },
		];
		const result = await saveSplit(db, SPLIT_PURCHASE, again, "test", {
			[SPLIT_REFUND]: 1,
		});
		const [, kids] = await partIds(SPLIT_PURCHASE);
		expect(result).toEqual({
			saved: true,
			unlinked: [],
			bills: [],
			moved: [{ date: "2026-09-05", part: 1 }],
		});
		expect(await linkOf(SPLIT_REFUND)).toBe(kids);
		expect(await linkOf(REFUND_KIDS)).toBe(kids);
		expect(await linkOf(REFUND_HOUSEHOLD)).toBe(kids);
	});
});

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeMonth } from "../src/budget";
import { categorizePending } from "../src/categorize-pending";
import { saveAiSwitches } from "../src/db/ai-switches";
import { loadMonth } from "../src/db/month";
import {
	excludedBreakdown,
	listTransactions,
	monthCounts,
	needsCategoryCount,
	pendingForJev,
	saveEdit,
	saveJevResult,
	saveSplit,
} from "../src/db/transactions";
import { loadTrends } from "../src/db/trends";
import { resetDemo } from "../src/demo/reset";
import { parseFilters } from "../src/transactions/filters";
import { rowCaption } from "../src/views/transaction-row";

// Spec §6.1 rule 4 and §8.5: a payment linked to a bill counts in Spent, whatever its exclusion, so the
// bill counts once. It is decided where spending is read; linking and unlinking never write the
// transaction's exclusion, so a machine's or a person's choice is always as it was.

const db = env.DB;
const TODAY = "2026-09-22";
const MONTH = "2026-09";

type Source = "plaid" | "jev" | "user";

const spendFor = async () =>
	summarizeMonth({
		month: MONTH,
		...(await loadMonth(db, MONTH)),
		unpaidDueBillsCents: 0,
	}).totalSpentCents;

const trendFor = async () =>
	(await loadTrends(db, TODAY)).spend
		.filter((row) => row.month === MONTH)
		.reduce((sum, row) => sum + row.cents, 0);

const excludedListed = async () =>
	(await listTransactions(db, excludedFilter())).total;

const excludedFilter = () =>
	parseFilters(new URLSearchParams("excluded=1"), MONTH);

/** Everything that reads "what counts", in one place, so they can be compared. */
const readings = async () => ({
	home: await spendFor(),
	trends: await trendFor(),
	counted: (await monthCounts(db, MONTH)).counted,
	needsCategory: await needsCategoryCount(db, MONTH),
	breakdownExcluded: await excludedBreakdown(db, MONTH).then(
		(b) => b.transfer + b.reimbursement + b.byPerson,
	),
	filterExcluded: await excludedListed(),
});

const link = (transactionId: number, by: "auto" | "user" = "auto") =>
	db
		.prepare(
			"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (9500, ?, ?, ?, 'linked')",
		)
		.bind(MONTH, transactionId, by);

const unlink = () =>
	db.prepare("DELETE FROM bill_payments WHERE bill_id = 9500");

const stored = async (...ids: number[]) =>
	(
		await db
			.prepare(
				`SELECT id, excluded, excluded_source FROM transactions WHERE id IN (${ids.join(",")}) ORDER BY id`,
			)
			.all()
	).results;

const rowOf = async (id: number) => {
	const { rows } = await listTransactions(
		db,
		parseFilters(new URLSearchParams("month=all&q=LANDLORD"), MONTH),
	);
	return rows.find((row) => row.id === id);
};

/** A 1500.00 payment the machine or a person excluded. */
const addPayment = (source: Source) =>
	db
		.prepare(
			`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded, excluded_source, plaid_category, flag_transfer)
			 SELECT 9501, id, '2026-09-04', 150000, 'LANDLORD LLC', 1, ?1,
				CASE WHEN ?1 = 'plaid' THEN 'LOAN_PAYMENTS' END, CASE WHEN ?1 = 'jev' THEN 1 ELSE 0 END FROM accounts LIMIT 1`,
		)
		.bind(source);

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await saveAiSwitches(db, { details: false });
	await db
		.prepare(
			"INSERT INTO bills (id, name, amount_cents, due_day, frequency, category_id, merchant_raw_name) VALUES (9500, 'Mortgage', 150000, 5, 'monthly', 5, 'LANDLORD LLC')",
		)
		.run();
});

describe("a payment linked to a bill", () => {
	it.each(["plaid", "jev", "user"] as const)(
		"counts in Home, Trends and How Tally works while it pays a bill, and stops when the link goes (%s-excluded)",
		async (source) => {
			await addPayment(source).run();
			const before = await readings();
			const exclusion = { id: 9501, excluded: 1, excluded_source: source };
			expect(await stored(9501)).toEqual([exclusion]);

			await link(9501, source === "user" ? "user" : "auto").run();
			const linked = await readings();
			// Spent, Trends and the counted number take it in, and the excluded number and filter let it go,
			// so the month still adds up.
			expect(linked).toEqual({
				home: before.home + 150000,
				trends: before.trends + 150000,
				counted: before.counted + 1,
				// It has no category, so it needs one like anything else that counts.
				needsCategory: before.needsCategory,
				breakdownExcluded: before.breakdownExcluded - 1,
				filterExcluded: before.filterExcluded - 1,
			});
			// Linking wrote nothing to the exclusion.
			expect(await stored(9501)).toEqual([exclusion]);
			// And the list doesn't call it excluded: it says what it is, a payment that counts.
			const row = await rowOf(9501);
			expect(row).toMatchObject({
				excluded: true,
				paysBill: true,
				categoryName: "Household",
				billName: "Mortgage",
			});
			expect(rowCaption(row as NonNullable<typeof row>).caption).toBe(
				"Household · paid Mortgage bill",
			);
			expect(rowCaption(row as NonNullable<typeof row>).kind).not.toBe(
				"excluded",
			);

			await unlink().run();
			expect(await readings()).toEqual(before);
			expect(
				await env.DB.prepare(
					"SELECT category_id,category_source FROM transactions WHERE id=9501",
				).first(),
			).toEqual({ category_id: 5, category_source: "bill" });
			expect(await stored(9501)).toEqual([exclusion]);
			const after = await rowOf(9501);
			expect(after).toMatchObject({ excluded: true, paysBill: false });
			expect(rowCaption(after as NonNullable<typeof after>).caption).toBe(
				"Excluded",
			);
		},
	);

	it("counts only the part that pays the bill when a split is excluded", async () => {
		await db.batch([
			db.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded, excluded_source, is_split, plaid_category)
				 SELECT 9510, id, '2026-09-04', 200000, 'LANDLORD LLC', 1, 'plaid', 1, 'TRANSFER_OUT' FROM accounts LIMIT 1`,
			),
			db.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded, excluded_source, parent_id)
				 SELECT 9511, id, '2026-09-04', 150000, 'LANDLORD LLC', 1, 'plaid', 9510 FROM accounts LIMIT 1`,
			),
			db.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded, excluded_source, parent_id)
				 SELECT 9512, id, '2026-09-04', 50000, 'ELSEWHERE', 1, 'plaid', 9510 FROM accounts LIMIT 1`,
			),
		]);
		const before = await readings();

		await link(9511).run();
		const linked = await readings();
		// The part counts; its sibling and the split's parent don't.
		expect(linked.home).toBe(before.home + 150000);
		expect(linked.trends).toBe(before.trends + 150000);
		expect(linked.counted).toBe(before.counted + 1);
		expect(linked.breakdownExcluded).toBe(before.breakdownExcluded - 1);
		expect(await stored(9510, 9511, 9512)).toEqual([
			{ id: 9510, excluded: 1, excluded_source: "plaid" },
			{ id: 9511, excluded: 1, excluded_source: "plaid" },
			{ id: 9512, excluded: 1, excluded_source: "plaid" },
		]);

		await unlink().run();
		expect(await readings()).toEqual(before);
	});

	it("counts once however it came to count: the link, a person's include, or both", async () => {
		await addPayment("user").run();
		const before = await spendFor();
		await link(9501, "user").run();
		expect(await spendFor()).toBe(before + 150000);
		// A person's include or exclude is a separate choice; excluding a linked payment still counts it.
		await db
			.prepare(
				"UPDATE transactions SET excluded = 0, excluded_source = 'user' WHERE id = 9501",
			)
			.run();
		expect(await spendFor()).toBe(before + 150000);
		await unlink().run();
		expect(await spendFor()).toBe(before + 150000);
	});
});

describe("a split whose bank transaction pays a bill", () => {
	/** A 2000.00 payment, split into 1500.00 and 500.00 after it was linked, as Plaid excluded it. */
	const addSplit = () =>
		db.batch([
			db.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded, excluded_source, is_split, plaid_category)
				 SELECT 9530, id, '2026-09-04', 200000, 'LANDLORD LLC', 1, 'plaid', 1, 'LOAN_PAYMENTS' FROM accounts LIMIT 1`,
			),
			db.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded, excluded_source, parent_id)
				 SELECT 9531, id, '2026-09-04', 150000, 'LANDLORD LLC', 1, 'plaid', 9530 FROM accounts LIMIT 1`,
			),
			db.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded, excluded_source, parent_id)
				 SELECT 9532, id, '2026-09-04', 50000, 'LANDLORD LLC', 1, 'plaid', 9530 FROM accounts LIMIT 1`,
			),
		]);

	it("counts every part on the parent's link, once, in everything that reads what counts", async () => {
		await addSplit();
		const before = await readings();

		await link(9530).run();
		const linked = await readings();
		expect(linked).toEqual({
			// The parent never counts once split; its two parts do, and together they are the payment.
			home: before.home + 200000,
			trends: before.trends + 200000,
			counted: before.counted + 2,
			needsCategory: before.needsCategory + 2,
			breakdownExcluded: before.breakdownExcluded - 2,
			// Show Excluded lists a split by its parts, as How Tally works counts it, so they move together.
			filterExcluded: before.filterExcluded - 2,
		});
		expect(await stored(9530, 9531, 9532)).toEqual(
			[9530, 9531, 9532].map((id) => ({
				id,
				excluded: 1,
				excluded_source: "plaid",
			})),
		);
		expect(await rowOf(9531)).toMatchObject({ excluded: true, paysBill: true });

		await unlink().run();
		expect(await readings()).toEqual(before);
	});

	it("counts a part once when both the parent and the part are linked", async () => {
		await addSplit();
		await db
			.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, category_id, merchant_raw_name) VALUES (9501, 'Insurance', 150000, 5, 'monthly', 5, 'LANDLORD LLC')",
			)
			.run();
		const before = await readings();

		await link(9530).run();
		const parentOnly = await readings();
		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (9501, ?, 9531, 'user', 'linked')",
			)
			.bind(MONTH)
			.run();
		// The part's own link adds nothing: it already counted through its parent.
		expect(await readings()).toEqual({
			...parentOnly,
			needsCategory: parentOnly.needsCategory - 1,
		});
		expect(parentOnly.home).toBe(before.home + 200000);

		// Without the parent's link the part still counts on its own link, and its sibling no longer does.
		await unlink().run();
		expect((await readings()).home).toBe(before.home + 150000);
		// Unlinking the parent removes it from the counted split; the directly linked part keeps its category.
		expect((await readings()).needsCategory).toBe(parentOnly.needsCategory - 2);
	});
});

describe("a payment linked to an earlier month's occurrence, then split", () => {
	const AUGUST = "2026-08";
	const spentIn = async (month: string) =>
		summarizeMonth({
			month,
			...(await loadMonth(db, month)),
			unpaidDueBillsCents: 0,
		}).totalSpentCents;
	const trendIn = async (month: string) =>
		(await loadTrends(db, TODAY)).spend
			.filter((row) => row.month === month)
			.reduce((sum, row) => sum + row.cents, 0);
	const months = async () => ({
		august: await spentIn(AUGUST),
		september: await spentIn(MONTH),
		augustTrend: await trendIn(AUGUST),
		septemberTrend: await trendIn(MONTH),
	});
	const partIds = async (parentId: number) =>
		(
			await db
				.prepare("SELECT id FROM transactions WHERE parent_id = ? ORDER BY id")
				.bind(parentId)
				.all<{ id: number }>()
		).results.map((r) => r.id);

	it.each([
		["counted", 0],
		["excluded", 1],
	] as const)(
		"keeps every part in the occurrence's month, where the whole payment counted (%s)",
		async (_, excluded) => {
			// A 1500.00 payment on September 4th, for August's occurrence: it counts in August.
			await db
				.prepare(
					`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, excluded, excluded_source)
					 SELECT 9560, id, '2026-09-04', 150000, 'LANDLORD LLC', 5, ?1, CASE WHEN ?1 = 1 THEN 'plaid' END FROM accounts LIMIT 1`,
				)
				.bind(excluded)
				.run();
			const before = await months();
			await db
				.prepare(
					"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (9500, ?, 9560, 'user', 'linked')",
				)
				.bind(AUGUST)
				.run();
			const linked = await months();
			expect(linked.august).toBe(before.august + 150000);
			expect(linked.september).toBe(before.september - (excluded ? 0 : 150000));

			const split = await saveSplit(
				db,
				9560,
				[
					{ categoryId: 5, amountCents: 100000 },
					{ categoryId: 1, amountCents: 50000 },
				],
				"test",
			);
			expect(split.saved).toBe(true);
			// Split, it is still that payment whole: Spent and Trends read every month as before.
			expect(await months()).toEqual(linked);
			const parts = await partIds(9560);
			expect(parts).toHaveLength(2);
			const { rows } = await listTransactions(
				db,
				parseFilters(new URLSearchParams(`month=${AUGUST}&q=LANDLORD`), MONTH),
			);
			for (const id of parts)
				expect(rows.find((row) => row.id === id)).toMatchObject({
					countsInMonth: AUGUST,
				});
		},
	);

	it("counts a refund of one of its parts in that part's month, as it counts", async () => {
		await db.batch([
			db.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id)
				 SELECT 9570, id, '2026-09-04', 150000, 'LANDLORD LLC', 5 FROM accounts LIMIT 1`,
			),
			db
				.prepare(
					"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (9500, ?, 9570, 'user', 'linked')",
				)
				.bind(AUGUST),
		]);
		await saveSplit(
			db,
			9570,
			[
				{ categoryId: 5, amountCents: 100000 },
				{ categoryId: 1, amountCents: 50000 },
			],
			"test",
		);
		const [part] = await partIds(9570);
		await db
			.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, credit_reviewed, credit_reviewed_by, refund_of_id)
				 SELECT 9573, id, '2026-09-10', -10000, 'LANDLORD LLC', 1, 'user', ? FROM accounts LIMIT 1`,
			)
			.bind(part)
			.run();
		const { rows } = await listTransactions(
			db,
			parseFilters(new URLSearchParams(`month=${AUGUST}&q=LANDLORD`), MONTH),
		);
		expect(rows.find((row) => row.id === 9573)).toMatchObject({
			countsInMonth: AUGUST,
		});
	});
});

// Transactions' Show choice (#210, spec §8.4) reads what counts the same way (decision 83): Spending is
// what Home counts, so a linked payment is there whatever its exclusion, and Excluded, Refunds and How
// Tally works' excluded count leave it out of "excluded" alike.
describe("the Show choice and a payment linked to a bill", () => {
	/** Every row a Show choice lists in the month, across every page. */
	const shown = async (show: string) => {
		const query = (page: number) =>
			listTransactions(
				db,
				parseFilters(
					new URLSearchParams(`month=${MONTH}&show=${show}&page=${page}`),
					MONTH,
				),
			);
		const first = await query(1);
		const rows = [...first.rows];
		for (let page = 2; page <= first.pages; page++)
			rows.push(...(await query(page)).rows);
		return rows;
	};
	const ids = async (show: string) => (await shown(show)).map((r) => r.id);
	const spendingListed = async () =>
		(await shown("spending")).reduce((sum, r) => sum + r.amountCents, 0);
	const breakdownTotal = async (month = MONTH) =>
		excludedBreakdown(db, month).then(
			(b) => b.transfer + b.reimbursement + b.byPerson,
		);
	const excludedCount = async (month = MONTH) =>
		(
			await listTransactions(
				db,
				parseFilters(
					new URLSearchParams(`month=${month}&show=excluded`),
					MONTH,
				),
			)
		).total;

	it("lists a linked, Plaid-excluded payment under Spending and not under Excluded, until the link goes", async () => {
		await addPayment("plaid").run();
		expect(await ids("spending")).not.toContain(9501);
		expect(await ids("excluded")).toContain(9501);

		await link(9501).run();
		expect(await ids("spending")).toContain(9501);
		expect(await ids("excluded")).not.toContain(9501);
		// The old Excluded chip's link reads the same.
		expect(
			(await listTransactions(db, excludedFilter())).rows.map((r) => r.id),
		).not.toContain(9501);

		await unlink().run();
		expect(await ids("spending")).not.toContain(9501);
		expect(await ids("excluded")).toContain(9501);
	});

	it("adds Spending up to Home's Spent with a linked, excluded payment and a linked split", async () => {
		await addPayment("plaid").run();
		await link(9501).run();
		expect(await spendingListed()).toBe(await spendFor());

		await db.batch([
			db.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded, excluded_source, is_split, plaid_category)
				 SELECT 9540, id, '2026-09-06', 80000, 'LANDLORD LLC', 1, 'plaid', 1, 'LOAN_PAYMENTS' FROM accounts LIMIT 1`,
			),
			db.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded, excluded_source, parent_id)
				 SELECT 9541, id, '2026-09-06', 50000, 'LANDLORD LLC', 1, 'plaid', 9540 FROM accounts LIMIT 1`,
			),
			db.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded, excluded_source, parent_id)
				 SELECT 9542, id, '2026-09-06', 30000, 'LANDLORD LLC', 1, 'plaid', 9540 FROM accounts LIMIT 1`,
			),
			db.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, category_id, merchant_raw_name) VALUES (9502, 'Storage', 80000, 6, 'monthly', 5, 'LANDLORD LLC')",
			),
			db
				.prepare(
					"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (9502, ?, 9540, 'auto', 'linked')",
				)
				.bind(MONTH),
		]);
		// The parts count on their parent's link; the parent never does.
		const spending = await ids("spending");
		expect(spending).toEqual(expect.arrayContaining([9541, 9542]));
		expect(spending).not.toContain(9540);
		expect(await spendingListed()).toBe(await spendFor());
	});

	it("counts the same excluded transactions in How Tally works as Show Excluded lists", async () => {
		await addPayment("plaid").run();
		expect(await excludedCount()).toBe(await breakdownTotal());
		await link(9501).run();
		expect(await excludedCount()).toBe(await breakdownTotal());
		await unlink().run();
		expect(await excludedCount()).toBe(await breakdownTotal());
	});

	it("reads a linked, excluded credit as a refund, never as excluded, so the two never share a row", async () => {
		// A credit the bill's payment came back as, excluded by Plaid and linked by hand.
		await db
			.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded, excluded_source, plaid_category, credit_reviewed)
				 SELECT 9550, id, '2026-09-08', -2000, 'LANDLORD LLC CREDIT', 1, 'plaid', 'TRANSFER_IN', 1 FROM accounts LIMIT 1`,
			)
			.run();
		expect(await ids("refunds")).not.toContain(9550);
		expect(await ids("excluded")).toContain(9550);

		await link(9550, "user").run();
		const refunds = await ids("refunds");
		const excluded = await ids("excluded");
		expect(refunds).toContain(9550);
		expect(excluded).not.toContain(9550);
		expect(refunds.filter((id) => excluded.includes(id))).toEqual([]);
	});

	it.each([0, 1])(
		"lists a linked credit Jev flagged as a transfer under Refunds once it leaves Excluded (reviewed: %i)",
		async (reviewed) => {
			await db
				.prepare(
					`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded, excluded_source, flag_transfer, credit_reviewed)
					 SELECT 9580, id, '2026-09-08', -2000, 'LANDLORD LLC CREDIT', 1, 'jev', 1, ? FROM accounts LIMIT 1`,
				)
				.bind(reviewed)
				.run();
			expect(await ids("refunds")).not.toContain(9580);
			expect(await ids("excluded")).toContain(9580);

			await link(9580, "user").run();
			expect(await ids("refunds")).toContain(9580);
			expect(await ids("excluded")).not.toContain(9580);

			await unlink().run();
			expect(await ids("refunds")).not.toContain(9580);
			expect(await ids("excluded")).toContain(9580);
		},
	);

	it("lists the parts of a linked credit whose parent is flagged as a transfer under Refunds", async () => {
		await db.batch([
			db.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded, excluded_source, flag_transfer, is_split, credit_reviewed)
				 SELECT 9590, id, '2026-09-08', -3000, 'LANDLORD LLC CREDIT', 1, 'jev', 1, 1, 1 FROM accounts LIMIT 1`,
			),
			...[
				[9591, -2000],
				[9592, -1000],
			].map(([id, cents]) =>
				db
					.prepare(
						`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded, excluded_source, parent_id, credit_reviewed)
						 SELECT ?, id, '2026-09-08', ?, 'LANDLORD LLC CREDIT', 1, 'jev', 9590, 1 FROM accounts LIMIT 1`,
					)
					.bind(id, cents),
			),
		]);
		await link(9590, "user").run();
		const refunds = await ids("refunds");
		expect(refunds).toEqual(expect.arrayContaining([9591, 9592]));
		expect(refunds).not.toContain(9590);
		const excluded = await ids("excluded");
		for (const id of [9590, 9591, 9592]) expect(excluded).not.toContain(id);
	});

	it("lists an excluded split by its parts under Excluded, as How Tally works counts it", async () => {
		const before = await excludedCount();
		expect(before).toBe(await breakdownTotal());
		await db.batch([
			db.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded, excluded_source, is_split)
				 SELECT 9600, id, '2026-09-10', 200000, 'SOMEWHERE', 1, 'user', 1 FROM accounts LIMIT 1`,
			),
			...[
				[9601, 150000],
				[9602, 50000],
			].map(([id, cents]) =>
				db
					.prepare(
						`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded, excluded_source, parent_id)
						 SELECT ?, id, '2026-09-10', ?, 'SOMEWHERE', 1, 'user', 9600 FROM accounts LIMIT 1`,
					)
					.bind(id, cents),
			),
		]);
		const excluded = await ids("excluded");
		expect(excluded).toEqual(expect.arrayContaining([9601, 9602]));
		expect(excluded).not.toContain(9600);
		expect(await excludedCount()).toBe(before + 2);
		expect(await excludedCount()).toBe(await breakdownTotal());
	});

	it("puts an excluded refund of last month's purchase in the same month in How Tally works and Show Excluded", async () => {
		const AUGUST = "2026-08";
		await db.batch([
			db.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id)
				 SELECT 9700, id, '2026-08-20', 5000, 'SOME SHOP', 1 FROM accounts LIMIT 1`,
			),
			db.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, credit_reviewed, credit_reviewed_by, refund_of_id)
				 SELECT 9701, id, '2026-09-03', -2000, 'SOME SHOP', 1, 'user', 9700 FROM accounts LIMIT 1`,
			),
		]);
		for (const month of [AUGUST, MONTH])
			expect(await excludedCount(month)).toBe(await breakdownTotal(month));
		// A person excludes the refund and leaves its link as it is.
		expect(
			await saveEdit(
				db,
				9701,
				{
					categoryId: null,
					alwaysForMerchant: false,
					displayName: null,
					note: null,
					excluded: true,
					income: false,
					creditReviewed: true,
				},
				"test",
			),
		).toEqual({ saved: true });
		expect(
			await db
				.prepare(
					"SELECT excluded, refund_of_id AS refundOfId FROM transactions WHERE id = 9701",
				)
				.first(),
		).toEqual({ excluded: 1, refundOfId: 9700 });
		for (const month of [AUGUST, MONTH])
			expect(await excludedCount(month)).toBe(await breakdownTotal(month));
	});
});

describe("Jev and a payment that pays a bill", () => {
	const answer = (flags: {
		transfer?: boolean;
		reimbursement?: boolean;
		income?: boolean;
	}) => ({
		categoryId: 5,
		suggestedCategoryId: 5,
		confidence: 0.95,
		flags: {
			transfer: false,
			reimbursement: false,
			income: false,
			...flags,
		},
	});
	const asked = async () =>
		(await pendingForJev(db, 500)).find((t) => t.id === 9501);
	const row = () =>
		db
			.prepare(
				"SELECT excluded, excluded_source, flag_transfer, flag_reimbursement, flag_income, income_source, category_id, category_source FROM transactions WHERE id = 9501",
			)
			.first();
	const stillLinked = async () =>
		await db
			.prepare(
				"SELECT COUNT(*) AS n FROM bill_payments WHERE bill_id = 9500 AND status = 'linked'",
			)
			.first("n");

	it("asks about it for its category only while it pays a bill, and not once the link is gone", async () => {
		await addPayment("plaid").run();
		expect(await asked()).toBeUndefined();
		await link(9501).run();
		expect(await asked()).toBeUndefined();
		await unlink().run();
		expect(await asked()).toBeUndefined();
		expect(await row()).toMatchObject({
			category_id: 5,
			category_source: "bill",
		});
	});

	it("files only the category: a transfer, reimbursement or income answer changes nothing about its exclusion or Spent", async () => {
		await addPayment("plaid").run();
		await link(9501).run();
		const before = await readings();
		expect(
			await saveJevResult(
				db,
				9501,
				answer({ transfer: true, reimbursement: true, income: true }),
				{ categoryOnly: true, switches: { income: true } },
			),
		).toBe(false);
		expect(await row()).toEqual({
			excluded: 1,
			excluded_source: "plaid",
			flag_transfer: 0,
			flag_reimbursement: 0,
			flag_income: 0,
			income_source: null,
			category_id: 5,
			category_source: "bill",
		});
		expect(await stillLinked()).toBe(1);
		// The bill's category already answers the only question Jev could help with.
		expect(await readings()).toEqual(before);
	});

	it("keeps Jev's own exclusion on a linked payment through Jev's answers", async () => {
		await addPayment("jev").run();
		await link(9501).run();
		const before = await spendFor();
		await saveJevResult(db, 9501, answer({ income: true }), {
			categoryOnly: true,
			switches: { income: true },
		});
		expect(await row()).toMatchObject({
			excluded: 1,
			excluded_source: "jev",
			flag_transfer: 1,
			flag_income: 0,
			category_source: "bill",
		});
		expect(await spendFor()).toBe(before);
		await unlink().run();
		expect(await row()).toMatchObject({ excluded: 1, excluded_source: "jev" });
	});

	it("never writes to a payment that isn't linked and is excluded", async () => {
		await addPayment("plaid").run();
		for (const categoryOnly of [true, false])
			expect(await saveJevResult(db, 9501, answer({}), { categoryOnly })).toBe(
				false,
			);
		await link(9501).run();
		await unlink().run();
		expect(
			await saveJevResult(db, 9501, answer({}), { categoryOnly: true }),
		).toBe(false);
		expect(await row()).toMatchObject({
			category_id: 5,
			category_source: "bill",
		});
	});

	it("keeps the bill paid and in Spent when Jev answers transfer and income on it (a whole run)", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await addPayment("plaid").run();
		await link(9501).run();
		// Everything else has been looked at already, so the run asks only about this payment.
		await db
			.prepare(
				"UPDATE transactions SET category_confidence = 0.5 WHERE id != 9501",
			)
			.run();
		const before = await spendFor();
		const jev = async () =>
			new Response(
				JSON.stringify({
					answers: {
						category: {
							type: "choice",
							choice: "Eating Out",
							confidence: 0.95,
						},
						transfer: { type: "noul", noul: 0.99 },
						reimbursement: { type: "noul", noul: 0.99 },
						income: { type: "noul", noul: 0.99 },
					},
				}),
				{ status: 200 },
			);
		const result = await categorizePending(
			{ DB: db, JEV_API_KEY: "test-key" },
			jev,
		);
		expect(result.asked).toBe(0);
		expect(await row()).toMatchObject({
			excluded: 1,
			excluded_source: "plaid",
			flag_transfer: 0,
			flag_income: 0,
			category_source: "bill",
		});
		expect(await stillLinked()).toBe(1);
		expect(await spendFor()).toBe(before);
	});

	it("never marks money out as income, for a transaction that counts on its own", async () => {
		await db
			.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name)
				 SELECT 9520, id, '2026-09-04', 4200, 'SOME SHOP' FROM accounts LIMIT 1`,
			)
			.run();
		expect(
			await saveJevResult(db, 9520, answer({ income: true }), {
				switches: { income: true },
			}),
		).toBe(true);
		expect(
			await db
				.prepare(
					"SELECT flag_income, income_source, category_id FROM transactions WHERE id = 9520",
				)
				.first(),
		).toEqual({ flag_income: 0, income_source: null, category_id: 5 });
		// Money in is still Jev's to call income.
		await db
			.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name)
				 SELECT 9521, id, '2026-09-04', -4200, 'SOME PAYROLL' FROM accounts LIMIT 1`,
			)
			.run();
		await saveJevResult(db, 9521, answer({ income: true }), {
			switches: { income: true },
		});
		expect(
			await db
				.prepare(
					"SELECT flag_income, income_source FROM transactions WHERE id = 9521",
				)
				.first(),
		).toEqual({ flag_income: 1, income_source: "jev" });
	});
});

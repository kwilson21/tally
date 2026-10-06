import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeMonth } from "../src/budget";
import { categorizePending } from "../src/categorize-pending";
import { loadMonth } from "../src/db/month";
import {
	excludedBreakdown,
	listTransactions,
	monthCounts,
	needsCategoryCount,
	pendingForJev,
	saveJevResult,
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
				needsCategory: before.needsCategory + 1,
				breakdownExcluded: before.breakdownExcluded - 1,
				filterExcluded: before.filterExcluded - 1,
			});
			// Linking wrote nothing to the exclusion.
			expect(await stored(9501)).toEqual([exclusion]);
			// And the list doesn't call it excluded: it says what it is, a payment that counts.
			const row = await rowOf(9501);
			expect(row).toMatchObject({ excluded: true, paysBill: true });
			expect(rowCaption(row as NonNullable<typeof row>).kind).not.toBe(
				"excluded",
			);

			await unlink().run();
			expect(await readings()).toEqual(before);
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
			// The parent and its parts are all read as paying the bill.
			filterExcluded: before.filterExcluded - 3,
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
		expect(await readings()).toEqual(parentOnly);
		expect(parentOnly.home).toBe(before.home + 200000);

		// Without the parent's link the part still counts on its own link, and its sibling no longer does.
		await unlink().run();
		expect((await readings()).home).toBe(before.home + 150000);
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
		expect(await asked()).toMatchObject({ id: 9501, categoryOnly: true });
		await unlink().run();
		expect(await asked()).toBeUndefined();
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
		).toBe(true);
		expect(await row()).toEqual({
			excluded: 1,
			excluded_source: "plaid",
			flag_transfer: 0,
			flag_reimbursement: 0,
			flag_income: 0,
			income_source: null,
			category_id: 5,
			category_source: "jev",
		});
		expect(await stillLinked()).toBe(1);
		// Categorized now, so it no longer needs one; everything else reads as before.
		expect(await readings()).toEqual({
			...before,
			needsCategory: before.needsCategory - 1,
		});
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
		expect(await row()).toMatchObject({ category_id: null });
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
		expect(result.asked).toBe(1);
		expect(await row()).toMatchObject({
			excluded: 1,
			excluded_source: "plaid",
			flag_transfer: 0,
			flag_income: 0,
			category_source: "jev",
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

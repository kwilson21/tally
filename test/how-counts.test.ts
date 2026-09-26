import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	excludedBreakdown,
	monthCounts,
	needsCategoryCount,
	saveEdit,
	saveJevResult,
} from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";

const db = env.DB;
const TODAY = "2026-09-22";
const MONTH = "2026-09";

const idOf = async (rawName: string) =>
	(
		await db
			.prepare("SELECT id FROM transactions WHERE raw_name = ? LIMIT 1")
			.bind(rawName)
			.first<{ id: number }>()
	)?.id as number;

const countWhere = async (where: string) =>
	(
		await db
			.prepare(
				`SELECT COUNT(*) AS n FROM transactions WHERE substr(date, 1, 7) = ? AND excluded = 0 AND is_split = 0 AND ${where}`,
			)
			.bind(MONTH)
			.first<{ n: number }>()
	)?.n ?? 0;

beforeEach(async () => {
	await resetDemo(db, TODAY);
});

describe("monthCounts", () => {
	it("counts the month's transactions and who categorized them, matching Home", async () => {
		const counts = await monthCounts(db, MONTH);
		expect(counts).toEqual({
			counted: await countWhere("1 = 1"),
			needsCategory: await needsCategoryCount(db, MONTH),
			user: 0,
			merchantRule: 0,
			jev: await countWhere("category_source = 'jev'"),
			unsure: 0,
			noneFit: 0,
			notYetAsked: 12,
			income: await countWhere("category_id IS NULL AND flag_income = 1"),
		});
		expect(counts.income).toBeGreaterThan(0);
		expect(counts.needsCategory).toBe(12);
		expect(counts.jev).toBeGreaterThan(0);
	});

	it("follows a person's choice, a merchant rule, and Jev being unsure", async () => {
		await saveEdit(
			db,
			await idOf("SQ *LOCAL BAKERY 4432"),
			{
				categoryId: 2,
				alwaysForMerchant: false,
				displayName: null,
				note: null,
				excluded: false,
			},
			"demo",
		);
		await db
			.prepare(
				"UPDATE transactions SET category_id = 1, category_source = 'merchant_rule' WHERE raw_name = 'SQ *FARMERS MKT'",
			)
			.run();
		const unsure = {
			categoryId: null,
			suggestedCategoryId: 1,
			confidence: 0.5,
			flags: { transfer: false, reimbursement: false, income: false },
		};
		await saveJevResult(db, await idOf("VENMO *J RIVERA"), unsure);
		// "None of these fit": a confidence but no pick.
		await saveJevResult(db, await idOf("POS 4417 CITY PARKING"), {
			...unsure,
			suggestedCategoryId: null,
			confidence: 0.9,
		});

		const counts = await monthCounts(db, MONTH);
		expect(counts).toMatchObject({
			needsCategory: 10,
			user: 1,
			merchantRule: 1,
			unsure: 1,
			noneFit: 1,
			notYetAsked: 8,
		});
	});
});

describe("excludedBreakdown", () => {
	const exclude = (rawName: string, flags: string) =>
		db
			.prepare(
				`UPDATE transactions SET excluded = 1, ${flags} WHERE raw_name = ? AND substr(date, 1, 7) = ?`,
			)
			.bind(rawName, MONTH)
			.run();

	it("splits this month's excluded transactions by why: a transfer, a reimbursement, or a person", async () => {
		const before = await excludedBreakdown(db, MONTH);
		await exclude(
			"SQ *FARMERS MKT",
			"flag_transfer = 1, flag_reimbursement = 1",
		);
		await exclude(
			"VENMO *J RIVERA",
			"flag_transfer = 0, flag_reimbursement = 1",
		);
		await exclude(
			"POS 4417 CITY PARKING",
			"flag_transfer = 0, flag_reimbursement = 0",
		);
		const n = async (rawName: string) =>
			(
				await db
					.prepare(
						"SELECT COUNT(*) AS n FROM transactions WHERE raw_name = ? AND substr(date, 1, 7) = ? AND is_split = 0",
					)
					.bind(rawName, MONTH)
					.first<{ n: number }>()
			)?.n ?? 0;
		// Both flags count once, as a transfer.
		expect(await excludedBreakdown(db, MONTH)).toEqual({
			transfer: before.transfer + (await n("SQ *FARMERS MKT")),
			reimbursement: before.reimbursement + (await n("VENMO *J RIVERA")),
			byPerson: before.byPerson + (await n("POS 4417 CITY PARKING")),
		});
	});

	it("counts a flagged transaction a person excluded as the person's choice", async () => {
		const before = await excludedBreakdown(db, MONTH);
		await db
			.prepare(
				"UPDATE transactions SET excluded = 1, excluded_source = 'user', flag_transfer = 1 WHERE raw_name = 'POS 4417 CITY PARKING' AND substr(date, 1, 7) = ?",
			)
			.bind(MONTH)
			.run();
		const after = await excludedBreakdown(db, MONTH);
		expect(after.transfer).toBe(before.transfer);
		expect(after.byPerson).toBeGreaterThan(before.byPerson);
	});
});

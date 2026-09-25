import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
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
		});
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

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0021_plaid_income_backfill.sql?raw";
import { summarizeMonth } from "../src/budget";
import { loadMonth } from "../src/db/month";
import { resetDemo } from "../src/demo/reset";

const db = env.DB;
const MONTH = "2026-09";

const backfill = migration
	.split(";")
	.map((statement) => statement.trim())
	.find((statement) => statement.includes("UPDATE transactions"));

type Row = {
	id: number;
	category: string | null;
	flag: number;
	source: string | null;
	reviewed?: number | null;
	reviewedBy?: string | null;
	confidence?: number | null;
	isSplit?: number;
	parentId?: number | null;
	/** Plaid's sign: negative is money in. Defaults to a $3,000 paycheck. */
	amountCents?: number;
};

// Each row is a transaction already stored before sync marked income, with the flag it should end with.
const rows: (Row & { name: string; marked: number })[] = [
	{
		id: 9001,
		name: "plain paycheck",
		category: "INCOME",
		flag: 0,
		source: null,
		reviewed: 0,
		marked: 1,
	},
	{
		id: 9002,
		name: "person said not income",
		category: "INCOME",
		flag: 0,
		source: "user",
		reviewed: 1,
		reviewedBy: "user",
		marked: 0,
	},
	{
		id: 9003,
		name: "person reviewed the credit",
		category: "INCOME",
		flag: 0,
		source: null,
		reviewed: 1,
		reviewedBy: "user",
		marked: 0,
	},
	{
		id: 9004,
		name: "person said income already",
		category: "INCOME",
		flag: 1,
		source: "user",
		marked: 1,
	},
	{
		id: 9005,
		name: "Jev decided",
		category: "INCOME",
		flag: 0,
		source: "jev",
		reviewed: 1,
		confidence: 0.95,
		marked: 0,
	},
	{
		id: 9006,
		name: "Jev said income already",
		category: "INCOME",
		flag: 1,
		source: "jev",
		reviewed: 1,
		confidence: 0.95,
		marked: 1,
	},
	{
		id: 9007,
		name: "Jev below the threshold",
		category: "INCOME",
		flag: 0,
		source: null,
		reviewed: 0,
		confidence: 0.4,
		marked: 1,
	},
	{
		id: 9008,
		name: "not Plaid income",
		category: "GENERAL_MERCHANDISE",
		flag: 0,
		source: null,
		reviewed: 0,
		marked: 0,
	},
	{
		id: 9009,
		name: "no Plaid category",
		category: null,
		flag: 0,
		source: null,
		reviewed: 0,
		marked: 0,
	},
	{
		id: 9010,
		name: "already set by Plaid",
		category: "INCOME",
		flag: 1,
		source: null,
		reviewed: 0,
		marked: 1,
	},
	{
		id: 9011,
		name: "split paycheck, as sync does",
		category: "INCOME",
		flag: 0,
		source: null,
		reviewed: 0,
		isSplit: 1,
		marked: 1,
	},
	{
		id: 9012,
		name: "split part",
		category: null,
		flag: 0,
		source: null,
		reviewed: 0,
		parentId: 9011,
		marked: 0,
	},
	{
		// Plaid's sign: positive is money out, which is never income.
		id: 9013,
		name: "outgoing payment labeled INCOME",
		category: "INCOME",
		flag: 0,
		source: null,
		reviewed: 1,
		amountCents: 50000,
		marked: 0,
	},
];

async function insert(row: Row & { name: string }) {
	await db
		.prepare(
			`INSERT INTO transactions
				(id, account_id, date, amount_cents, raw_name, plaid_category, flag_income, income_source,
				 credit_reviewed, credit_reviewed_by, category_confidence, is_split, parent_id)
			 SELECT ?, id, '2026-09-15', ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM accounts LIMIT 1`,
		)
		.bind(
			row.id,
			row.amountCents ?? -300000,
			row.name,
			row.category,
			row.flag,
			row.source,
			row.reviewed ?? null,
			row.reviewedBy ?? null,
			row.confidence ?? null,
			row.isSplit ?? 0,
			row.parentId ?? null,
		)
		.run();
}

const state = async () =>
	(
		await db
			.prepare(
				"SELECT id, flag_income, income_source FROM transactions WHERE id >= 9001 ORDER BY id",
			)
			.all<{ id: number; flag_income: number; income_source: string | null }>()
	).results;

const income = async () =>
	summarizeMonth({
		month: MONTH,
		...(await loadMonth(db, MONTH)),
		unpaidDueBillsCents: 0,
	}).incomeCents;

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	for (const row of rows) await insert(row);
});

describe("migration 0021: mark stored INCOME transactions as income", () => {
	it("marks only what nobody has decided, and leaves who set the flag empty", async () => {
		expect(backfill).toBeDefined();
		await db.prepare(backfill as string).run();

		expect(await state()).toEqual(
			rows.map((row) => ({
				id: row.id,
				flag_income: row.marked,
				// Only the migration's own marks are new, and they stay empty; every other source is as it was.
				income_source: row.source,
			})),
		);
	});

	it("brings a stored paycheck into Income, and running it again changes nothing", async () => {
		const before = await income();
		await db.prepare(backfill as string).run();
		// The plain paycheck and the one Jev was unsure about now count, $3,000 each; the split parent never does.
		expect((await income()) - before).toBe(2 * 300000);

		const once = await state();
		await db.prepare(backfill as string).run();
		expect(await state()).toEqual(once);
	});
});

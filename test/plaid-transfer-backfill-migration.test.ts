import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0020_plaid_transfer_backfill.sql?raw";
import { resetDemo } from "../src/demo/reset";

const db = env.DB;

/** The migration's statements, without comments (the tests' database has already run it on nothing). */
const statements = migration
	.split("\n")
	.filter((line) => !line.trim().startsWith("--"))
	.join("\n")
	.split(";")
	.map((statement) => statement.trim())
	.filter((statement) => statement !== "");

const run = async () => {
	for (const statement of statements) await db.prepare(statement).run();
};

/** One stored transaction: its id, Plaid's category, and who decided its exclusion so far. */
const add = (
	id: number,
	category: string | null,
	options: {
		excluded?: number;
		source?: string | null;
		split?: boolean;
		parent?: number;
		incomeSource?: string;
		reviewedBy?: string;
	} = {},
) =>
	db
		.prepare(
			`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, plaid_category, excluded, excluded_source, is_split, parent_id, income_source, credit_reviewed_by, flag_income)
			 SELECT ?, id, '2026-09-10', ?, 'SYNTHETIC', ?, ?, ?, ?, ?, ?, ?, ? FROM accounts LIMIT 1`,
		)
		.bind(
			id,
			// A person decides about credits (money in), and chosen income carries the income flag.
			options.incomeSource === "user" || options.reviewedBy === "user"
				? -5000
				: 5000,
			category,
			options.excluded ?? 0,
			options.source ?? null,
			options.split ? 1 : 0,
			options.parent ?? null,
			options.incomeSource ?? null,
			options.reviewedBy ?? null,
			options.incomeSource === "user" ? 1 : 0,
		);

/** Links a bill's payment to a transaction. */
const pay = (billId: number, period: string, transactionId: number) =>
	db
		.prepare(
			"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, ?, ?, 'user', 'linked')",
		)
		.bind(billId, period, transactionId);

const stateOf = async () =>
	Object.fromEntries(
		(
			await db
				.prepare(
					"SELECT id, excluded, excluded_source FROM transactions WHERE id >= 9000 ORDER BY id",
				)
				.all<{ id: number; excluded: number; excluded_source: string | null }>()
		).results.map((row) => [
			row.id,
			[row.excluded, row.excluded_source] as const,
		]),
	);

const COUNTED = [0, null] as const;
const PLAID = [1, "plaid"] as const;

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
});

describe("migration 0020: exclude the transfers already stored (decision 67)", () => {
	it("excludes only what nobody decided about, with Plaid as the source", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (9100, 'Mortgage', 150000, 1, 'monthly', 'LANDLORD LLC')",
			),
			// Nobody decided: all three kinds are excluded.
			add(9001, "TRANSFER_IN"),
			add(9002, "TRANSFER_OUT"),
			add(9003, "LOAN_PAYMENTS"),
			// A person's include, a person's exclude and Jev's exclusion stay.
			add(9011, "TRANSFER_OUT", { source: "user" }),
			add(9012, "TRANSFER_OUT", { excluded: 1, source: "user" }),
			add(9013, "TRANSFER_OUT", { excluded: 1, source: "jev" }),
			// Excluded before anyone recorded a source: not Plaid's to change either.
			add(9014, "TRANSFER_OUT", { excluded: 1 }),
			// Anything else stays counted.
			add(9021, "FOOD_AND_DRINK"),
			add(9022, "INCOME"),
			add(9023, null),
			// A payment linked to a bill stays counted.
			add(9031, "LOAN_PAYMENTS"),
			// Income a person chose, or a credit a person reviewed, stays counted.
			add(9032, "TRANSFER_IN", { incomeSource: "user" }),
			add(9033, "TRANSFER_IN", { reviewedBy: "user" }),
			// A reviewed credit the bank later turned into money out is no longer a credit, so the rule applies.
			db.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, plaid_category, credit_reviewed_by) SELECT 9034, id, '2026-09-10', 5000, 'SYNTHETIC', 'TRANSFER_OUT', 'user' FROM accounts LIMIT 1",
			),
			// A split's parent and parts follow it, except a part a person set, a part with income a person chose, and a part that pays a bill.
			add(9041, "TRANSFER_OUT", { split: true }),
			add(9042, null, { parent: 9041 }),
			add(9043, null, { parent: 9041 }),
			add(9044, null, { parent: 9041, source: "user" }),
			add(9045, null, { parent: 9041 }),
			add(9046, null, { parent: 9041, incomeSource: "user" }),
			// A split a person included keeps its parts as they are.
			add(9051, "TRANSFER_OUT", { split: true, source: "user" }),
			add(9052, null, { parent: 9051 }),
			// A split that pays a bill isn't excluded, so its parts aren't either.
			add(9061, "TRANSFER_OUT", { split: true }),
			add(9062, null, { parent: 9061 }),
			// A split that isn't a transfer keeps counting.
			add(9071, "FOOD_AND_DRINK", { split: true }),
			add(9072, null, { parent: 9071 }),
			pay(9100, "2026-01", 9031),
			pay(9100, "2026-02", 9045),
			pay(9100, "2026-03", 9061),
		]);

		await run();

		expect(await stateOf()).toEqual({
			9001: PLAID,
			9002: PLAID,
			9003: PLAID,
			9011: [0, "user"],
			9012: [1, "user"],
			9013: [1, "jev"],
			9014: [1, null],
			9021: COUNTED,
			9022: COUNTED,
			9023: COUNTED,
			9031: COUNTED,
			9032: COUNTED,
			9033: COUNTED,
			9034: PLAID,
			9041: PLAID,
			9042: PLAID,
			9043: PLAID,
			9044: [0, "user"],
			9045: COUNTED,
			9046: COUNTED,
			9051: [0, "user"],
			9052: COUNTED,
			9061: COUNTED,
			9062: COUNTED,
			9071: COUNTED,
			9072: COUNTED,
		});
	});

	it("changes nothing the second time", async () => {
		await db.batch([
			add(9001, "TRANSFER_OUT"),
			add(9002, "TRANSFER_IN", { split: true }),
			add(9003, null, { parent: 9002 }),
		]);
		await run();
		const once = await stateOf();
		expect(once).toEqual({ 9001: PLAID, 9002: PLAID, 9003: PLAID });
		await run();
		expect(await stateOf()).toEqual(once);
	});
});

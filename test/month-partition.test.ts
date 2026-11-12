import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { excludedBreakdown, monthCounts } from "../src/db/transactions";
import {
	type Classified,
	type Context,
	classify,
	type Row,
} from "../src/transactions/classify";

// How Tally works shows one month as three buckets: counted, held for review, and excluded (by reason). Every
// transaction of the month that is not a split parent must land in exactly one bucket. Two readings must agree:
// classify() row by row, and the SQL totals (monthCounts, excludedBreakdown) that the diagrams show.

const db = env.DB;
const MONTH = "2026-09";

type Bucket = "counted" | "held" | "excluded";

/** One row per state. `refundOf` and `parent` name another row in this list, which must come first. */
type Seed = {
	name: string;
	expect: Bucket | "split_parent";
	amount: number;
	excluded?: 0 | 1;
	excludedSource?: "user" | "plaid" | null;
	flagIncome?: 0 | 1;
	flagTransfer?: 0 | 1;
	flagReimbursement?: 0 | 1;
	isSplit?: 0 | 1;
	pending?: 0 | 1;
	creditReviewed?: 0 | 1;
	refundOf?: string;
	parent?: string;
	/** A bill payment is linked to this row. */
	billLinked?: boolean;
};

const SEEDS: Seed[] = [
	{ name: "purchase counted", expect: "counted", amount: 1000 },
	{
		name: "purchase excluded by user",
		expect: "excluded",
		amount: 1000,
		excluded: 1,
		excludedSource: "user",
	},
	{
		name: "purchase excluded by Plaid (transfer)",
		expect: "excluded",
		amount: 1000,
		excluded: 1,
		excludedSource: "plaid",
		flagTransfer: 1,
	},
	{ name: "credit held", expect: "held", amount: -500 },
	{
		name: "credit income, not reviewed",
		expect: "counted",
		amount: -500,
		flagIncome: 1,
	},
	{
		name: "credit reviewed",
		expect: "counted",
		amount: -500,
		creditReviewed: 1,
	},
	// A transfer credit the person included on purpose stays held until they review it (#870 and the design issue
	// on a person-included transfer credit). It is in the budget, so it is held, not excluded.
	{
		name: "credit transfer, in the budget, not reviewed",
		expect: "held",
		amount: -500,
		flagTransfer: 1,
	},
	{
		name: "credit transfer, excluded by user",
		expect: "excluded",
		amount: -500,
		flagTransfer: 1,
		excluded: 1,
		excludedSource: "user",
	},
	{
		name: "credit reimbursement, excluded",
		expect: "excluded",
		amount: -500,
		excluded: 1,
		flagReimbursement: 1,
	},
	{ name: "split parent", expect: "split_parent", amount: 2000, isSplit: 1 },
	{
		name: "split part",
		expect: "counted",
		amount: 1000,
		parent: "split parent",
	},
	{ name: "pending purchase", expect: "counted", amount: 800, pending: 1 },
	{ name: "pending credit held", expect: "held", amount: -300, pending: 1 },
	{
		name: "refund that follows a counted purchase",
		expect: "counted",
		amount: -400,
		creditReviewed: 1,
		refundOf: "purchase counted",
	},
	{
		name: "credit held, excluded by user",
		expect: "excluded",
		amount: -600,
		excluded: 1,
		excludedSource: "user",
	},
	// A transfer that a bill explains is a payment, never Excluded, so it stays held until someone reviews it.
	{
		name: "credit transfer, bill-linked, not reviewed",
		expect: "held",
		amount: -700,
		flagTransfer: 1,
		billLinked: true,
	},
];

const rowIds = new Map<string, number>();

beforeAll(async () => {
	await db
		.prepare(
			"INSERT INTO accounts (name, type, subtype, is_liability, balance_cents) VALUES ('Partition','depository','checking',0,0)",
		)
		.run();

	const account = await db
		.prepare("SELECT id FROM accounts WHERE name = 'Partition'")
		.first<{ id: number }>();

	if (!account) throw new Error("the test account was not inserted");

	for (const seed of SEEDS) {
		const row = await db
			.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, excluded, excluded_source,
					flag_income, flag_transfer, flag_reimbursement, is_split, parent_id, pending, credit_reviewed, refund_of_id)
				VALUES (?, '${MONTH}-10', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				RETURNING id`,
			)
			.bind(
				account.id,
				seed.amount,
				seed.name,
				seed.excluded ?? 0,
				seed.excludedSource ?? null,
				seed.flagIncome ?? 0,
				seed.flagTransfer ?? 0,
				seed.flagReimbursement ?? 0,
				seed.isSplit ?? 0,
				seed.parent ? (rowIds.get(seed.parent) ?? null) : null,
				seed.pending ?? 0,
				seed.creditReviewed ?? null,
				seed.refundOf ? (rowIds.get(seed.refundOf) ?? null) : null,
			)
			.first<{ id: number }>();

		if (!row) throw new Error(`could not seed ${seed.name}`);
		rowIds.set(seed.name, row.id);

		if (seed.billLinked) {
			await db
				.prepare(
					"INSERT INTO bills (name, amount_cents, due_day, frequency, merchant_raw_name) VALUES ('Partition bill', 100, 1, 'monthly', 'PARTITION')",
				)
				.run();
			await db
				.prepare(
					"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES ((SELECT MAX(id) FROM bills), '2026-09', ?, 'user', 'linked')",
				)
				.bind(row.id)
				.run();
		}
	}
});

async function monthRows(): Promise<Row[]> {
	const { results } = await db
		.prepare(
			"SELECT * FROM transactions WHERE substr(date, 1, 7) = ? ORDER BY id",
		)
		.bind(MONTH)
		.all<Row>();

	return results;
}

/** The facts outside each row, for this month's seeds: the one refund's purchase, and the active categories. */
async function contextFor(r: Row, byId: Map<number, Row>): Promise<Context> {
	const linkedIds = new Set(
		(
			await db
				.prepare(
					"SELECT transaction_id AS id FROM bill_payments WHERE status = 'linked'",
				)
				.all<{ id: number }>()
		).results.map((x) => x.id),
	);

	const target = r.refund_of_id === null ? undefined : byId.get(r.refund_of_id);

	return {
		paysBillOrPlan: linkedIds.has(r.id),
		refundTarget: target
			? { excluded: target.excluded === 1, categoryId: target.category_id }
			: null,
		jevCategoryActive: false,
		anyActiveCategory: true,
		neverSuggestIncome: false,
	};
}

/** The bucket classify() puts a row in, for How Tally works. Split parents are not in the diagram at all. */
function bucketOf(r: Row, c: Classified): Bucket | "split_parent" {
	if (r.is_split === 1) return "split_parent";

	if (c.questions.heldForReview) return "held";

	if (!c.questions.included) return "excluded";

	return "counted";
}

describe("every transaction of a month lands in exactly one How Tally bucket", () => {
	it("classify puts each seeded state in the bucket the seed expects", async () => {
		const rows = await monthRows();
		const byId = new Map(rows.map((r) => [r.id, r]));
		const names = new Map([...rowIds].map(([name, id]) => [id, name]));

		for (const r of rows) {
			const c = classify(r, await contextFor(r, byId));
			const seed = SEEDS.find((s) => s.name === names.get(r.id));
			expect(seed, `row ${r.id}`).toBeDefined();
			expect(bucketOf(r, c), names.get(r.id)).toBe(seed?.expect);
		}
	});

	it("the SQL totals the diagrams show add up to the month's rows, with the same count per bucket", async () => {
		const rows = await monthRows();

		const expectedCount = (bucket: Bucket | "split_parent") =>
			SEEDS.filter((s) => s.expect === bucket).length;

		const counts = await monthCounts(db, MONTH);
		const breakdown = await excludedBreakdown(db, MONTH);

		const excludedTotal =
			breakdown.transfer + breakdown.reimbursement + breakdown.byPerson;

		expect(counts.counted).toBe(expectedCount("counted"));
		expect(counts.heldForReview).toBe(expectedCount("held"));
		expect(excludedTotal).toBe(expectedCount("excluded"));
		// Every non-split-parent row is in exactly one of the three.
		expect(counts.counted + counts.heldForReview + excludedTotal).toBe(
			rows.filter((r) => r.is_split === 0).length,
		);
	});

	it("the transfer line holds only the plaid-excluded transfer, so an included transfer credit is not in it", async () => {
		const breakdown = await excludedBreakdown(db, MONTH);
		// Only the plaid-excluded transfer purchase is in the transfer line: included transfer credits are held.
		expect(breakdown.transfer).toBe(1);
		expect(breakdown.reimbursement).toBe(1);
		expect(breakdown.byPerson).toBe(3);
	});
});

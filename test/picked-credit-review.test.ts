import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { confidenceBasisPoints } from "../src/ai/confidence";
import { summarizeMonth } from "../src/budget";
import { loadMonth } from "../src/db/month";
import { monthCounts, saveEdit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { present } from "./helpers/present";

// #870: a person's category pick on a bank credit that Jev called not income (income_confidence at or below
// 20%) counts as the person's review as not income (decision 234), by the trigger picked_credit_review.

const db = env.DB;
const TODAY = "2026-09-22";
const GROCERIES = 1;
const EATING_OUT = 2;

const idOf = async (rawName: string) =>
	present(
		(
			await db
				.prepare(
					"SELECT id FROM transactions WHERE raw_name = ? ORDER BY date DESC LIMIT 1",
				)
				.bind(rawName)
				.first<{ id: number }>()
		)?.id,
	);

type State = {
	amount_cents: number;
	flag_income: number;
	income_source: string | null;
	income_confidence: number | null;
	credit_reviewed: number | null;
	credit_reviewed_by: string | null;
	category_id: number | null;
	category_source: string | null;
	category_confidence: number | null;
	excluded: number;
	is_split: number;
	parent_id: number | null;
};

const stateOf = async (id: number) =>
	present(
		await db
			.prepare(
				"SELECT amount_cents, flag_income, income_source, income_confidence, credit_reviewed, credit_reviewed_by, category_id, category_source, category_confidence, excluded, is_split, parent_id FROM transactions WHERE id = ?",
			)
			.bind(id)
			.first<State>(),
	);

const monthOf = async (id: number) =>
	present(
		(
			await db
				.prepare(
					"SELECT substr(date, 1, 7) AS month FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first<{ month: string }>()
		)?.month,
	);

/**
 * A row as a stuck credit: a bank credit nobody reviewed, that Jev called not income at `incomeConfidence` and
 * gave a Maybe category to (so it is held, and no question about its income is asked).
 */
async function stuckCredit(incomeConfidence: number | null = 0.1) {
	const id = await idOf("SQ *LOCAL BAKERY 4432");
	await db
		.prepare(
			`UPDATE transactions SET amount_cents = -5000, flag_income = 0, income_source = NULL,
				credit_reviewed = 0, credit_reviewed_by = NULL, income_confidence = ?,
				category_id = NULL, category_source = NULL, category_confidence = 0.5, jev_category_id = ?,
				excluded = 0, excluded_source = NULL, is_split = 0, parent_id = NULL, refund_of_id = NULL
				WHERE id = ?`,
		)
		.bind(incomeConfidence, GROCERIES, id)
		.run();

	return id;
}

/**
 * A real split of a stuck credit: the parent is a split parent (is_split = 1) and two part rows (their own ids, parent_id
 * set to the parent) hold its amount between them. Each part is a bank credit row with the same income answer as the parent.
 */
async function splitCredit() {
	const parent = await stuckCredit(0.1);
	await db
		.prepare("UPDATE transactions SET is_split = 1 WHERE id = ?")
		.bind(parent)
		.run();

	const parts: number[] = [];

	for (const amount of [-2000, -3000]) {
		const row = await db
			.prepare(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, parent_id, is_split,
					flag_income, income_confidence, credit_reviewed, credit_reviewed_by, excluded)
				SELECT NULL, account_id, date, ?, raw_name, id, 0, 0, 0.1, 0, NULL, 0 FROM transactions WHERE id = ?
				RETURNING id`,
			)
			.bind(amount, parent)
			.first<{ id: number }>();

		parts.push(present(row?.id));
	}

	return { parent, parts };
}

type Edit = Parameters<typeof saveEdit>[2];

const edit = (over: Partial<Edit> = {}): Edit => ({
	categoryId: null,
	alwaysForMerchant: false,
	displayName: null,
	note: null,
	excluded: false,
	income: false,
	creditReviewed: false,
	...over,
});

/** A person picks GROCERIES in the edit panel, with the review box left as it was. */
const pick = (id: number, categoryId = GROCERIES, over: Partial<Edit> = {}) =>
	saveEdit(db, id, edit({ categoryId, ...over }), "test");

/** What a month shows for one row's category, Safe to spend and the held count, read the way Home reads them. */
async function totals(id: number, categoryId = GROCERIES) {
	const month = await monthOf(id);

	const summary = summarizeMonth({
		month,
		...(await loadMonth(db, month)),
		unpaidDueBillsCents: 0,
	});

	const counts = await monthCounts(db, month);
	const category = summary.categories.find((c) => c.id === categoryId);

	return {
		safe: summary.safeToSpendCents,
		spent: category?.spentCents ?? 0,
		held: counts.heldForReview,
	};
}

beforeEach(async () => {
	await resetDemo(db, TODAY);
});

describe("a person's pick settles a credit Jev called not income (#870)", () => {
	it("settles a stuck credit when the person picks its category in the edit panel", async () => {
		const id = await stuckCredit(0.1);
		await pick(id);

		expect(await stateOf(id)).toMatchObject({
			category_id: GROCERIES,
			category_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: "user",
			income_source: "user",
			flag_income: 0,
		});
	});

	it("settles a stuck credit when it is picked through the Set category sheet (a second pick writer)", async () => {
		const id = await stuckCredit(0.1);

		const body = new URLSearchParams({
			category: String(GROCERIES),
			back: "/transactions?month=all",
		});

		body.append("ids", String(id));

		const res = await exports.default.fetch(
			"http://tally.test/transactions/select/category/save",
			{
				method: "POST",
				body,
				headers: { Origin: "http://tally.test", "HX-Request": "true" },
			},
		);

		expect(res.status).toBeLessThan(400);
		expect(await stateOf(id)).toMatchObject({
			category_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: "user",
			income_source: "user",
		});
	});

	it("a merchant rule or a Jev category does not settle a credit", async () => {
		// A merchant rule and a Jev category are not a person's pick: neither settles the credit.
		const ruled = await stuckCredit(0.1);
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'merchant_rule' WHERE id = ?",
			)
			.bind(GROCERIES, ruled)
			.run();
		expect(await stateOf(ruled)).toMatchObject({
			credit_reviewed: 0,
			credit_reviewed_by: null,
		});

		const jev = await stuckCredit(0.1);
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'jev', category_confidence = 0.9 WHERE id = ?",
			)
			.bind(GROCERIES, jev)
			.run();
		expect(await stateOf(jev)).toMatchObject({
			credit_reviewed: 0,
			credit_reviewed_by: null,
		});
	});

	describe("the income boundary (20%, the same rule as src/ai/maybe.ts)", () => {
		it.each([
			[0.2, true],
			[0.2001, false],
			[0.20005, true],
			[0.25, false],
			[0.1, true],
		])(
			"income_confidence %s settles the credit: %s",
			async (confidence, settles) => {
				// The TypeScript rule: floor to basis points, then at or below 2000 (20%).
				expect(confidenceBasisPoints(confidence) <= 2000).toBe(settles);

				const id = await stuckCredit(confidence);
				await pick(id);

				await expect((await stateOf(id)).credit_reviewed === 1).toBe(settles);
			},
		);

		it("does not settle a credit whose income answer is missing", async () => {
			const id = await stuckCredit(null);
			await pick(id);

			expect(await stateOf(id)).toMatchObject({
				credit_reviewed: 0,
				credit_reviewed_by: null,
			});
		});
	});

	describe("what the trigger leaves alone", () => {
		it("does not settle a debit (money out)", async () => {
			const id = await stuckCredit(0.1);
			await db
				.prepare("UPDATE transactions SET amount_cents = 5000 WHERE id = ?")
				.bind(id)
				.run();
			await pick(id);

			expect(await stateOf(id)).toMatchObject({
				credit_reviewed: 0,
				credit_reviewed_by: null,
				income_source: null,
			});
		});

		it("does not settle a credit Jev or a person counts as income", async () => {
			const id = await stuckCredit(0.1);
			await db
				.prepare(
					"UPDATE transactions SET flag_income = 1, income_source = 'jev' WHERE id = ?",
				)
				.bind(id)
				.run();
			await pick(id, GROCERIES, { income: true });

			expect(await stateOf(id)).toMatchObject({
				credit_reviewed: 0,
				credit_reviewed_by: null,
				flag_income: 1,
			});
		});

		it("does not settle an excluded credit that pays no bill, so un-excluding it later does not count as reviewed", async () => {
			const id = await stuckCredit(0.1);
			await db
				.prepare(
					"UPDATE transactions SET excluded = 1, excluded_source = 'user' WHERE id = ?",
				)
				.bind(id)
				.run();
			await pick(id, GROCERIES, { excluded: true });

			expect(await stateOf(id)).toMatchObject({
				credit_reviewed: 0,
				credit_reviewed_by: null,
				excluded: 1,
			});
		});

		it("does not settle a credit that is already reviewed", async () => {
			const id = await stuckCredit(0.1);
			await db
				.prepare(
					"UPDATE transactions SET credit_reviewed = 1, credit_reviewed_by = 'user', income_source = 'user' WHERE id = ?",
				)
				.bind(id)
				.run();
			await pick(id, GROCERIES, { creditReviewed: true });

			expect(await stateOf(id)).toMatchObject({
				credit_reviewed: 1,
				credit_reviewed_by: "user",
				category_id: GROCERIES,
			});
		});

		it("does not settle a re-pick: a row whose category the person already picked", async () => {
			const id = await stuckCredit(null);
			// The category is the person's already, set before the income answer was stored, so the trigger never saw a new pick.
			await db
				.prepare(
					"UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL WHERE id = ?",
				)
				.bind(EATING_OUT, id)
				.run();
			await db
				.prepare("UPDATE transactions SET income_confidence = 0.1 WHERE id = ?")
				.bind(id)
				.run();
			expect(await stateOf(id)).toMatchObject({ credit_reviewed: 0 });
			await pick(id, GROCERIES);

			expect(await stateOf(id)).toMatchObject({
				category_id: GROCERIES,
				credit_reviewed: 0,
				credit_reviewed_by: null,
			});
		});

		it("does not re-review a credit the person un-reviewed in the same save as a pick", async () => {
			const id = await stuckCredit(0.1);
			await db
				.prepare(
					"UPDATE transactions SET credit_reviewed = 1, credit_reviewed_by = 'user', income_source = 'user' WHERE id = ?",
				)
				.bind(id)
				.run();
			await saveEdit(
				db,
				id,
				edit({ categoryId: EATING_OUT, creditReviewed: false }),
				"test",
			);

			expect(await stateOf(id)).toMatchObject({
				category_id: EATING_OUT,
				category_source: "user",
				credit_reviewed: 0,
				credit_reviewed_by: null,
			});
		});

		it("does not settle a split parent, whose category is not a pick on a counted row (the is_split guard)", async () => {
			const { parent, parts } = await splitCredit();
			await pick(parent);

			// The pick is real: the parent's category source is now the person's, so only the is_split guard stops the trigger.
			expect(await stateOf(parent)).toMatchObject({
				category_source: "user",
				is_split: 1,
				credit_reviewed: 0,
				credit_reviewed_by: null,
				income_source: null,
			});
			expect(await stateOf(present(parts[0]))).toMatchObject({
				credit_reviewed: 0,
			});
		});

		it("does not settle a split part, whose category pick is on its own row (the parent_id guard)", async () => {
			const { parent, parts } = await splitCredit();
			const part = present(parts[0]);
			await pick(part);

			// The part's own row is the one picked, and it is not the parent, so only the parent_id guard stops the trigger.
			expect(await stateOf(part)).toMatchObject({
				parent_id: parent,
				is_split: 0,
				category_id: GROCERIES,
				category_source: "user",
				credit_reviewed: 0,
				credit_reviewed_by: null,
				income_source: null,
			});
			expect(await stateOf(parent)).toMatchObject({ credit_reviewed: 0 });
		});

		it("settles an excluded credit that pays a bill, the same way the held count reads it (INCLUDED)", async () => {
			const id = await stuckCredit(0.1);
			await db
				.prepare(
					"UPDATE transactions SET excluded = 1, excluded_source = 'user' WHERE id = ?",
				)
				.bind(id)
				.run();
			await db
				.prepare(
					"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) SELECT (SELECT id FROM bills ORDER BY id LIMIT 1), substr(date, 1, 7), id, 'user', 'linked' FROM transactions WHERE id = ?",
				)
				.bind(id)
				.run();
			await pick(id, GROCERIES, { excluded: true });

			expect(await stateOf(id)).toMatchObject({
				credit_reviewed: 1,
				credit_reviewed_by: "user",
			});
		});
	});

	describe("the debit guard on the review columns (a hand-made post only)", () => {
		it("a review posted for a debit leaves credit_reviewed_by unchanged", async () => {
			const id = await stuckCredit(0.1);
			await db
				.prepare(
					"UPDATE transactions SET amount_cents = 5000, credit_reviewed = 0, credit_reviewed_by = NULL WHERE id = ?",
				)
				.bind(id)
				.run();
			await saveEdit(db, id, edit({ creditReviewed: true }), "test");

			expect(await stateOf(id)).toMatchObject({
				credit_reviewed: 0,
				credit_reviewed_by: null,
			});
		});
	});

	describe("what a settled credit does to the month", () => {
		it("moves a stuck credit out of held and into its category's spending, once", async () => {
			const id = await stuckCredit(0.1);
			const before = await totals(id);
			await pick(id);
			const after = await totals(id);

			expect(before.held - after.held).toBe(1);
			expect(before.spent - after.spent).toBe(5000);
			expect(after.safe - before.safe).toBe(5000);
		});
	});
});

import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { saveEdit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { type Edit, excludedAfterSave } from "../src/transactions/edit";
import { present } from "./helpers/present";

// excludedAfterSave (src/transactions/edit.ts) says whether a row is excluded once an edit is saved; the edit panel and
// the save's "can Jev be asked" check read it, and saveEdit writes the exclusion itself in SQL. This runs saveEdit for
// every stored exclusion and every answer the panel can post, and checks the row it leaves is the one excludedAfterSave
// said (audit finding: the two only had a comment saying to keep them in step).

const db = env.DB;
const TODAY = "2026-10-11";

type Stored = {
	label: string;
	excluded: 0 | 1;
	source: "plaid" | "user" | "jev" | null;
};

const EXCLUSIONS: Stored[] = [
	{ label: "included", excluded: 0, source: null },
	{ label: "excluded by Plaid", excluded: 1, source: "plaid" },
	{ label: "excluded by a person", excluded: 1, source: "user" },
	{ label: "excluded by Jev", excluded: 1, source: "jev" },
];

let purchaseId = 0;
let counter = 0;

beforeAll(async () => {
	await resetDemo(db, TODAY);
	purchaseId = present(
		(
			await db
				.prepare(
					`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, pending, updated_by)
					 VALUES (1, ?, 650, 'THE PURCHASE', 'purchase-1', 0, 'test') RETURNING id`,
				)
				.bind(TODAY)
				.first<{ id: number }>()
		)?.id,
	);
});

/** Seeds one row as stored, saves the edit through saveEdit, and returns what excludedAfterSave said and what is stored. */
async function saveAndRead(
	stored: Stored,
	row: { cents: number; income: boolean; reviewedByUser: boolean },
	edit: Edit,
) {
	counter += 1;

	const id = present(
		(
			await db
				.prepare(
					`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, pending, excluded, excluded_source, flag_income, income_source, credit_reviewed, credit_reviewed_by, updated_by)
					 VALUES (1, ?, ?, 'THE CREDIT', ?, 0, ?, ?, ?, ?, ?, ?, 'test') RETURNING id`,
				)
				.bind(
					TODAY,
					row.cents,
					`credit-${counter}`,
					stored.excluded,
					stored.source,
					row.income ? 1 : 0,
					row.income ? "user" : null,
					row.reviewedByUser ? 1 : 0,
					row.reviewedByUser ? "user" : null,
				)
				.first<{ id: number }>()
		)?.id,
	);

	const predicted = excludedAfterSave(
		{
			amountCents: row.cents,
			excluded: stored.excluded === 1,
			excludedSource: stored.source,
			refundOfId: null,
			income: row.income,
			creditReviewedByUser: row.reviewedByUser,
		},
		edit,
	);

	// A refused save (a link the row can't take) writes nothing, and excludedAfterSave describes what a save that
	// lands leaves, so only a save that happened is compared.
	const result = await saveEdit(db, id, edit, "test");

	const after = present(
		await db
			.prepare("SELECT excluded FROM transactions WHERE id = ?")
			.bind(id)
			.first<{ excluded: number }>(),
	);

	return { predicted, stored: after.excluded === 1, saved: result.saved };
}

describe("excludedAfterSave agrees with the exclusion saveEdit leaves", () => {
	it("for every stored exclusion, every credit or purchase, and every answer the panel can post", async () => {
		const wrong: string[] = [];
		let compared = 0;
		let linksCompared = 0;

		for (const stored of EXCLUSIONS)
			for (const cents of [-650, 650])
				for (const income of [false, true])
					for (const reviewedByUser of [false, true])
						for (const chip of [false, true])
							for (const editIncome of [false, true])
								for (const reviewed of [false, true])
									for (const link of [false, true]) {
										if (link && cents > 0) continue;

										const edit: Edit = {
											categoryId: null,
											alwaysForMerchant: false,
											displayName: null,
											note: null,
											excluded: chip,
											income: editIncome,
											incomeWas: income,
											creditReviewed: reviewed,
											creditReviewedWas: reviewedByUser,
											creditReviewedProvided: true,
											refundOfId: link ? purchaseId : null,
										};

										const outcome = await saveAndRead(
											stored,
											{ cents, income, reviewedByUser },
											edit,
										);

										if (!outcome.saved) continue;

										compared += 1;

										if (link) linksCompared += 1;

										if (outcome.predicted !== outcome.stored)
											wrong.push(
												`${stored.label}, ${cents} cents, income ${income}, reviewed ${reviewedByUser} -> chip ${chip}, income ${editIncome}, reviewed ${reviewed}, link ${link}: predicted ${outcome.predicted}, stored ${outcome.stored}`,
											);
									}

		// Every pair a save actually lands on, links among them: a refused link writes nothing and is skipped above.
		expect(compared).toBeGreaterThan(250);
		expect(linksCompared).toBeGreaterThan(0);
		expect(wrong.slice(0, 12), `${wrong.length} cases differ`).toEqual([]);
	}, 300_000);
});

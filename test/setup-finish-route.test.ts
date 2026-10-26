import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, daysBefore, todayIn } from "../src/dates";
import { saveAiSwitches } from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";
import {
	FINISH_HEADING,
	finishBillsLine,
	finishBudgetsLine,
	finishPayLine,
	finishSavingsLine,
} from "../src/first-tally/finish";
import { readFinish, settleAndLoad } from "../src/first-tally/first-page";
import { readMonthSummary } from "../src/month-summary";
import { questionScreen } from "../src/routes/first-page";
import { tidyName } from "../src/transactions/tidy-name";

// The setup finish reads the record, never the questions (P142 A, decision 148, spec §8.8, #774): once the budgets stroke is
// drawn, readFinish gives the finish's month, Safe to spend and rows, whatever pay or bills deposits are still unanswered.

const db = env.DB;
const TODAY = todayIn(DEFAULT_TIME_ZONE);
const MONTH = TODAY.slice(0, 7);
const DAY = daysBefore(TODAY, 2);

const ACME_FIRST = { date: "2026-09-11", cents: 245000 };
const ACME_SECOND = { date: "2026-09-25", cents: 245000 };
const ACME_DEPOSITS = [ACME_FIRST, ACME_SECOND];
const ZETA = { date: "2026-09-18", cents: 90000 };
const ZETA_DEPOSITS = [ZETA];

/** The record as a setup that drew every stroke leaves it, with the answers given. */
const drawn = (over: Record<string, unknown> = {}) => ({
	strokes: { bank: DAY, pay: DAY, bills: DAY, budgets: DAY },
	budgets: {},
	...over,
});

async function writeRecord(record: unknown) {
	await db
		.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('first_tally', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
		.bind(JSON.stringify(record))
		.run();
}

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await db.batch([
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM budget_amounts"),
		db.prepare("DELETE FROM savings_goal_amounts"),
		db.prepare("DELETE FROM planned_expenses"),
		db.prepare("DELETE FROM household_settings WHERE key = 'first_tally'"),
		db.prepare(
			"INSERT OR REPLACE INTO merchants (raw_name, display_name) VALUES ('ACME CORP PAYROLL', 'Acme Corp')",
		),
	]);
	await saveAiSwitches(db, { sortOnArrival: true });
});

describe("readFinish", () => {
	it("is null until the budgets stroke is drawn, whatever else the record holds", async () => {
		expect(await readFinish(db, TODAY)).toBeNull();
		await writeRecord({
			strokes: { bank: DAY, pay: DAY, bills: DAY },
			budgets: {},
			savings: 15000,
		});
		expect(await readFinish(db, TODAY)).toBeNull();
	});

	it("gives the month, the Safe to spend the budgets step reads, and no rows when nothing was answered", async () => {
		await writeRecord(drawn());
		const finish = await readFinish(db, TODAY);
		const { summary } = await readMonthSummary(db, TODAY, MONTH);
		expect(finish).toEqual({
			month: MONTH,
			safeCents: summary.safeToSpendCents,
			rows: { pay: [], bills: null, budgets: null, savings: null },
			sortsOnArrival: true,
		});
	});

	it("sets each row from what its step recorded: the Yes merchants in order, the kept bills, the budgets and the savings", async () => {
		// ZETA was answered first in the record's order of `at`, so ACME (answered second) is listed after it.
		await writeRecord(
			drawn({
				pay: {
					"ZETA CO": { yes: { 21: ZETA }, at: 0 },
					"ACME CORP PAYROLL": {
						yes: { 11: ACME_FIRST, 12: ACME_SECOND },
						at: 1,
					},
					"SIDE JOB": { no: { 31: { date: DAY, cents: 5000 } }, at: 2 },
				},
				bills: { kept: 8, cents: 124000 },
				budgets: {
					"1": { kind: "suggested", cents: 65000 },
					"2": { kind: "skipped", cents: null },
					"3": { kind: "another", cents: 15000 },
				},
				savings: 15000,
			}),
		);
		const finish = await readFinish(db, TODAY);
		expect(finish?.rows).toEqual({
			pay: [
				finishPayLine({ name: tidyName("ZETA CO"), deposits: ZETA_DEPOSITS }),
				finishPayLine({ name: "Acme Corp", deposits: ACME_DEPOSITS }),
			],
			bills: finishBillsLine(8, 124000),
			budgets: finishBudgetsLine(2, 80000),
			savings: finishSavingsLine(15000),
		});
	});

	it("writes no row for a step that set nothing: a skipped savings question, no bills kept, no budget set", async () => {
		await writeRecord(
			drawn({
				pay: { "SIDE JOB": { no: { 31: { date: DAY, cents: 5000 } }, at: 0 } },
				bills: { kept: 0, cents: 0 },
				budgets: { "1": { kind: "skipped", cents: null } },
				savings: "skipped",
			}),
		);
		const finish = await readFinish(db, TODAY);
		expect(finish?.rows).toEqual({
			pay: [],
			bills: null,
			budgets: null,
			savings: null,
		});
	});

	it("gives one budget and one bill with the singular words", async () => {
		await writeRecord(
			drawn({
				bills: { kept: 1, cents: 1549 },
				budgets: { "1": { kind: "suggested", cents: 65000 } },
			}),
		);
		const finish = await readFinish(db, TODAY);
		expect(finish?.rows.bills).toBe(finishBillsLine(1, 1549));
		expect(finish?.rows.budgets).toBe(finishBudgetsLine(1, 65000));
	});

	it("gives no rows for a migration 0057 record: every stroke drawn with no day, and no answers", async () => {
		await writeRecord({
			strokes: {
				bank: null,
				pay: null,
				bills: null,
				budgets: null,
				count: null,
			},
			budgets: {},
		});
		const finish = await readFinish(db, TODAY);
		expect(finish).not.toBeNull();
		expect(finish?.rows).toEqual({
			pay: [],
			bills: null,
			budgets: null,
			savings: null,
		});
	});

	it("reads Sort right away from the switch, so the finish's sort line follows it", async () => {
		await writeRecord(drawn());
		await saveAiSwitches(db, { sortOnArrival: false });
		expect((await readFinish(db, TODAY))?.sortsOnArrival).toBe(false);
	});

	it("still gives the finish when a new deposit arrives unanswered after the budgets stroke", async () => {
		await writeRecord(drawn({ bills: { kept: 2, cents: 3000 } }));
		const account = await db
			.prepare("SELECT id FROM accounts ORDER BY id LIMIT 1")
			.first<{ id: number }>();
		await db
			.prepare(
				"INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name, category_id, category_source, category_confidence, flag_income, flag_transfer) VALUES (?, 'finish-deposit', ?, -245000, 'NEW PAYER', NULL, NULL, 90, 1, 0)",
			)
			.bind(account?.id ?? 1, TODAY)
			.run();
		expect(await readFinish(db, TODAY)).not.toBeNull();
		const model = await settleAndLoad(db, TODAY);
		// The pay question is open again, but the page's finish comes from the record, so the screen is the finish.
		expect(model.pay.length).toBe(1);
		expect(model.finish).not.toBeNull();
		const markup = String(questionScreen(model, { focus: true }));
		expect(markup).toContain(FINISH_HEADING.replaceAll("'", "&#39;"));
		expect(markup).not.toContain("Is this your pay?");
	});
});

describe("settleAndLoad's finish", () => {
	it("is null until the budgets stroke is drawn, and the finish once it is", async () => {
		expect((await settleAndLoad(db, TODAY)).finish).toBeNull();
		await writeRecord(drawn());
		expect((await settleAndLoad(db, TODAY)).finish).toEqual(
			await readFinish(db, TODAY),
		);
	});
});

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	budgetFacts,
	budgetSaveStatement,
	changedSinceRead,
	decideAndSave,
	savingsGoalFacts,
	savingsGoalSaveStatement,
} from "../src/db/budget-saves";
import { resetDemo } from "../src/demo/reset";
import { nudgeBudget, saveSavingsGoal } from "../src/rules/budgets";

// The budgets area's guard (decision 190): a save lands only while what the rule read is still true, and a miss raises
// an error the route recognises, so nothing is saved on stale facts and the route reads and decides again.

const db = env.DB;
const MONTH = "2026-09";

const budgetRows = async (categoryId = 1) =>
	(
		await db
			.prepare(
				"SELECT effective_month AS month, amount_cents AS cents, typeof(amount_cents) AS type FROM budget_amounts WHERE category_id = ? ORDER BY effective_month",
			)
			.bind(categoryId)
			.all<{ month: string; cents: number; type: string }>()
	).results;

const goalRows = async () =>
	(
		await db
			.prepare(
				"SELECT effective_month AS month, amount_cents AS cents, typeof(amount_cents) AS type FROM savings_goal_amounts ORDER BY effective_month",
			)
			.all<{ month: string; cents: number; type: string }>()
	).results;

/** The error a statement fails with, or null when it runs. */
const raised = async (statement: D1PreparedStatement) => {
	try {
		await statement.run();
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}

	return null;
};

/** Whether a failure is the guard's: what the rule read had changed. */
const guardRaised = (error: Error | null) =>
	error !== null && changedSinceRead(error);

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare("DELETE FROM budget_amounts WHERE category_id = 1"),
		db.prepare("DELETE FROM savings_goal_amounts"),
	]);
});

describe("budgetFacts", () => {
	it("reads whether the category is there and archived, and its budget in the month", async () => {
		expect(await budgetFacts(db, 1, MONTH)).toEqual({
			category: { archived: false },
			budgetCents: null,
		});
		await db
			.prepare(
				"INSERT INTO budget_amounts (category_id, effective_month, amount_cents) VALUES (1, '2026-07', 70000), (1, '2026-10', 90000)",
			)
			.run();
		expect((await budgetFacts(db, 1, MONTH)).budgetCents).toBe(70000);
		await db.prepare("UPDATE categories SET archived = 1 WHERE id = 1").run();
		expect((await budgetFacts(db, 1, MONTH)).category).toEqual({
			archived: true,
		});
		expect(await budgetFacts(db, 999999, MONTH)).toEqual({
			category: null,
			budgetCents: null,
		});
	});
});

describe("budgetSaveStatement", () => {
	const save = (cents: number, expectedBudgetCents: number | null) =>
		budgetSaveStatement(db, {
			categoryId: 1,
			month: MONTH,
			cents,
			expectedBudgetCents,
		});

	it("saves a first budget, then replaces it for the same month, as whole cents", async () => {
		await save(65000, null).run();
		expect(await budgetRows()).toEqual([
			{ month: MONTH, cents: 65000, type: "integer" },
		]);
		await save(66050, 65000).run();
		expect(await budgetRows()).toEqual([
			{ month: MONTH, cents: 66050, type: "integer" },
		]);
	});

	it("saves from this month on, leaving an earlier month's budget alone", async () => {
		await db
			.prepare(
				"INSERT INTO budget_amounts (category_id, effective_month, amount_cents) VALUES (1, '2026-07', 70000)",
			)
			.run();
		await save(71000, 70000).run();
		expect(await budgetRows()).toEqual([
			{ month: "2026-07", cents: 70000, type: "integer" },
			{ month: MONTH, cents: 71000, type: "integer" },
		]);
	});

	it("raises, and saves nothing, when the budget is no longer the one the rule read", async () => {
		await save(65000, null).run();

		for (const stale of [null, 64000]) {
			const error = await raised(save(70000, stale));
			expect(guardRaised(error)).toBe(true);
		}

		expect(await budgetRows()).toEqual([
			{ month: MONTH, cents: 65000, type: "integer" },
		]);
	});

	it("raises, and saves nothing, when the category was archived or removed after the rule read it", async () => {
		await db.prepare("UPDATE categories SET archived = 1 WHERE id = 1").run();
		expect(guardRaised(await raised(save(65000, null)))).toBe(true);
		expect(await budgetRows()).toEqual([]);

		const gone = budgetSaveStatement(db, {
			categoryId: 999999,
			month: MONTH,
			cents: 65000,
			expectedBudgetCents: null,
		});

		expect(guardRaised(await raised(gone))).toBe(true);
		expect(await budgetRows(999999)).toEqual([]);
	});

	it("rolls a whole batch back when the guard raises", async () => {
		await save(65000, null).run();

		const error = await (async () => {
			try {
				await db.batch([
					db.prepare("UPDATE categories SET name = 'CHANGED' WHERE id = 1"),
					save(70000, 1),
				]);
			} catch (caught) {
				return caught instanceof Error ? caught : new Error(String(caught));
			}

			return null;
		})();

		expect(guardRaised(error)).toBe(true);
		expect(
			await db
				.prepare("SELECT name FROM categories WHERE id = 1")
				.first("name"),
		).not.toBe("CHANGED");
	});
});

describe("savingsGoalSaveStatement", () => {
	const save = (cents: number, expectedGoalCents: number | null) =>
		savingsGoalSaveStatement(db, { month: MONTH, cents, expectedGoalCents });

	it("reads no goal, then the latest goal at or before the month", async () => {
		expect(await savingsGoalFacts(db, MONTH)).toEqual({ goalCents: null });
		await save(20000, null).run();
		expect(await savingsGoalFacts(db, MONTH)).toEqual({ goalCents: 20000 });
		expect(await savingsGoalFacts(db, "2026-08")).toEqual({ goalCents: null });
	});

	it("saves a first goal, then replaces it for the same month, as whole cents", async () => {
		await save(20000, null).run();
		await save(0, 20000).run();
		expect(await goalRows()).toEqual([
			{ month: MONTH, cents: 0, type: "integer" },
		]);
	});

	it("raises, and saves nothing, when the goal is no longer the one the rule read", async () => {
		await save(20000, null).run();

		for (const stale of [null, 10000])
			expect(guardRaised(await raised(save(30000, stale)))).toBe(true);
		expect(await goalRows()).toEqual([
			{ month: MONTH, cents: 20000, type: "integer" },
		]);
	});
});

describe("changedSinceRead", () => {
	it("is false for any other failure, so it is never swallowed", async () => {
		expect(guardRaised(new Error("D1_ERROR: no such table: x"))).toBe(false);

		// A negative amount fails the table's own CHECK, which is not the guard.
		const error = await raised(
			budgetSaveStatement(db, {
				categoryId: 1,
				month: MONTH,
				cents: -1,
				expectedBudgetCents: null,
			}),
		);

		expect(error).not.toBeNull();
		expect(guardRaised(error)).toBe(false);
	});
});

describe("decideAndSave", () => {
	const nudgeUp = (stale?: number) => {
		let reads = 0;

		return {
			reads: () => reads,
			decide: async () => {
				reads += 1;
				const facts = await budgetFacts(db, 1, MONTH);

				// The first read is made to see an old amount, as a tap that lost a race would.
				return nudgeBudget.decide(
					{ categoryId: 1, direction: "up", month: MONTH },
					reads === 1 && stale !== undefined
						? { ...facts, budgetCents: stale }
						: facts,
				);
			},
		};
	};

	const seed = (cents: number) =>
		db
			.prepare(
				"INSERT INTO budget_amounts (category_id, effective_month, amount_cents) VALUES (1, ?, ?)",
			)
			.bind(MONTH, cents)
			.run();

	it("saves what the rule decided and hands the answer back", async () => {
		await seed(71240);
		const tap = nudgeUp();

		const answer = await decideAndSave(tap.decide, (w) =>
			budgetSaveStatement(db, w),
		);

		expect(answer.kind).toBe("write");
		expect(tap.reads()).toBe(1);
		expect((await budgetRows())[0]?.cents).toBe(72000);
	});

	it("reads and decides again when the facts changed under it, so a tap that lost a race still counts", async () => {
		await seed(72000);
		const tap = nudgeUp(71240);

		const answer = await decideAndSave(tap.decide, (w) =>
			budgetSaveStatement(db, w),
		);

		expect(answer).toMatchObject({ kind: "write", write: { cents: 73000 } });
		expect(tap.reads()).toBe(2);
		expect((await budgetRows())[0]?.cents).toBe(73000);
	});

	it("saves nothing for nothing to do or a refusal, and reads once", async () => {
		await seed(20000);
		let reads = 0;

		const answer = await decideAndSave(
			async () => {
				reads += 1;

				return saveSavingsGoal.decide(
					{ cents: 0, month: MONTH },
					await savingsGoalFacts(db, MONTH),
				);
			},
			(w) => savingsGoalSaveStatement(db, w),
		);

		expect(answer.kind).toBe("nothingToDo");
		expect(reads).toBe(1);
		expect(await goalRows()).toEqual([]);
	});

	it("gives up with an error after three lost races, saving nothing", async () => {
		await seed(72000);
		let reads = 0;
		await expect(
			decideAndSave(
				async () => {
					reads += 1;

					return nudgeBudget.decide(
						{ categoryId: 1, direction: "up", month: MONTH },
						{ category: { archived: false }, budgetCents: 100 },
					);
				},
				(w) => budgetSaveStatement(db, w),
			),
		).rejects.toThrow(/kept changing/);
		expect(reads).toBe(3);
		expect((await budgetRows())[0]?.cents).toBe(72000);
	});

	it("passes any other failure on at once", async () => {
		let reads = 0;
		await expect(
			decideAndSave(
				async () => {
					reads += 1;

					return nudgeBudget.decide(
						{ categoryId: 1, direction: "up", month: MONTH },
						{ category: { archived: false }, budgetCents: 100 },
					);
				},
				() => db.prepare("INSERT INTO no_such_table VALUES (1)"),
			),
		).rejects.toThrow();
		expect(reads).toBe(1);
	});
});

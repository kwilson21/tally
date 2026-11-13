import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { currentGoalSql } from "../src/db/savings-goals";
import {
	budgetAppliesSql,
	budgetAskedSql,
} from "../src/first-tally/first-page";
import { present } from "./helpers/present";

// Two SQL helpers put a month into the statement's text instead of binding it, because they sit inside larger statements
// that already number their own parameters: currentGoalSql (src/db/savings-goals.ts) and budgetAppliesSql (and through it
// budgetAskedSql, src/first-tally/first-page.ts). Each checks the month is `YYYY-MM` and throws otherwise, and that check is
// the whole defence, so a month that is not one must never reach the text (audit finding: the check had no test).

const REFUSED = [
	"",
	"2026-1",
	"26-10",
	"2026-10-01",
	" 2026-10",
	"2026-10\n",
	"2026/10",
	"2026-10'; DROP TABLE categories; --",
	"2026-10' OR '1'='1",
	"x",
];

describe("the SQL helpers that put a month into the statement", () => {
	it.each(REFUSED)("currentGoalSql refuses %j", (month) => {
		expect(() => currentGoalSql(month)).toThrow("not a month");
	});

	it.each(REFUSED)("budgetAppliesSql refuses %j", (month) => {
		expect(() => budgetAppliesSql("c", month)).toThrow("not a month");
	});

	it.each(REFUSED)(
		"budgetAskedSql refuses %j, through budgetAppliesSql",
		(month) => {
			expect(() => budgetAskedSql("c", month)).toThrow("not a month");
		},
	);

	it("currentGoalSql names the month once, quoted, and is SQL the database accepts", async () => {
		const sql = currentGoalSql("2026-10");

		expect(sql.match(/2026-10/g)).toHaveLength(1);
		expect(sql).toContain("'2026-10'");

		const row = present(
			await env.DB.prepare(`SELECT ${sql} AS cents`).first<{
				cents: number | null;
			}>(),
		);

		// No goal is stored, or one is: either way the helper read the table without an error.
		expect(row).toHaveProperty("cents");
	});

	it("budgetAppliesSql names the month once, quoted, and is SQL the database accepts", async () => {
		const sql = budgetAppliesSql("c", "2026-10");

		expect(sql.match(/2026-10/g)).toHaveLength(1);
		expect(sql).toContain("'2026-10'");

		const row = present(
			await env.DB.prepare(
				`SELECT COUNT(*) AS n FROM categories c WHERE ${sql}`,
			).first<{ n: number }>(),
		);

		expect(row.n).toBeGreaterThanOrEqual(0);
	});
});

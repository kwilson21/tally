import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadTrends } from "../src/db/trends";
import { resetDemo } from "../src/demo/reset";
import { buildTrends } from "../src/trends";

// The demo's six months are written so Trends has a story on any day (spec §9, row 6): Groceries,
// Gas and Household under budget month after month, Eating Out creeping up, Kids neither.
describe("Trends with the demo seed", () => {
	it.each([
		"2026-09-22",
		"2026-10-01",
		"2026-10-05",
		"2026-10-31",
		"2026-03-31",
		"2027-01-31",
	])("tells the demo's story on %s", async (today) => {
		await resetDemo(env.DB, today);
		const page = buildTrends(await loadTrends(env.DB, today));
		if (page.kind !== "full")
			throw new Error(`expected full, got ${page.kind}`);
		expect(page.goingWell.map((r) => [r.name, r.line])).toEqual([
			["Groceries", "4 months under budget"],
			["Gas", "4 months under budget"],
			["Household", "4 months under budget"],
		]);
		expect(page.worthALook.map((r) => [r.name, r.line])).toEqual([
			["Eating Out", "Up 3 months running"],
		]);
		expect(page.others.map((r) => r.name)).toEqual(["Kids"]);
		// Six months drawn, this one still going.
		expect(page.goingWell[0]?.months).toHaveLength(6);
		expect(page.goingWell[0]?.months.at(-1)?.partial).toBe(true);
	});

	it("has a comparison with last month's days on every day, in dollars", async () => {
		const today = "2026-10-05";
		await resetDemo(env.DB, today);
		const page = buildTrends(await loadTrends(env.DB, today));
		if (page.kind !== "full")
			throw new Error(`expected full, got ${page.kind}`);
		expect(page.caption).toBe("Oct 1–5 against Sep 1–5");
		expect(page.sentence).toMatch(
			/^(\$[\d,]+ (less|more) than|About the same as) by this time in September\.$/,
		);
		// The rows add up to the headline: every cent is in a category or in Uncategorized.
		expect(page.changes.reduce((sum, c) => sum + c.nowCents, 0)).toBe(
			page.soFarCents,
		);
		expect(page.changes.reduce((sum, c) => sum + c.thenCents, 0)).toBe(
			page.sameDaysCents.last,
		);
	});
});

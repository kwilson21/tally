import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadTrends } from "../src/db/trends";
import { resetDemo } from "../src/demo/reset";
import { buildTrends } from "../src/trends";

const DATES = [
	"2026-09-22",
	"2026-10-01",
	"2026-10-02",
	"2026-10-05",
	"2026-10-12",
	"2026-10-23",
	"2026-10-31",
	"2026-03-31",
	"2027-01-31",
];

async function demoPage(today: string) {
	await resetDemo(env.DB, today);
	const page = buildTrends(await loadTrends(env.DB, today));
	if (page.kind !== "full") throw new Error(`expected full, got ${page.kind}`);
	return page;
}

// The demo's six months are written so Trends has a story on any day (spec §9, row 6): Groceries,
// Gas under budget month after month, Eating Out creeping up, Kids neither. History
// starts on the 1st of the earliest month, so that month is a full one and counts.
describe("Trends with the demo seed", () => {
	it.each(DATES)("tells the demo's story on %s", async (today) => {
		const page = await demoPage(today);
		const earlyOctober = today === "2026-10-01" || today === "2026-10-02";
		expect(page.goingWell.map((r) => [r.name, r.line])).toEqual(
			earlyOctober
				? [
						["Groceries", "5 months under budget"],
						["Gas", "5 months under budget"],
					]
				: [
						["Groceries", "5 months under budget"],
						["Gas", "5 months under budget"],
						["Household", "5 months under budget"],
					],
		);
		expect(page.worthALook.map((r) => [r.name, r.line])).toEqual([
			["Eating Out", "Up 4 months running"],
		]);
		expect(page.others.map((r) => r.name)).toEqual(
			earlyOctober ? ["Kids", "Household"] : ["Kids"],
		);
		// Six months drawn, this one still going, and none of them a part month.
		const months = page.goingWell[0]?.months ?? [];
		expect(months).toHaveLength(6);
		expect(months.at(-1)?.partial).toBe(true);
		expect(months.some((m) => m.part !== undefined)).toBe(false);
	});

	// Past months' spending is dated like this month's (clamped to today's day-of-month), so the
	// same-days comparison is fair on any day: a modest difference, in the household's favour.
	it.each(DATES)(
		"says this month is a modest amount less than by this time last month on %s",
		async (today) => {
			const page = await demoPage(today);
			const gap = page.sentence.match(/^\$([\d,]+) less than by this time in /);
			expect(gap).not.toBeNull();
			const dollars = Number((gap?.[1] ?? "0").replaceAll(",", ""));
			expect(dollars).toBeGreaterThan(100);
			expect(dollars).toBeLessThan(400);
			// Out of about $1,700 for last month's days.
			expect(page.sameDaysCents.last).toBeGreaterThan(150000);
		},
	);

	it("has the same-days caption and rows that add up, in dollars", async () => {
		const page = await demoPage("2026-10-05");
		expect(page.caption).toBe("Oct 1–5 against Sep 1–5");
		// The rows add up to the headline: every cent is in a category or in Needs a category.
		expect(page.changes.reduce((sum, c) => sum + c.nowCents, 0)).toBe(
			page.soFarCents,
		);
		expect(page.changes.reduce((sum, c) => sum + c.thenCents, 0)).toBe(
			page.sameDaysCents.last,
		);
	});

	it("keeps Eating Out creeping up in the changes too, with groceries down", async () => {
		const page = await demoPage("2026-10-05");
		const words = (name: string) =>
			page.changes.find((c) => c.name === name)?.direction;
		expect(words("Eating Out")).toBe("up");
		expect(words("Groceries")).toBe("down");
	});
});

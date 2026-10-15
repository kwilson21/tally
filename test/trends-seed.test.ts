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
			// Childcare has last month's Fridays, so it is in the rest from October 1 on. Rent, with its budget from this
			// month, is in the rest too (#205).
			earlyOctober
				? ["Kids", "Household", "Childcare", "Rent"]
				: ["Kids", "Childcare", "Rent"],
		);
		// Six months drawn, this one still going, and none of them a part month.
		const months = page.goingWell[0]?.months ?? [];
		expect(months).toHaveLength(6);
		expect(months.at(-1)?.partial).toBe(true);
		expect(months.some((m) => m.part !== undefined)).toBe(false);
	});

	// Past months' spending follows the same pace as this month's (#322), so the same-days comparison is fair on any day:
	// a difference in the household's favour, under $400. Daycare's Fridays fall on other days each month, so on a few
	// days an extra Friday this month leaves only a few dollars between the two months.
	it.each(DATES)(
		"says this month is less than by this time last month, by under four hundred dollars, on %s",
		async (today) => {
			const page = await demoPage(today);
			const gap = page.sentence.match(/^\$([\d,]+) less than by this time in /);
			expect(gap).not.toBeNull();
			const dollars = Number((gap?.[1] ?? "0").replaceAll(",", ""));
			expect(dollars).toBeGreaterThan(0);
			// Rent adds $100 in the household's favour: last month's $700 was paid by this time and this month's $600 has been.
			// Its $500 was paid late, this month, so it isn't in last month's days (the seed dates it this month's 1st).
			expect(dollars).toBeLessThan(400);
			// Last month's same days: $1,202 for its first two days, the least to compare with (the spending is paced, #322),
			// and $3,359 for the whole month.
			expect(page.sameDaysCents.last).toBeGreaterThan(100000);
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

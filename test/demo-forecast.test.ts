import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeMonth } from "../src/budget";
import { daysInMonth } from "../src/dates";
import { loadMonth } from "../src/db/month";
import { resetDemo } from "../src/demo/reset";

// The demo's spending is paced through the month, so Home's forecast agrees with its sentence on every day from the
// 7th (#322, decision 119): the forecast says "under", or "over" by no more than Eating Out's overage. The 5-Friday
// months (October 2026, January 2027, April 2027) are the tightest, and February 2028 is the one leap February.

/** Home's page for the demo reset to `today`, read at noon UTC on that day (the household's day in New York). */
async function homeOn(today: string): Promise<string> {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(`${today}T12:00:00Z`));
	await resetDemo(env.DB, today);
	const res = await exports.default.fetch("http://tally.test/");
	return res.text();
}

/** Home's forecast as the page says it: "under" or "over", and the whole dollars shown. */
function forecastOf(html: string): { direction: string; cents: number } {
	const match = html.match(
		/where it ends at this pace: \$([\d,]+) (under|over) the /,
	);
	if (!match) throw new Error("Home shows no forecast");
	return {
		direction: match[2] ?? "",
		cents: Number((match[1] ?? "0").replaceAll(",", "")) * 100,
	};
}

/** The category's spending on the reset demo, summarized as Home summarizes it. */
async function categoryOn(
	month: string,
	name: string,
): Promise<{ spentCents: number; budgetCents: number; leftCents: number }> {
	const data = await loadMonth(env.DB, month);
	const summary = summarizeMonth({
		month,
		...data,
		unpaidDueBillsCents: 0,
		savingsGoalCents: data.savingsGoalCents,
	});
	const category = summary.categories.find((c) => c.name === name);
	if (!category) throw new Error(`${name} has no budget`);
	return category;
}

describe("Home's forecast agrees with its sentence on the demo (#322)", () => {
	afterEach(() => vi.useRealTimers());

	it.each([
		["2026-10", "October 2026, a 31-day month with five Fridays"],
		["2027-01", "January 2027, a 31-day month with five Fridays"],
		["2027-04", "April 2027, a 30-day month with five Fridays"],
		["2027-02", "February 2027, a 28-day month"],
		["2028-02", "February 2028, a 29-day leap month"],
	])(
		"on %s (%s), from the 7th to the last day",
		async (month) => {
			const last = daysInMonth(month);
			const failures: string[] = [];
			for (let day = 7; day <= last; day++) {
				const today = `${month}-${String(day).padStart(2, "0")}`;
				const html = await homeOn(today);
				const forecast = forecastOf(html);
				const overage = -(await categoryOn(month, "Eating Out")).leftCents;
				// Whole dollars, as the forecast is shown: an "over" may not exceed Eating Out's overage rounded up.
				const agrees =
					forecast.direction === "under" ||
					(overage > 0 && forecast.cents <= Math.ceil(overage / 100) * 100);
				if (!agrees)
					failures.push(
						`${today}: forecast ${forecast.direction} $${forecast.cents / 100}, Eating Out over $${Math.max(0, overage) / 100}`,
					);
			}
			expect(failures).toEqual([]);
		},
		60_000,
	);

	it("tells the story's dates: Eating Out over from the 13th, Gas near its limit from the 20th", async () => {
		const month = "2026-10";
		const onDay = async (day: number) => {
			await homeOn(`${month}-${String(day).padStart(2, "0")}`);
			return categoryOn(month, "Eating Out");
		};
		const gasOn = async (day: number) => {
			await homeOn(`${month}-${String(day).padStart(2, "0")}`);
			return categoryOn(month, "Gas");
		};
		expect((await onDay(12)).leftCents).toBeGreaterThanOrEqual(0);
		expect((await onDay(13)).leftCents).toBeLessThan(0);
		const near = (gas: { spentCents: number; budgetCents: number }) =>
			gas.spentCents <= gas.budgetCents &&
			gas.spentCents * 5 >= gas.budgetCents * 4;
		expect(near(await gasOn(19))).toBe(false);
		expect(near(await gasOn(20))).toBe(true);
	});

	it("says the story in Home's own words on the 13th and the 20th", async () => {
		expect(await homeOn("2026-10-13")).toContain(
			"Eating Out is $14 over. Everything else is on track.",
		);
		expect(await homeOn("2026-10-20")).toContain(
			"Eating Out is $86 over. Everything else is on track.",
		);
	});
});

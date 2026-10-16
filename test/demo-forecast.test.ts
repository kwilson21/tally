import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeMonth } from "../src/budget";
import { daysInMonth } from "../src/dates";
import { loadMonth } from "../src/db/month";
import { resetDemo } from "../src/demo/reset";
import { safeToSpendText } from "../src/views/home-top";

// The demo's spending is paced through the month, so from the 7th Home's forecast agrees with its sentence (#322,
// decision 119): the forecast says "under", or "over" by no more than Eating Out's overage. The check runs to the
// month's end. Safe to spend holds at $0 or above through the last week too (#631, decision 123): a bill due next month
// is not set aside from this month, so the sentence never turns into "Over budget this month…". The 5-Friday months
// (October 2026, January 2027, April 2027) are the tightest, and February 2028 is the one leap February.

/** The five months the demo is checked in: three 5-Friday months, one 28-day February and one leap February. */
const DEMO_MONTHS: [string, string][] = [
	["2026-10", "October 2026, a 31-day month with five Fridays"],
	["2027-01", "January 2027, a 31-day month with five Fridays"],
	["2027-04", "April 2027, a 30-day month with five Fridays"],
	["2027-02", "February 2027, a 28-day month"],
	["2028-02", "February 2028, a 29-day leap month"],
];

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

/** Safe to spend as Home shows it, in cents: negative when the page shows a minus sign. */
function safeToSpendOf(html: string): number {
	const match = html.match(
		/Safe to spend[\s\S]*?<\/p><p[^>]*><span class="whitespace-nowrap">(−?)\$([\d,]+)/,
	);
	if (!match) throw new Error("Home shows no Safe to spend");
	const dollars = Number((match[2] ?? "0").replaceAll(",", ""));
	return (match[1] === "−" ? -1 : 1) * dollars * 100;
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

	it.each(DEMO_MONTHS)(
		"on %s (%s), from the 7th to the last day: the forecast agrees, and Safe to spend stays at $0 or more (#631)",
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
				const safe = safeToSpendOf(html);
				if (safe < 0) failures.push(`${today}: Safe to spend $${safe / 100}`);
			}
			expect(failures).toEqual([]);
		},
		60_000,
	);

	it.each(DEMO_MONTHS)(
		"on %s (%s), the last day shows the status sentence, not Over budget, and Childcare is within its budget (#631)",
		async (month) => {
			const html = await homeOn(
				`${month}-${String(daysInMonth(month)).padStart(2, "0")}`,
			);
			expect(html).not.toContain("Over budget this month");
			expect(html).toMatch(/text-lg italic">[^<]*(on track|over)\./);
			expect(
				(await categoryOn(month, "Childcare")).leftCents,
			).toBeGreaterThanOrEqual(0);
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

describe("safeToSpendOf reads Home's Safe to spend in cents (#631)", () => {
	/** The markup Home's top writes around the amount (src/views/home-top.tsx). */
	const homeTop = (cents: number) =>
		`<p class="text-lg text-muted">Safe to spend · </p><p class="font-serif"><span class="whitespace-nowrap">${safeToSpendText(cents)}</span></p>`;

	it("reads −$0.40 as −40, so the $0-or-more check catches a negative with cents", () => {
		expect(safeToSpendOf(homeTop(-40))).toBe(-40);
		expect(safeToSpendOf(homeTop(-40)) < 0).toBe(true);
	});

	it.each([-600, 0, 37900, 120300])(
		"reads %i back as the same cents",
		(cents) => {
			expect(safeToSpendOf(homeTop(cents))).toBe(cents);
		},
	);
});

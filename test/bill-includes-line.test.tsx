/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { BillStatusHeading, includesLine } from "../src/views/bill-row";

// Decision 122 (P136 A): a heading whose total counts occurrences no row lists says so in a muted line under it.
describe("includesLine: the words under a heading whose total counts unlisted occurrences", () => {
	it("names a weekly bill's Fridays with their dates, the last two joined by and", () => {
		expect(
			includesLine([
				{
					name: "Daycare",
					frequency: "weekly",
					dueDates: ["2026-10-02", "2026-10-09"],
				},
			]),
		).toBe("Includes Daycare's Fridays on Oct 2 and 9");
	});

	it("names one date alone in the singular weekday", () => {
		expect(
			includesLine([
				{ name: "Daycare", frequency: "weekly", dueDates: ["2026-10-23"] },
			]),
		).toBe("Includes Daycare's Friday on Oct 23");
	});

	it("separates three or more dates with commas and then and", () => {
		expect(
			includesLine([
				{
					name: "Daycare",
					frequency: "weekly",
					dueDates: ["2026-10-02", "2026-10-09", "2026-10-16"],
				},
			]),
		).toBe("Includes Daycare's Fridays on Oct 2, 9 and 16");
	});

	it("writes the month again when a date falls in the next month", () => {
		expect(
			includesLine([
				{
					name: "Daycare",
					frequency: "weekly",
					dueDates: ["2026-10-30", "2026-11-06"],
				},
			]),
		).toBe("Includes Daycare's Fridays on Oct 30 and Nov 6");
	});

	it("names a biweekly bill's Fridays the same way", () => {
		expect(
			includesLine([
				{ name: "Gym", frequency: "biweekly", dueDates: ["2026-10-02"] },
			]),
		).toBe("Includes Gym's Friday on Oct 2");
	});

	it("names a monthly bill by its name and date, with no weekday", () => {
		expect(
			includesLine([
				{ name: "Rent", frequency: "monthly", dueDates: ["2026-10-01"] },
			]),
		).toBe("Includes Rent on Oct 1");
	});

	it("names two bills, then says and N more for the rest", () => {
		const daycare = {
			name: "Daycare",
			frequency: "weekly" as const,
			dueDates: ["2026-10-02", "2026-10-09"],
		};
		const gym = {
			name: "Gym",
			frequency: "monthly" as const,
			dueDates: ["2026-10-04"],
		};
		const netflix = {
			name: "Netflix",
			frequency: "monthly" as const,
			dueDates: ["2026-10-05"],
		};
		expect(includesLine([daycare, gym])).toBe(
			"Includes Daycare's Fridays on Oct 2 and 9, Gym on Oct 4",
		);
		expect(includesLine([daycare, gym, netflix])).toBe(
			"Includes Daycare's Fridays on Oct 2 and 9, Gym on Oct 4, and 1 more",
		);
		expect(
			includesLine([daycare, gym, netflix, { ...netflix, name: "Water" }]),
		).toBe(
			"Includes Daycare's Fridays on Oct 2 and 9, Gym on Oct 4, and 2 more",
		);
	});

	it("is left out when no occurrence is unlisted", () => {
		expect(includesLine([])).toBeUndefined();
	});
});

describe("BillStatusHeading with its unlisted line", () => {
	it("draws the line as a muted paragraph under the heading, after its total", () => {
		const html = String(
			BillStatusHeading({
				status: "paid",
				totalCents: 49698,
				includes: "Includes Daycare's Fridays on Oct 2 and 9",
			}),
		);
		expect(html).toContain("$496.98</span>");
		expect(html).toContain(
			'<p class="text-sm text-muted">Includes Daycare&#39;s Fridays on Oct 2 and 9</p>',
		);
		expect(html.indexOf("</div>")).toBeLessThan(html.indexOf("<p "));
	});

	it("draws no paragraph when there is no line", () => {
		const html = String(
			BillStatusHeading({ status: "paid", totalCents: 1698 }),
		);
		expect(html).not.toMatch(/<p[ >]/);
	});
});

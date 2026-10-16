/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { RowArrow } from "../src/views/icons";
import { PlanBand, PlannedRow } from "../src/views/planned-expense";

const PLAN = {
	id: 1,
	name: "Car registration",
	amountCents: 18000,
	month: "2026-10",
};

// P118 A (decision 111, #602): every row that opens ends in Settings' small muted arrow, planned rows too.
describe("PlannedRow's arrow", () => {
	it("ends a row that opens its plan in the row arrow", () => {
		const html = String(
			PlannedRow({
				plan: PLAN,
				month: "2026-10",
				today: "2026-10-15",
				href: "/plans/1/edit",
			}),
		);
		expect(html).toContain("row-opens");
		expect(html).toContain(String(RowArrow({})));
		expect(html.indexOf(String(RowArrow({})))).toBeGreaterThan(
			html.indexOf("Car registration"),
		);
	});

	it("draws no arrow on a row that opens nothing", () => {
		const html = String(
			PlannedRow({ plan: PLAN, month: "2026-10", today: "2026-10-15" }),
		);
		expect(html).not.toContain("row-opens");
		expect(html).not.toContain(String(RowArrow({})));
	});
});

// The Band's dots say how many plans wait (P105): one plan is one question, so no dot and no count are drawn.
describe("PlanBand's pager dots", () => {
	it("draws no dot and no count for one waiting plan", () => {
		const html = String(
			PlanBand({
				planId: 1,
				name: "Car registration",
				moveLabel: "Nov",
				waiting: 1,
			}),
		);
		expect(html).toContain("Car registration wasn&#39;t paid");
		expect(html).not.toContain("rounded-full bg-ink");
		expect(html).not.toContain("rounded-full bg-muted/40");
		expect(html).not.toContain("planned expenses that weren&#39;t paid");
	});

	it("draws a dot for each of two waiting plans, and the count for screen readers", () => {
		const html = String(
			PlanBand({
				planId: 1,
				name: "Car registration",
				moveLabel: "Nov",
				waiting: 2,
			}),
		);
		expect(html.match(/size-2\.5 rounded-full/g)?.length).toBe(2);
		expect(html).toContain("1 of 2 planned expenses that weren&#39;t paid");
	});
});

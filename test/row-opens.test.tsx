import { describe, expect, it } from "vitest";
import { BillRow } from "../src/views/bill-row";
import { ProgressRow } from "../src/views/progress-row";
import { SavingsGoalRow } from "../src/views/savings-goal-row";

/** The arrow's classes, as RowArrow writes them (decision 111, P118 A). */
const ARROW =
	'class="size-5 shrink-0 -ml-3 -mr-2 text-muted group-hover:text-ink';

const budget = (props: Partial<Parameters<typeof ProgressRow>[0]> = {}) =>
	ProgressRow({
		name: "Gas",
		icon: "gas",
		color: "cat-slate",
		spentCents: 18600,
		budgetCents: 20000,
		href: "/budget/3",
		...props,
	}).toString();

describe("ProgressRow that opens", () => {
	it("ends its name line in the arrow, outside the text column, so the bars still line up", async () => {
		const html = await budget();
		expect(html).toMatch(
			new RegExp(
				`</div><svg ${ARROW} self-start mt-1"[^>]*aria-hidden="true" data-icon="chevron-right"`,
			),
		);
	});

	it("is marked as opening, so it takes the press tint", async () => {
		expect(await budget()).toContain("row-opens");
	});

	it("draws no arrow in Adjust mode, where the − and + take the room, but keeps the press", async () => {
		const html = await budget({
			nudge: { href: "/budget/3/nudge", id: "nudge-3" },
		});
		expect(html).not.toContain("chevron-right");
		expect(html).toContain("row-opens");
	});

	it("has no arrow and no press with no link, as an archived or finished month's row", async () => {
		const html = await budget({ href: undefined });
		expect(html).not.toContain("chevron-right");
		expect(html).not.toContain("row-opens");
	});
});

describe("SavingsGoalRow that opens", () => {
	it("ends a set goal in the arrow and is marked as opening", async () => {
		const html = await SavingsGoalRow({
			amountCents: 50000,
			href: "/savings-goal",
		}).toString();
		expect(html).toMatch(
			new RegExp(
				`<svg ${ARROW} self-start mt-1"[^>]*data-icon="chevron-right"`,
			),
		);
		expect(html).toContain("row-opens");
	});

	it("has no arrow and no press on Set a goal, which ends in terracotta words", async () => {
		const html = await SavingsGoalRow({
			amountCents: null,
			href: "/savings-goal",
		}).toString();
		expect(html).toContain("Set a goal");
		expect(html).not.toContain("chevron-right");
		expect(html).not.toContain("row-opens");
	});
});

describe("BillRow", () => {
	const bill = {
		id: 1,
		name: "Rent",
		amountCents: 120000,
		status: "due" as const,
		dueDate: "2026-10-15",
		icon: "bills",
		color: "cat-brown",
	};

	it("ends a row with a link in the arrow after the amount, and marks it as opening", async () => {
		const html = await BillRow({
			bill,
			today: "2026-10-14",
			href: "/bills/1",
		}).toString();
		expect(html).toMatch(
			new RegExp(`</span><svg ${ARROW}"[^>]*data-icon="chevron-right"`),
		);
		expect(html).toContain("row-opens");
	});

	it("has no arrow and no press on Home's due bill, which has no link", async () => {
		const html = await BillRow({ bill, today: "2026-10-14" }).toString();
		expect(html).not.toContain("chevron-right");
		expect(html).not.toContain("row-opens");
	});
});

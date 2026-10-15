/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import type { ListRow } from "../src/db/transactions";
import { RowArrow } from "../src/views/icons";
import { ProgressRow } from "../src/views/progress-row";
import { SavedTick, savedRowClass } from "../src/views/saved-tick";
import { SavingsGoalRow } from "../src/views/savings-goal-row";
import { TransactionRow } from "../src/views/transaction-row";

// P119 A (decision 111, #71): a save's own reply marks its row, and the pencil tick takes the arrow's place
// for as long as the toast stays. These are the markup facts; the CSS timing is in test/motion.test.tsx.

const base: ListRow = {
	id: 7,
	date: "2026-09-22",
	amountCents: 1200,
	rawName: "SQ *LOCAL BAKERY 4432",
	displayName: "Local Bakery",
	note: null,
	excluded: false,
	income: false,
	creditReviewed: true,
	categoryId: null,
	categoryName: null,
	categoryIcon: null,
	categoryColor: null,
};

const row = (saved?: "toast" | "undo" | "held") =>
	TransactionRow({ row: base, href: "/transactions/7", saved }).toString();

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

/** The number of times a class appears as a whole class name in the markup. */
const classCount = (html: string, name: string) =>
	(html.match(new RegExp(`(?:^|[\\s"])${name}(?=[\\s"])`, "g")) ?? []).length;

describe("savedRowClass", () => {
	it("gives the toast's four seconds row-saved, an Undo toast's ten row-saved-undo, and nothing otherwise", () => {
		expect(savedRowClass("toast")).toBe("row-saved");
		expect(savedRowClass("undo")).toBe("row-saved-undo");
		expect(savedRowClass("held")).toBe("row-saved-held");
		expect(savedRowClass(undefined)).toBe("");
	});
});

describe("SavedTick", () => {
	it("is the drawing's pencil tick, hidden from assistive technology", () => {
		const html = SavedTick({}).toString();
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain('class="saved-tick');
		expect(html).toContain("text-ink");
		expect(html).toContain("<path");
		expect(html).toContain('fill="currentColor"');
	});

	it("is the arrow's size, so it takes the arrow's place", () => {
		expect(SavedTick({}).toString()).toContain("size-5");
	});
});

describe("RowArrow", () => {
	it("is unchanged when the row has no save", () => {
		const html = RowArrow({}).toString();
		expect(html).toContain('data-icon="chevron-right"');
		expect(html).not.toContain("saved-tick");
		expect(html).not.toContain("saved-arrow");
	});

	it("puts the tick in the arrow's place, with the arrow inside a saved-arrow slot CSS brings back", () => {
		const html = RowArrow({ saved: "toast" }).toString();
		expect(html).toContain("saved-tick");
		expect(html).toMatch(
			/<span class="saved-arrow[^"]*"><svg[^>]*data-icon="chevron-right"/,
		);
		expect(classCount(html, "saved-tick")).toBe(1);
	});
});

describe("TransactionRow that opens", () => {
	it("marks the row with row-saved when its save's toast stays four seconds", () => {
		const html = row("toast");
		expect(classCount(html, "row-saved")).toBe(1);
		expect(html).not.toContain("row-saved-undo");
		expect(html).toContain("saved-tick");
	});

	it("marks the row with row-saved-undo when its toast offers Undo", () => {
		const html = row("undo");
		expect(classCount(html, "row-saved-undo")).toBe(1);
		expect(classCount(html, "row-saved")).toBe(0);
	});

	it("marks nothing without a save", () => {
		const html = row(undefined);
		expect(html).not.toContain("row-saved");
		expect(html).not.toContain("saved-tick");
	});

	it("marks nothing for a row with no link, which has no arrow to take the tick's place", () => {
		const html = TransactionRow({ row: base, saved: "toast" }).toString();
		expect(html).not.toContain("row-saved");
		expect(html).not.toContain("saved-tick");
	});
});

describe("ProgressRow that opens", () => {
	it("marks its link with row-saved and draws the tick where the arrow sits", () => {
		const html = budget({ saved: "toast" });
		expect(html).toMatch(/<a href="\/budget\/3" class="[^"]*\brow-saved\b/);
		expect(html).toContain("saved-tick");
	});

	it("keeps its bars drawn still on a save's reply, so only the toast and the tick move", () => {
		expect(budget({ saved: "toast", barsStill: true })).not.toContain(
			"bar-fill",
		);
	});

	it("animates its bars on a plain load", () => {
		expect(budget()).toContain("bar-fill");
		expect(budget({ saved: undefined })).toContain("bar-fill");
	});

	it("marks nothing with no link, as an archived category's row", () => {
		const html = budget({ saved: "toast", href: undefined });
		expect(html).not.toContain("row-saved");
		expect(html).not.toContain("saved-tick");
	});
});

describe("SavingsGoalRow", () => {
	it("marks a set goal's row, which ends in the arrow", () => {
		const html = SavingsGoalRow({
			amountCents: 50000,
			href: "/savings-goal",
			saved: "toast",
		}).toString();
		expect(html).toMatch(/<a href="\/savings-goal" class="[^"]*\brow-saved\b/);
		expect(html).toContain("saved-tick");
	});

	it("marks nothing for a goal that is not set, which ends in terracotta words", () => {
		const html = SavingsGoalRow({
			amountCents: null,
			href: "/savings-goal",
			saved: "toast",
		}).toString();
		expect(html).not.toContain("row-saved");
	});
});

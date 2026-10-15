/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import type { ListRow } from "../src/db/transactions";
import { HouseholdPeople } from "../src/views/household-people";
import { RowArrow } from "../src/views/icons";
import { ProgressRow } from "../src/views/progress-row";
import { listRowMark, SavedTick, savedRowClass } from "../src/views/saved-tick";
import { SavingsGoalRow } from "../src/views/savings-goal-row";
import { TimeZoneRow } from "../src/views/time-zone-row";
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

describe("listRowMark", () => {
	it("marks the saved row with a toast's mark by default", () => {
		expect(listRowMark(7, 7)).toBe("toast");
	});

	it("marks the saved row undo when its toast offers Undo", () => {
		expect(listRowMark(7, 7, "undo")).toBe("undo");
	});

	it("marks no other row, and nothing when there was no save", () => {
		expect(listRowMark(8, 7)).toBeUndefined();
		expect(listRowMark(8, 7, "undo")).toBeUndefined();
		expect(listRowMark(7)).toBeUndefined();
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

// P119 A (#71): the Settings rows a save redraws. A row gets the tick only when its save's reply names it (the route
// tests in test/saved-row-replies.test.ts say which); these are the markup facts of the components alone.
describe("TimeZoneRow that a save just changed", () => {
	const zone = (saved?: "toast" | "held") =>
		TimeZoneRow({ zone: "America/New_York", saved }).toString();

	it("marks its row with row-saved and draws the tick once", () => {
		const html = zone("toast");
		expect(classCount(html, "row-saved")).toBe(1);
		expect(classCount(html, "saved-tick")).toBe(1);
		expect(html).not.toContain("row-saved-undo");
	});

	it("puts the chevron in the arrow's slot, so the tick takes its place and the chevron keeps its turn", () => {
		expect(zone("toast")).toMatch(
			/<span class="saved-arrow[^"]*"><span class="shrink-0 text-muted transition-transform group-open:rotate-90/,
		);
	});

	it("draws the catalog's still picture with row-saved-held", () => {
		const html = zone("held");
		expect(classCount(html, "row-saved-held")).toBe(1);
		expect(classCount(html, "saved-tick")).toBe(1);
	});

	it("marks nothing without a save", () => {
		const html = zone();
		expect(html).not.toContain("row-saved");
		expect(html).not.toContain("saved-tick");
	});
});

describe("HouseholdPeople that a save just changed", () => {
	const people = [
		{ id: 1, name: "Everyone" },
		{ id: 2, name: "Kids" },
		{ id: 3, name: "Morgan" },
	];
	const list = (saved?: { id: number; mark: "toast" | "held" }) =>
		HouseholdPeople({ people, saved }).toString();

	/** The opening tag of the disclosure that holds `marker`, found by walking back from the marker to its <details>. */
	const detailsOf = (html: string, marker: string) => {
		const at = html.indexOf(marker);
		const start = at < 0 ? -1 : html.lastIndexOf("<details", at);
		return start < 0 ? "" : html.slice(start, html.indexOf(">", start) + 1);
	};

	it("marks only the named person's row, with the tick in its chevron's place", () => {
		const html = list({ id: 3, mark: "toast" });
		expect(classCount(html, "row-saved")).toBe(1);
		expect(classCount(html, "saved-tick")).toBe(1);
		expect(detailsOf(html, 'value="3"')).toMatch(/\brow-saved\b/);
		expect(html).toMatch(/<span class="saved-arrow[^"]*"><svg/);
	});

	it("never marks Everyone, the first row, even when it is named", () => {
		const html = list({ id: 1, mark: "toast" });
		expect(html).not.toContain("row-saved");
		expect(html).not.toContain("saved-tick");
	});

	it("never marks Add a person", () => {
		const html = list({ id: 3, mark: "toast" });
		expect(detailsOf(html, "Add a person")).not.toMatch(/row-saved/);
	});

	it("draws the catalog's still picture with row-saved-held", () => {
		const html = list({ id: 2, mark: "held" });
		expect(classCount(html, "row-saved-held")).toBe(1);
		expect(detailsOf(html, 'value="2"')).toMatch(/\brow-saved-held\b/);
	});

	it("marks nothing without a save", () => {
		const html = list();
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

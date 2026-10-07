import { describe, expect, it } from "vitest";
import {
	BillsDiagram,
	BudgetDiagram,
	CategoriesDiagram,
	ExclusionsDiagram,
	TransactionsDiagram,
} from "../src/views/how-diagrams";

const render = async (el: unknown) => String(await el);
/** Everything a person sees or hears: the visible text plus the title and description. */
const words = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replaceAll("&#39;", "'")
		.replace(/\s+/g, " ")
		.trim();

/** An accessible image: role="img", labelled by a title and a description that exist. */
function expectLabelled(html: string) {
	const svg = html.match(/<svg[^>]*>/)?.[0] ?? "";
	expect(svg).toContain('role="img"');
	const ids = svg.match(/aria-labelledby="([^"]+)"/)?.[1]?.split(" ") ?? [];
	expect(ids).toHaveLength(2);
	expect(html).toMatch(new RegExp(`<title id="${ids[0]}">[^<]+</title>`));
	expect(html).toMatch(new RegExp(`<desc id="${ids[1]}">[^<]+</desc>`));
	// Scales to the screen, like the system diagram.
	expect(svg).toContain("w-full");
}
const desc = (html: string) =>
	(html.match(/<desc[^>]*>([^<]+)</)?.[1] ?? "").replaceAll("&#39;", "'");

describe("BillsDiagram", () => {
	const props = {
		amount: "$142.00",
		due: "Sep 21",
		paid: "Sep 24",
		windowDays: 5,
		tolerance: "10%",
	};

	it("draws its connector in ink, since terracotta means you can click it", async () => {
		const html = await render(BillsDiagram(props));
		expectLabelled(html);
		expect(html).toContain('<path d="M120 50 H238" class="stroke-ink"');
		expect(html).not.toContain("stroke-accent");
	});

	it("stacks the match words in the gap, so no line reaches either box", async () => {
		const html = await render(BillsDiagram(props));
		const label = (text: string) =>
			html.match(new RegExp(`<text [^>]*>${text}</text>`))?.[0] ?? "";
		// Each line stays short enough for the 118-unit gap at 11px, even with a long tolerance.
		expect(label("same merchant")).toContain('text-anchor="middle"');
		expect(label("±10%")).toContain('text-anchor="middle"');
		expect(words(html)).toContain("same merchant ±10% within 5 days");
		expect(html).not.toContain("same merchant ·");
	});
});

describe("BudgetDiagram", () => {
	const demo = {
		totalBudgetCents: 165000,
		totalSpentCents: 138594,
		safeToSpendCents: 26406,
	};

	it("shows budget − spent = safe to spend, with the same amounts as the example", async () => {
		const html = await render(BudgetDiagram(demo));
		expectLabelled(html);
		expect(words(html)).toContain(
			"Budget $1,650.00 − Spent $1,385.94 = Safe to spend $264.06",
		);
		expect(desc(html)).toBe(
			"The $1,650.00 budget minus $1,385.94 spent leaves $264.06 safe to spend.",
		);
		expect(html).toContain("stroke-ok");
		expect(html).not.toContain("Bills");
	});

	it("adds bills set aside once there are any", async () => {
		const html = await render(
			BudgetDiagram({ ...demo, safeToSpendCents: 12206 }),
		);
		expect(words(html)).toContain(
			"Budget $1,650.00 − Spent $1,385.94 − Bills due $142.00 = Safe to spend $122.06",
		);
		expect(desc(html)).toContain("minus $142.00 for bills due");
	});

	it("marks a negative result in red, still with its words", async () => {
		const html = await render(
			BudgetDiagram({
				...demo,
				safeToSpendCents: -5000,
				totalSpentCents: 170000,
			}),
		);
		expect(words(html)).toContain("Safe to spend -$50.00");
		expect(html).toContain("stroke-over");
		expect(html).not.toContain("stroke-ok");
	});
});

describe("TransactionsDiagram", () => {
	it("shows counted, held, excluded, and uncategorized transactions", async () => {
		const html = await render(
			TransactionsDiagram({
				counted: 32,
				excluded: 3,
				heldForReview: 2,
				needsCategory: 10,
			}),
		);
		expectLabelled(html);
		expect(words(html)).toContain(
			"This month 37 − 3 excluded − 2 held for review Counted 32 Needs a category 10",
		);
		expect(desc(html)).toBe(
			"37 transactions this month: 32 counted, 2 held for review, 3 excluded. 10 of those need a category.",
		);
		expect(desc(html)).not.toContain("spending");
	});

	it("leaves out the excluded step when nothing is excluded", async () => {
		const html = await render(
			TransactionsDiagram({
				counted: 1,
				excluded: 0,
				heldForReview: 0,
				needsCategory: 0,
			}),
		);
		expect(words(html)).toContain("This month 1 Counted 1 Needs a category 0");
		expect(words(html)).not.toContain("excluded");
		expect(desc(html)).toBe(
			"1 transaction this month: 1 counted. None need a category.",
		);
	});
});

describe("ExclusionsDiagram", () => {
	it("shows one bar, counted and excluded, with each kind named", async () => {
		const html = await render(
			ExclusionsDiagram({
				counted: 32,
				heldForReview: 2,
				breakdown: { transfer: 1, reimbursement: 1, byPerson: 1 },
			}),
		);
		expectLabelled(html);
		expect(words(html)).toContain(
			"32 counted 2 held · 3 excluded 2 held for review · 1 transfer · 1 reimbursement · 1 by a person",
		);
		expect(desc(html)).toBe(
			"37 transactions this month: 32 counted, 2 held for review, and 3 excluded (1 transfer, 1 reimbursement and 1 excluded by a person).",
		);
		// One dashed slice per kind of exclusion.
		expect(html.match(/stroke-dasharray/g)).toHaveLength(4);
	});

	it("keeps every slice inside the picture, even when everything is excluded", async () => {
		const html = await render(
			ExclusionsDiagram({
				counted: 0,
				heldForReview: 0,
				breakdown: { transfer: 30, reimbursement: 1, byPerson: 1 },
			}),
		);
		const width = Number(html.match(/viewBox="0 0 (\d+)/)?.[1]);
		for (const rect of html.match(/<rect [^>]*stroke-dasharray[^>]*>/g) ?? []) {
			const x = Number(rect.match(/ x="([\d.]+)"/)?.[1]);
			const w = Number(rect.match(/ width="([\d.]+)"/)?.[1]);
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x + w).toBeLessThanOrEqual(width);
		}
	});

	it("says so when nothing is excluded", async () => {
		const html = await render(
			ExclusionsDiagram({
				counted: 5,
				heldForReview: 0,
				breakdown: { transfer: 0, reimbursement: 0, byPerson: 0 },
			}),
		);
		expect(words(html)).toContain("5 counted Nothing excluded");
		expect(html).not.toContain("stroke-dasharray");
		expect(desc(html)).toBe(
			"5 transactions this month: 5 counted, 0 held for review, and 0 excluded.",
		);
	});

	it("leaves room for the held-credit detail when nothing is excluded", async () => {
		const html = await render(
			ExclusionsDiagram({
				counted: 5,
				heldForReview: 2,
				breakdown: { transfer: 0, reimbursement: 0, byPerson: 0 },
			}),
		);
		expect(html).toContain('viewBox="0 0 360 84"');
		expect(words(html)).toContain("2 held for review");
	});
});

describe("CategoriesDiagram", () => {
	it("places the income note below the final step when the month has income", async () => {
		const html = await render(
			CategoriesDiagram({
				user: 1,
				merchantRule: 2,
				bill: 3,
				jev: 4,
				waiting: 5,
				income: 6,
				threshold: "80%",
			}),
		);
		const lastStep = [
			...html.matchAll(/<rect[^>]*y="([\d.]+)"[^>]*height="([\d.]+)"[^>]*>/g),
		].at(-1);
		const note = html.match(/<text[^>]*y="([\d.]+)"[^>]*>\+ 6 income/);
		const viewBoxHeight = Number(html.match(/viewBox="0 0 \d+ (\d+)"/)?.[1]);
		expect(lastStep).toBeDefined();
		expect(note).toBeDefined();
		const bottom = Number(lastStep?.[1]) + Number(lastStep?.[2]);
		expect(Number(note?.[1])).toBeGreaterThan(bottom);
		expect(viewBoxHeight).toBeGreaterThan(Number(note?.[1]));
	});

	it("shows the five steps in order, with how many each handled", async () => {
		const html = await render(
			CategoriesDiagram({
				user: 1,
				merchantRule: 0,
				bill: 3,
				jev: 19,
				waiting: 10,
				income: 2,
				threshold: "80%",
				ai: "Jev",
			}),
		);
		expectLabelled(html);
		expect(words(html)).toContain(
			"1 A person's choice 1 2 A merchant rule 0 3 A bill 3 4 Jev, if 80% or more sure 19 5 Waits for a person 10 + 2 income, which needs no category",
		);
		expect(desc(html)).toBe(
			"Each transaction's category comes from the first step that applies. This month: a person chose 1, merchant rules 0, bills 3, Jev 19, and 10 wait for a person. 2 are income, which needs no category.",
		);
		// The waiting step is dashed: nothing has decided yet.
		expect(html.match(/stroke-dasharray/g)).toHaveLength(1);
	});

	it("names the AI as Tally outside the demo", async () => {
		const html = await render(
			CategoriesDiagram({
				user: 0,
				merchantRule: 0,
				bill: 0,
				jev: 4,
				waiting: 0,
				income: 0,
				threshold: "80%",
				ai: "Tally",
			}),
		);
		expect(html).not.toMatch(/jev/i);
		expect(words(html)).toContain("4 Tally, if 80% or more sure 4");
		expect(desc(html)).toContain("Tally 4");
	});

	it("leaves out the income line when there's none", async () => {
		const html = await render(
			CategoriesDiagram({
				user: 0,
				merchantRule: 0,
				bill: 0,
				jev: 0,
				waiting: 0,
				income: 0,
				threshold: "80%",
			}),
		);
		expect(words(html)).not.toContain("income");
		expect(desc(html)).not.toContain("income");
	});
});

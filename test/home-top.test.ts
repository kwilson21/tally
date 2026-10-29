import { describe, expect, it } from "vitest";
import { HomeTop } from "../src/views/home-top";

const top = async (overrides: Partial<Parameters<typeof HomeTop>[0]> = {}) =>
	String(
		await HomeTop({
			month: "September",
			safeToSpendCents: 28300,
			status: "Eating Out is $36 over. Everything else is on track.",
			band: {
				href: "/transactions?uncategorized=1",
				text: "12 transactions need a category",
			},
			forecast: "forecast",
			...overrides,
		}),
	);

// Home's top (#92, decision 46 P1): the number first on a phone's first screen.
describe("HomeTop", () => {
	it("labels the number and links Why? to the budget explanation", async () => {
		const html = await top();
		const at = (s: string) => html.indexOf(s);
		expect(at("September")).toBeGreaterThan(-1);
		expect(at("September")).toBeLessThan(at("Safe to spend"));
		expect(at("Safe to spend")).toBeLessThan(at("$283"));
		expect(html).not.toContain("Based on posted spending");
		expect(html).not.toContain("pending purchases");
		expect(html).toContain('href="/how-it-works#budget"');
		expect(html).toContain('aria-label="Why? safe to spend"');
		expect(at("$283")).toBeLessThan(at("Eating Out is $36 over"));
		expect(at("Eating Out is $36 over")).toBeLessThan(at("forecast"));
		expect(at("forecast")).toBeLessThan(at("12 transactions need a category"));
		// How this works is at the foot of Home, not in its top (P124 A, decision 111).
		expect(html).not.toContain("How this works");
	});

	it("keeps the month a heading, but smaller than the number, so the number is the one thing", async () => {
		const html = await top();
		expect(html).toMatch(
			/<h1 class="font-serif text-2xl[^"]*">September<\/h1>/,
		);
		expect(html).toMatch(
			/class="font-serif text-6xl[^"]*"><span class="whitespace-nowrap">\$283<\/span>/,
		);
	});

	// Issue #500: the minus sign and the number are one unbreakable run, so a phone never sets the
	// minus alone on the line above the amount.
	it("keeps a negative amount's minus sign and number in one unbreakable run", async () => {
		const html = await top({ safeToSpendCents: -999900 });
		expect(html).toContain('<span class="whitespace-nowrap">−$9,999</span>');
	});

	// Issue #500 (P127 A, decision 116): below 390px the notebook drawing is left out, so the amount has the whole row.
	it("leaves the notebook drawing out below 390px so the amount has the whole row (#500, P127 A)", async () => {
		const html = await top();
		expect(html).toMatch(
			/<div class="[^"]*\bhidden\b[^"]*\bmin-\[390px\]:block\b[^"]*"><svg/,
		);
	});

	// Issue #500 (P127 A, decision 116): an 8-character amount (−$19,999) would spill beside the drawing at 390px,
	// so its wrapper waits for 640px instead.
	it("leaves the notebook drawing out below 640px for an 8-character amount (#500, P127 A)", async () => {
		const html = await top({ safeToSpendCents: -1999900 });
		expect(html).toContain('<span class="whitespace-nowrap">−$19,999</span>');
		expect(html).toMatch(/<div class="hidden shrink-0 sm:block"><svg/);
		expect(html).not.toMatch(/min-\[390px\]:block/);
	});

	it("keeps the label and Why? link when safe to spend is negative", async () => {
		const html = await top({ safeToSpendCents: -12000 });
		expect(html).toContain("Safe to spend");
		expect(html).toContain("−$120");
		expect(html).toContain('href="/how-it-works#budget"');
		expect(html).toContain(
			"Over budget this month. Spending more takes it further over.",
		);
		expect(html).not.toContain("Everything is on track");
	});

	// Issue #519: with no budgeted category, a negative number is not over budget. It keeps its ink
	// colour and the status sentence (Home passes "No budgets set yet.") shows instead.
	it("is never over budget when no category has a budget", async () => {
		const html = await top({
			safeToSpendCents: -4500,
			hasBudgets: false,
			status: "No budgets set yet.",
		});
		expect(html).toContain("−$45");
		expect(html).toContain("No budgets set yet.");
		expect(html).not.toContain(
			"Over budget this month. Spending more takes it further over.",
		);
		expect(html).not.toMatch(/text-6xl[^"]*text-over/);
	});

	it("shows today's over-budget state when hasBudgets is true", async () => {
		const html = await top({ safeToSpendCents: -4500, hasBudgets: true });
		expect(html).toMatch(/text-6xl[^"]*text-over/);
		expect(html).toContain(
			"Over budget this month. Spending more takes it further over.",
		);
	});

	it("shows a bank alert before the forecast", async () => {
		const html = await top({ bankLine: ["Chase stopped updating Oct 2"] });
		expect(html.indexOf("Chase stopped updating Oct 2")).toBeLessThan(
			html.indexOf("forecast"),
		);
		expect(html).toContain('href="/accounts"');
		expect(html).toContain("Fix");
	});

	it("omits the forecast, daily amount, and bank Fix line for a finished month", async () => {
		const html = await top({
			currentMonth: false,
			bankDate: "as of Oct 2",
			bankLine: ["Chase stopped updating Oct 2"],
		});
		expect(html).not.toContain("forecast");
		expect(html).not.toContain("as of Oct 2");
		expect(html).not.toContain("Fix");
		expect(html).not.toContain("a day");
	});

	it("shows no Band when nothing needs a category", async () => {
		const html = await top({ band: undefined });
		expect(html).not.toContain("bg-band");
		expect(html).not.toContain("How this works");
	});
});

// Apple Card's line comes after a bank's line, in its own box, and Home's Band sits under either (decision 138).
describe("HomeTop with Apple Card's line", () => {
	const APPLE = "Apple Card hasn't been updated since Oct 12";

	it("puts a bank's line before Apple Card's, and both before the forecast", async () => {
		const html = await top({
			bankLine: ["Chase stopped updating Oct 2"],
			appleLine: APPLE,
		});
		expect(html.indexOf("Chase stopped updating Oct 2")).toBeLessThan(
			html.indexOf("Apple Card hasn&#39;t been updated since Oct 12"),
		);
		expect(html.indexOf("Apple Card hasn&#39;t")).toBeLessThan(
			html.indexOf("forecast"),
		);
		expect(html).toContain('href="/accounts/apple-card"');
		expect(html).toContain('data-icon="card"');
		expect(html.match(/data-icon="bank"/g) ?? []).toHaveLength(1);
	});

	it("draws Apple Card's line alone, with its Upload link", async () => {
		const html = await top({ appleLine: APPLE });
		expect(html).toContain("Apple Card hasn&#39;t been updated since Oct 12");
		expect(html).toContain(">Upload<");
		expect(html).not.toContain("Fix");
	});

	it("draws neither line for a finished month", async () => {
		const html = await top({
			currentMonth: false,
			bankLine: ["Chase stopped updating Oct 2"],
			appleLine: APPLE,
		});
		expect(html).not.toContain("Apple Card");
		expect(html).not.toContain("Chase stopped updating");
		expect(html).not.toContain('href="/accounts/apple-card"');
	});

	it("sits the Band at mt-2 under Apple Card's line, as under a bank's", async () => {
		const html = await top({ bankLine: undefined, appleLine: APPLE });
		expect(html).toContain(
			'<div class="mt-2"><a href="/transactions?uncategorized=1"',
		);
		expect(html).not.toContain(
			'<div class="mt-4"><a href="/transactions?uncategorized=1"',
		);
	});
});

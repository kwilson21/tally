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
		expect(at("Eating Out is $36 over")).toBeLessThan(at("How this works"));
		expect(at("Eating Out is $36 over")).toBeLessThan(at("forecast"));
		expect(at("How this works")).toBeLessThan(
			at("12 transactions need a category"),
		);
	});

	it("keeps the month a heading, but smaller than the number, so the number is the one thing", async () => {
		const html = await top();
		expect(html).toMatch(
			/<h1 class="font-serif text-2xl[^"]*">September<\/h1>/,
		);
		expect(html).toMatch(/class="font-serif text-6xl[^"]*">\$283</);
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

	it("shows a bank alert before the forecast", async () => {
		const html = await top({ bankLine: "Chase stopped updating Oct 2" });
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
			bankLine: "Chase stopped updating Oct 2",
		});
		expect(html).not.toContain("forecast");
		expect(html).not.toContain("as of Oct 2");
		expect(html).not.toContain("Fix");
		expect(html).not.toContain("a day");
	});

	it("shows no Band when nothing needs a category", async () => {
		const html = await top({ band: undefined });
		expect(html).not.toContain("bg-band");
		expect(html).toContain("How this works");
	});
});

import { describe, expect, it } from "vitest";
import { HomeTop } from "../src/views/home-top";

const top = async (overrides: Partial<Parameters<typeof HomeTop>[0]> = {}) =>
	String(
		await HomeTop({
			month: "September",
			safeToSpendCents: 28300,
			status: "Eating Out is $36 over. Everything else is on track.",
			demo: true,
			band: {
				href: "/transactions?uncategorized=1",
				text: "12 transactions need a category",
			},
			...overrides,
		}),
	);

// Home's top (#92, decision 46 P1): the number first on a phone's first screen.
describe("HomeTop", () => {
	it("puts the month, the number, the sentence, How this works and the Band in that order", async () => {
		const html = await top();
		const at = (s: string) => html.indexOf(s);
		expect(at("September")).toBeGreaterThan(-1);
		expect(at("September")).toBeLessThan(at("Safe to spend"));
		expect(at("Safe to spend")).toBeLessThan(at("$283"));
		expect(at("$283")).toBeLessThan(at("Eating Out is $36 over"));
		expect(at("Eating Out is $36 over")).toBeLessThan(at("How this works"));
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

	it("shows no Band when nothing needs a category, and no How this works outside the demo", async () => {
		const html = await top({ band: undefined, demo: false });
		expect(html).not.toContain("bg-band");
		expect(html).not.toContain("How this works");
	});
});

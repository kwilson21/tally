import { describe, expect, it } from "vitest";
import type { SetupView } from "../src/first-tally/setup";
import { HomeSetup } from "../src/views/home-setup";

// Home's setup top (P125 E): each state's words, from the view it's given.
const base: SetupView = {
	phase: "before",
	drawn: 0,
	steps: [],
	bankName: null,
	fitsOneNight: true,
	sorted: 0,
	total: 0,
};
const top = async (view: Partial<SetupView>, linkBank?: string) =>
	String(await HomeSetup({ view: { ...base, ...view }, linkBank })).replaceAll(
		"&#39;",
		"'",
	);

describe("HomeSetup", () => {
	it("before a bank: the headline, the one button and its line", async () => {
		const html = await top({}, "<button>Link a bank</button>");
		expect(html).toContain("Five strokes, and you're set up.");
		expect(html).toContain("Link a bank");
		expect(html).toContain(
			"Tally can only read your bank. It can't move money.",
		);
		expect(html).not.toContain("Nothing for you to do");
	});

	it("before a bank with Plaid off: no button and no line about it", async () => {
		const html = await top({});
		expect(html).toContain("Five strokes, and you're set up.");
		expect(html).not.toContain("It can't move money.");
	});

	it("reading, when the import fits one night: the evening line names the bank", async () => {
		const html = await top({
			phase: "reading",
			drawn: 1,
			bankName: "Chase",
			fitsOneNight: true,
			total: 40,
			sorted: 0,
		});
		expect(html).toContain("Your first week");
		expect(html).toContain(
			"One. Tally's reading your last 90 days from Chase. Your questions will usually be ready by the morning.",
		);
		expect(html).toContain("Nothing for you to do until then.");
	});

	it("reading, when the import takes more nights: the catch-up line counts the sorted", async () => {
		const html = await top({
			phase: "reading",
			drawn: 1,
			bankName: "Chase",
			fitsOneNight: false,
			sorted: 900,
			total: 1500,
		});
		expect(html).toContain(
			"Tally's sorted 900 of 1,500. Your questions will be ready when it's done, usually in a night or two.",
		);
		expect(html).not.toContain("One. Tally's reading");
		expect(html).toContain("Nothing for you to do until then.");
	});

	it("ready: the sorted count, the three things to check, and the band to the question page", async () => {
		const html = await top({
			phase: "ready",
			drawn: 1,
			bankName: "Chase",
			total: 362,
			sorted: 362,
		});
		expect(html).toContain(
			"Tally sorted 362 overnight. Three things to check, and Safe to spend is written in at the end.",
		);
		expect(html).toContain('href="/first-page"');
		expect(html).toContain("Three things to check");
		expect(html).toContain(
			"Your pay, your bills and your budgets. About three minutes.",
		);
		expect(html).not.toContain("Link a bank");
	});

	it("marks the status for focus after a Plaid redraw", async () => {
		const html = await top({
			phase: "reading",
			drawn: 1,
			bankName: "Chase",
			total: 1,
		});
		expect(html).toContain('id="setup-status"');
		expect(html).toContain("data-link-bank-focus");
	});
});

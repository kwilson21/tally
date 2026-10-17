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
	bankCount: 1,
	historyIn: true,
	sorted: 0,
	total: 0,
	fifth: null,
	answeredWaiting: null,
};
const top = async (
	view: Partial<SetupView>,
	linkBank?: string,
	bankLine?: string[],
) =>
	String(
		await HomeSetup({ view: { ...base, ...view }, linkBank, bankLine }),
	).replaceAll("&#39;", "'");

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

	it("reading, with two connected banks: the evening line names neither bank", async () => {
		const html = await top({
			phase: "reading",
			drawn: 1,
			bankName: "Chase",
			bankCount: 2,
			fitsOneNight: true,
			total: 40,
			sorted: 0,
		});
		expect(html).toContain(
			"One. Tally's reading your last 90 days. Your questions will usually be ready by the morning.",
		);
		expect(html).not.toContain("from Chase");
	});

	it("reading, with the history still coming in: no time is promised, and the bank is named with one connected", async () => {
		const html = await top({
			phase: "reading",
			drawn: 1,
			bankName: "Chase",
			bankCount: 1,
			historyIn: false,
			fitsOneNight: true,
			total: 40,
			sorted: 0,
		});
		expect(html).toContain(
			"One. Tally's reading your last 90 days from Chase. Your questions will be ready once it has read them all and sorted them.",
		);
		expect(html).not.toContain("by the morning");
		expect(html).not.toContain("Tally's sorted");
		expect(html).toContain("Nothing for you to do until then.");
	});

	it("reading, with the history still coming in and the import bigger than one night: still no time and no count", async () => {
		const html = await top({
			phase: "reading",
			drawn: 1,
			bankName: "Chase",
			bankCount: 1,
			historyIn: false,
			fitsOneNight: false,
			sorted: 900,
			total: 1500,
		});
		expect(html).toContain(
			"One. Tally's reading your last 90 days from Chase. Your questions will be ready once it has read them all and sorted them.",
		);
		expect(html).not.toContain("by the morning");
		expect(html).not.toContain("Tally's sorted");
		expect(html).not.toContain("900");
	});

	it("reading, with two banks and the history still coming in: the sentence names neither bank", async () => {
		const html = await top({
			phase: "reading",
			drawn: 1,
			bankName: "Chase",
			bankCount: 2,
			historyIn: false,
			total: 40,
		});
		expect(html).toContain(
			"One. Tally's reading your last 90 days. Your questions will be ready once it has read them all and sorted them.",
		);
		expect(html).not.toContain("from Chase");
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

	it("answered: the ruled total under the status, with no Band and no question page", async () => {
		const html = await top({
			phase: "answered",
			drawn: 4,
			bankName: "Chase",
			total: 362,
			sorted: 362,
		});
		expect(html).toContain(
			"Four. Tomorrow Tally keeps count on its own, and that's the fifth.",
		);
		expect(html).not.toContain("Three things to check");
		expect(html).not.toContain('href="/first-page"');
		expect(html).not.toContain("Nothing for you to do");
	});

	it("shows a bank that stopped updating under the status, as Home's top does", async () => {
		const html = await top(
			{ phase: "reading", drawn: 1, bankName: "Chase", total: 40 },
			undefined,
			["Chase stopped updating Oct 9"],
		);
		expect(html).toContain("Chase stopped updating Oct 9");
		expect(html).toContain('href="/accounts"');
		expect(html).not.toContain("Nothing for you to do");
	});

	it("shows a bank that needs signing in in place of 'Nothing for you to do', above its Fix", async () => {
		const html = await top(
			{ phase: "reading", drawn: 1, bankName: "Chase", total: 40 },
			undefined,
			["Chase needs signing in"],
		);
		expect(html).toContain("Chase needs signing in");
		expect(html).toContain('href="/accounts"');
		expect(html).not.toContain("Nothing for you to do");
	});

	it("reading: the notebook sits at the right under a heading only screen readers hear (the picked drawing has no visible title)", async () => {
		const html = await top({
			phase: "reading",
			drawn: 1,
			bankName: "Chase",
			total: 40,
		});
		expect(html).toMatch(/<h1[^>]*class="sr-only"[^>]*>Your first week<\/h1>/);
		expect(html).toContain("justify-end");
		expect(html).not.toContain("Five strokes");
	});

	it("before a bank: the headline stays visible, with the notebook at its right", async () => {
		const html = await top({}, "<button>Link a bank</button>");
		expect(html).toMatch(
			/<h1[^>]*class="min-w-0 font-serif text-4xl[^"]*"[^>]*>Five strokes, and you're set up\.<\/h1>/,
		);
		expect(html).not.toContain("Your first week");
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

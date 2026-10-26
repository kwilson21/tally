/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import type { SetupView } from "../src/first-tally/setup";
import type { YourBank } from "../src/first-tally/your-banks";
import {
	EMAIL_LINE,
	MORE_BANKS_LINE,
	READING_HEADING,
	readingNextLine,
	readingStatus,
	readingStep,
	SetupReading,
	sortedShare,
} from "../src/views/setup-reading";
import { READING_STEP } from "../src/views/step-bar";

// The reading screen (P142 A, decisions 146, 148 and 150): the words for each step, and the screen that draws them.
const base: SetupView = {
	phase: "reading",
	bankName: "Chase",
	bankCount: 1,
	historyIn: false,
	sorting: false,
	slow: false,
	refreshes: true,
	sorted: 0,
	total: 86,
	emailed: false,
	waitsForRun: false,
	runTime: "5 AM",
};
const view = (over: Partial<SetupView> = {}): SetupView => ({
	...base,
	...over,
});

const html = (node: unknown) => String(node).replaceAll("&#39;", "'");

const CHASE_IN: YourBank = {
	id: 3,
	name: "Chase",
	status: "ok",
	lastSyncedAt: "2026-10-14 08:00:00",
	historyCompleteAt: "2026-10-13 09:00:00",
	fresh: false,
	count: 412,
};
const AMEX_PAUSED: YourBank = {
	id: 5,
	name: "American Express",
	status: "needs_attention",
	lastSyncedAt: "2026-10-14 08:00:00",
	historyCompleteAt: null,
	fresh: true,
	count: 86,
};
const TODAY = "2026-10-14";

describe("readingStep", () => {
	it("is the daily run's wait before a slow or sorting step", () => {
		expect(
			readingStep(view({ waitsForRun: true, slow: true, sorting: true })),
		).toBe("run");
	});

	it("is slow before sorting", () => {
		expect(readingStep(view({ slow: true, sorting: true }))).toBe("slow");
	});

	it("is sorting once every history is in and something waits", () => {
		expect(readingStep(view({ sorting: true }))).toBe("sorting");
	});

	it("is reading otherwise", () => {
		expect(readingStep(view({}))).toBe("reading");
	});
});

describe("readingStatus", () => {
	it("says when the daily run sorts it, at the run's hour in the household's time zone", () => {
		expect(
			readingStatus(
				view({ waitsForRun: true, sorting: true, runTime: "5 AM", total: 412 }),
			),
		).toBe(
			"Tally sorts your last 90 days in its daily run, at about 5 AM, as set in Settings.",
		);
		expect(readingStatus(view({ waitsForRun: true, runTime: "10 AM" }))).toBe(
			"Tally sorts your last 90 days in its daily run, at about 10 AM, as set in Settings.",
		);
	});

	it("counts the sort in words, with comma-grouped numbers", () => {
		expect(
			readingStatus(view({ sorting: true, sorted: 318, total: 412 })),
		).toBe("Sorting your last 90 days: 318 of 412 done.");
	});

	it("says taking longer than usual, with the count, once the sort is slow", () => {
		expect(
			readingStatus(
				view({ sorting: true, slow: true, sorted: 900, total: 1500 }),
			),
		).toBe("Sorting is taking longer than usual: 900 of 1,500.");
	});

	it("names the one connected bank while its history comes in", () => {
		expect(readingStatus(view({ bankName: "Chase", bankCount: 1 }))).toBe(
			"Tally's reading your last 90 days from Chase.",
		);
	});

	it("says from 2 banks with more than one, and no bank name with none", () => {
		expect(readingStatus(view({ bankName: "Chase", bankCount: 2 }))).toBe(
			"Tally's reading your last 90 days from 2 banks.",
		);
		expect(readingStatus(view({ bankName: null, bankCount: 0 }))).toBe(
			"Tally's reading your last 90 days.",
		);
	});

	it("falls back to your bank when one bank has no name", () => {
		expect(readingStatus(view({ bankName: null, bankCount: 1 }))).toBe(
			"Tally's reading your last 90 days from your bank.",
		);
	});
});

describe("readingNextLine", () => {
	it("says the questions open once the daily run has sorted them", () => {
		expect(readingNextLine(view({ waitsForRun: true }), false)).toBe(
			"Your three questions open once they're sorted.",
		);
	});

	it("says Tally keeps trying, and nothing is for you to do unless a bank line says otherwise", () => {
		expect(readingNextLine(view({ sorting: true, slow: true }), false)).toBe(
			"Tally keeps trying on its own. Nothing for you to do.",
		);
		expect(readingNextLine(view({ sorting: true, slow: true }), true)).toBe(
			"Tally keeps trying on its own.",
		);
	});

	it("says the questions open the moment the sort is done, and that the page updates while it refreshes", () => {
		expect(
			readingNextLine(view({ sorting: true, refreshes: true }), false),
		).toBe(
			"Your three questions open the moment it's done, usually in a few minutes. This page updates as it goes.",
		);
		expect(
			readingNextLine(view({ sorting: true, refreshes: false }), false),
		).toBe(
			"Your three questions open the moment it's done, usually in a few minutes.",
		);
	});

	it("says what comes next while the history comes in, and that the page updates only while it refreshes", () => {
		expect(readingNextLine(view({ refreshes: true }), false)).toBe(
			"Next it sorts them, then you answer three quick questions and your budget is ready. This page updates as it goes.",
		);
		expect(readingNextLine(view({ refreshes: false }), false)).toBe(
			"Next it sorts them, then you answer three quick questions and your budget is ready.",
		);
	});

	it("never mentions email: the email line below says it", () => {
		for (const over of [
			{ waitsForRun: true },
			{ sorting: true, slow: true },
			{ sorting: true },
			{},
		]) {
			expect(readingNextLine(view(over), false)).not.toMatch(/email|Stay here/);
		}
	});
});

describe("sortedShare", () => {
	it("fills the bar to the share sorted, to one decimal", () => {
		expect(sortedShare(318, 412)).toBe(77.2);
	});

	it("is empty with nothing to sort, and full at most", () => {
		expect(sortedShare(0, 0)).toBe(0);
		expect(sortedShare(5, 4)).toBe(100);
	});
});

describe("the reading screen's fixed words", () => {
	it("says the heading, the email line and the more-banks line as the picked drawing does", () => {
		expect(READING_HEADING).toBe("Reading your bank");
		expect(EMAIL_LINE).toBe(
			"You can close this page. Tally emails you the moment your questions are ready.",
		);
		expect(MORE_BANKS_LINE).toBe(
			"Link every bank and card you use, so your questions cover them all.",
		);
	});
});

describe("SetupReading", () => {
	const reading = (props: Partial<Parameters<typeof SetupReading>[0]> = {}) =>
		html(
			SetupReading({
				view: view(),
				polls: false,
				...props,
			}),
		);

	it("draws the step bar, the heading, and the status as a plain paragraph with its focus hooks", () => {
		const markup = reading();
		expect(markup).toContain(READING_STEP);
		expect(markup).toContain(
			'<h1 id="setup-title" class="mt-6 font-serif text-4xl font-semibold tracking-tight">Reading your bank</h1>',
		);
		expect(markup).toMatch(
			/<p id="setup-status" class="mt-3 text-lg" tabindex="-1" data-link-bank-focus="true">Tally's reading your last 90 days from Chase\.<\/p>/,
		);
		expect(markup).not.toMatch(/id="setup-status"[^>]*autofocus/);
	});

	it("takes focus on the status only when focusStatus is given", () => {
		const markup = reading({ focusStatus: true });
		expect(markup).toMatch(/id="setup-status"[^>]*autofocus/);
	});

	it("draws the bar while sorting and while taking longer, and none while reading or waiting for the run; the div is there in all four", () => {
		const sorting = reading({
			view: view({ sorting: true, sorted: 318, total: 412 }),
		});
		expect(sorting).toContain('<svg class="mt-3 block h-2 w-full"');
		expect(sorting).toContain('width="77.2%"');
		expect(sorting).toContain('class="fill-ink"');

		const slow = reading({
			view: view({ sorting: true, slow: true, sorted: 900, total: 1500 }),
		});
		expect(slow).toContain('<svg class="mt-3 block h-2 w-full"');
		expect(slow).toContain('width="60%"');

		for (const state of [
			view({}),
			view({ waitsForRun: true, sorting: true }),
		]) {
			const markup = reading({ view: state });
			expect(markup).toContain('<div id="setup-progress">');
			expect(markup).not.toContain("<svg");
		}
	});

	it("says at about the run's hour, never taking longer, and draws no bar, while waiting for the daily run", () => {
		const markup = reading({
			view: view({
				waitsForRun: true,
				sorting: true,
				runTime: "10 AM",
				sorted: 0,
				total: 412,
			}),
		});
		expect(markup).toContain("at about 10 AM");
		expect(markup).toContain("Your three questions open once they're sorted.");
		expect(markup).not.toContain("taking longer");
		expect(markup).not.toContain("<svg");
	});

	it("draws the email line only until the ready email has reached someone", () => {
		expect(reading({ view: view({ emailed: false }) })).toContain(
			"You can close this page.",
		);
		expect(reading({ view: view({ emailed: true }) })).not.toContain(
			"You can close this page.",
		);
	});

	it("always draws the email region, so a refresh can swap the line in or out of it", () => {
		const notEmailed = reading({ view: view({ emailed: false }) });
		expect(notEmailed).toContain('<div id="setup-email">');
		expect(notEmailed).toMatch(
			/<div id="setup-email"><p class="mt-6 rounded-control bg-band p-4">You can close this page\. Tally emails you the moment your questions are ready\.<\/p><\/div>/,
		);

		const emailed = reading({ view: view({ emailed: true }) });
		expect(emailed).toContain('<div id="setup-email"></div>');
		expect(emailed).not.toContain(EMAIL_LINE);
	});

	it("draws the notify control only when notify is given", () => {
		expect(reading()).not.toContain("data-notify");
		expect(
			reading({
				notify: {
					vapidKey: "catalog-fake-vapid-key",
					shown: "off",
					idSuffix: "x",
				},
			}),
		).toContain("data-notify");
	});

	it("draws the bank line before Your banks, and Your banks before the email line", () => {
		const markup = reading({
			view: view({ bankCount: 2, emailed: false }),
			bankLine: ["American Express needs signing in"],
			yourBanks: { banks: [CHASE_IN, AMEX_PAUSED], today: TODAY, polls: false },
		});
		const bankLine = markup.indexOf("American Express needs signing in");
		const yourBanks = markup.indexOf("Your banks");
		const email = markup.indexOf("You can close this page.");
		expect(bankLine).toBeGreaterThan(0);
		expect(bankLine).toBeLessThan(yourBanks);
		expect(yourBanks).toBeLessThan(email);
		expect(markup).toContain("Paused · 86 so far");
	});

	it("draws the foot with the given Link another bank, then the more-banks line", () => {
		const markup = reading({
			linkBank: <button type="button">Link another bank</button>,
		});
		const button = markup.indexOf(
			'<button type="button">Link another bank</button>',
		);
		expect(button).toBeGreaterThan(0);
		expect(button).toBeLessThan(markup.indexOf(MORE_BANKS_LINE));
		expect(markup.indexOf(MORE_BANKS_LINE)).toBeGreaterThan(
			markup.indexOf("Your three questions"),
		);
	});

	it("checks in with the step it shows while polls is on, and draws no check-in with polls off", () => {
		const waiting = reading({
			polls: true,
			view: view({ waitsForRun: true, sorting: true }),
		});
		expect(waiting).toContain('hx-post="/home/seen"');
		expect(waiting).toContain('hx-vals="{&quot;step&quot;:&quot;run&quot;}"');

		const sorting = reading({
			polls: true,
			view: view({ sorting: true, sorted: 318, total: 412 }),
		});
		expect(sorting).toContain(
			'hx-vals="{&quot;step&quot;:&quot;sorting&quot;}"',
		);

		expect(reading({ polls: false })).not.toContain('hx-post="/home/seen"');
	});
});

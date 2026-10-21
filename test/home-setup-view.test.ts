import { describe, expect, it } from "vitest";
import type { SetupView } from "../src/first-tally/setup";
import type { YourBank } from "../src/first-tally/your-banks";
import { HomeSetup } from "../src/views/home-setup";

// Home's setup top (P125 E): each state's words, from the view it's given.
const base: SetupView = {
	phase: "before",
	drawn: 0,
	steps: [],
	bankName: null,
	bankCount: 1,
	historyIn: true,
	sorting: false,
	slow: false,
	refreshes: false,
	sorted: 0,
	total: 0,
	fifth: null,
	answeredWaiting: null,
	emailed: false,
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

	it("reading, while every history is in and something waits: the status counts the sorted, and the line says when the questions open (decision 146)", async () => {
		const html = await top({
			phase: "reading",
			drawn: 1,
			bankName: "Chase",
			bankCount: 1,
			sorting: true,
			refreshes: true,
			sorted: 900,
			total: 1500,
		});
		expect(html).toContain("Sorting your last 90 days: 900 of 1,500 done.");
		expect(html).toContain(
			"Your three questions open the moment it's done, usually in a few minutes. Stay here, or Tally will email you.",
		);
		expect(html).not.toContain("One. ");
		expect(html).not.toContain("Nothing for you to do");
	});

	it("sorting, with the page not refreshing or the email sent: the line says the questions open when it's done, and no more", async () => {
		const html = await top({
			phase: "reading",
			drawn: 1,
			bankName: "Chase",
			sorting: true,
			refreshes: false,
			emailed: true,
			sorted: 900,
			total: 1500,
		});
		expect(html).toContain(
			"Your three questions open the moment it's done, usually in a few minutes.</p>",
		);
		expect(html).not.toContain("Stay here");
	});

	it("taking longer: the status says so with the count, and the line says Tally keeps trying, with Nothing for you to do", async () => {
		const html = await top({
			phase: "reading",
			drawn: 1,
			bankName: "Chase",
			sorting: true,
			slow: true,
			refreshes: false,
			emailed: false,
			sorted: 900,
			total: 1500,
		});
		expect(html).toContain(
			"Sorting is taking longer than usual: 900 of 1,500.",
		);
		expect(html).toContain(
			"Tally keeps trying on its own and will email you the moment your questions are ready. Nothing for you to do.",
		);
		expect(html).not.toContain("Stay here");
	});

	it("taking longer, with a bank line and the email sent: no Nothing for you to do, and a full stop", async () => {
		const html = await top(
			{
				phase: "reading",
				drawn: 1,
				bankName: "Chase",
				sorting: true,
				slow: true,
				emailed: true,
				sorted: 900,
				total: 1500,
			},
			undefined,
			["Chase stopped updating Oct 9"],
		);
		expect(html).toContain("Tally keeps trying on its own.</p>");
		expect(html).not.toContain("Nothing for you to do");
	});

	it("reading, with the history still coming in: names the bank, and the line says it sorts next, that the page updates, and that email comes", async () => {
		const html = await top({
			phase: "reading",
			drawn: 1,
			bankName: "Chase",
			bankCount: 1,
			historyIn: false,
			refreshes: true,
			emailed: false,
			total: 40,
		});
		expect(html).toContain("Tally's reading your last 90 days from Chase.");
		expect(html).not.toContain("One. ");
		expect(html).toContain(
			"Next it sorts them, then you answer three quick questions and your budget is ready. This page updates as it goes, and Tally will email you the moment they're ready.",
		);
		expect(html).not.toContain("by the morning");
		expect(html).not.toContain("Nothing for you to do");
	});

	it("reading, with two banks and the email sent, not refreshing: the status counts the banks, and the line is the first sentence alone", async () => {
		const html = await top({
			phase: "reading",
			drawn: 1,
			bankName: "Chase",
			bankCount: 2,
			historyIn: false,
			refreshes: false,
			emailed: true,
			total: 40,
		});
		expect(html).toContain("Tally's reading your last 90 days from 2 banks.");
		expect(html).not.toContain("from Chase");
		expect(html).toContain(
			"Next it sorts them, then you answer three quick questions and your budget is ready.</p>",
		);
		expect(html).not.toContain("updates as it goes");
		expect(html).not.toContain("email you");
	});

	it("reading, not refreshing and no email yet: the line keeps the email sentence and drops the page's", async () => {
		const html = await top({
			phase: "reading",
			drawn: 1,
			bankName: "Chase",
			historyIn: false,
			refreshes: false,
			emailed: false,
			total: 40,
		});
		expect(html).toContain(
			"Next it sorts them, then you answer three quick questions and your budget is ready. Tally will email you the moment they're ready.",
		);
		expect(html).not.toContain("updates as it goes");
	});

	it("ready: the status says everything is sorted and the questions are next, and the band sits under the status, above the lines", async () => {
		const html = await top({
			phase: "ready",
			drawn: 1,
			bankName: "Chase",
			total: 362,
			sorted: 362,
		});
		expect(html).toContain(
			"All 362 transactions are sorted. Now answer three quick questions to set up your budget.",
		);
		expect(html).toContain('href="/first-page"');
		expect(html).toContain("Set up your budget");
		expect(html).toContain(
			"Your pay, your bills and your budgets. About three minutes.",
		);
		expect(html.indexOf("Set up your budget")).toBeLessThan(
			html.indexOf("Your first tally"),
		);
		expect(html.indexOf("All 362 transactions")).toBeLessThan(
			html.indexOf("Set up your budget"),
		);
		expect(html).not.toContain("Three things to check");
		expect(html).not.toContain("Tally sorted");
		expect(html).not.toContain("Link a bank");
	});

	it("ready: one transaction says 'Your 1 transaction is sorted', and none says 'Everything is sorted'", async () => {
		const one = await top({
			phase: "ready",
			drawn: 1,
			bankName: "Chase",
			total: 1,
			sorted: 1,
		});
		expect(one).toContain(
			"Your 1 transaction is sorted. Now answer three quick questions to set up your budget.",
		);
		const none = await top({
			phase: "ready",
			drawn: 1,
			bankName: "Chase",
			total: 0,
			sorted: 0,
		});
		expect(none).toContain(
			"Everything is sorted. Now answer three quick questions to set up your budget.",
		);
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
		expect(html).not.toContain("Set up your budget");
		expect(html).not.toContain('href="/first-page"');
		expect(html).not.toContain("Nothing for you to do");
	});

	it("answered, with a bank flagged: the status is the count alone, with no promise beside the bank's Fix (#671)", async () => {
		const html = await top(
			{
				phase: "answered",
				drawn: 4,
				bankName: "Chase",
				total: 362,
				sorted: 362,
			},
			undefined,
			["Chase stopped updating Oct 9"],
		);
		expect(html).toContain(">Four.</p>");
		expect(html).toContain("Chase stopped updating Oct 9");
		expect(html).not.toContain("Tomorrow Tally keeps count");
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

// The fifth day's notebook (P125 E, #586): it sits beside Safe to spend, so it follows the amount's length as Home's
// notebook does (decision 116), and a phone under 390px never sees it over a long amount.
// Your banks and Have more accounts? (P140 A, decision 133): under the status while the import is read, in page order.
describe("HomeSetup while banks are read", () => {
	const TODAY = "2026-10-05";
	const chase: YourBank = {
		id: 3,
		name: "Chase",
		status: "ok",
		lastSyncedAt: "2026-10-05 08:00:00",
		historyCompleteAt: "2026-10-05 08:00:00",
		fresh: false,
		count: 412,
	};
	const amex: YourBank = {
		id: 5,
		name: "American Express",
		status: "ok",
		lastSyncedAt: "2026-10-05 08:00:00",
		historyCompleteAt: null,
		fresh: true,
		count: 86,
	};
	const reading = {
		...base,
		phase: "reading" as const,
		drawn: 1,
		bankCount: 2,
		historyIn: false,
		total: 500,
		steps: [
			{ name: "Link your bank", done: true, note: "2 banks, linked" },
			{ name: "Your pay", done: false, note: "When it's done" },
		],
	};
	const page = async (
		props: { linkBank?: string; banks?: (typeof chase)[] } = {},
	) =>
		String(
			await HomeSetup({
				view: reading,
				linkBank: props.linkBank,
				yourBanks: { banks: props.banks ?? [chase, amex], today: TODAY },
			}),
		).replaceAll("&#39;", "'");

	it("lists each bank's state under the status, then the prompt, then the five lines", async () => {
		const html = await page({ linkBank: "<button>Link a bank</button>" });
		const at = (text: string) => html.indexOf(text);
		expect(html).toContain("Your banks");
		expect(html).toContain("90 days in · 412");
		expect(html).toContain("Reading · 86 so far");
		expect(html).toContain("Have more accounts?");
		expect(html).toContain(
			"Link every bank and card you use now, so your first questions cover them all.",
		);
		expect(at("setup-status")).toBeLessThan(at("Your banks"));
		expect(at("Your banks")).toBeLessThan(at("Have more accounts?"));
		expect(at("Have more accounts?")).toBeLessThan(at("Link a bank"));
		expect(at("Link a bank")).toBeLessThan(at("Your first tally"));
	});

	it("with Plaid off, the list is drawn with no prompt", async () => {
		const html = await page();
		expect(html).toContain("Your banks");
		expect(html).not.toContain("Have more accounts?");
	});

	it("draws the ring only for a bank being read, and a paused bank says Paused with no ring", async () => {
		const html = await page({
			banks: [chase, { ...amex, status: "needs_attention" }],
		});
		expect(html).toContain("Paused · 86 so far");
		expect(html.match(/button-spinner/g)?.length ?? 0).toBe(0);
		const fresh = await page();
		expect(fresh.match(/button-spinner/g)?.length ?? 0).toBe(1);
	});

	it("polls the list only while a bank is being read, and never swaps a 4xx or 5xx in", async () => {
		const reading = await page();
		expect(reading).toContain('hx-trigger="every 5s"');
		expect(reading).toContain('hx-get="/home/banks?in=3&amp;step=reading"');
		expect(reading).toContain('hx-status:4xx="swap:none"');
		expect(reading).toContain('hx-status:5xx="swap:none"');
		expect(reading).toContain("data-quiet");
		// Every bank is in: the list stops polling. (The presence check-in polls too, from its own element, decision 146.)
		const done = await page({ banks: [chase] });
		expect(done).not.toContain('hx-trigger="every 5s"');
		expect(done).not.toContain('hx-get="/home/banks');
	});
});

describe("HomeSetup on the fifth day", () => {
	const fifthTop = async (safeToSpendCents: number) =>
		String(
			await HomeSetup({
				view: {
					...base,
					phase: "answered",
					drawn: 5,
					fifth: { brought: 3, needYou: 0 },
				},
				fifthDay: { safeToSpendCents, needsHref: "/transactions" },
			}),
		);

	it("draws the notebook from 390px for a 7-character amount, as Home does", async () => {
		const html = await fifthTop(1239800);
		expect(html).toContain("$12,398");
		expect(html).toMatch(
			/<div class="hidden shrink-0 min-\[390px\]:block"><svg/,
		);
	});

	it("waits for 640px for an 8-character amount, as Home does", async () => {
		const html = await fifthTop(-1999900);
		expect(html).toContain("−$19,999");
		expect(html).toMatch(/<div class="hidden shrink-0 sm:block"><svg/);
	});
});

describe("HomeSetup's line under the status (decision 146)", () => {
	const reading = {
		phase: "reading" as const,
		drawn: 1,
		bankName: "Chase",
		total: 40,
		refreshes: true,
	};
	const SENTENCE =
		"Next it sorts them, then you answer three quick questions and your budget is ready.";

	it("reading, not yet emailed: the line sits right under the status, and says the page updates and that email comes", async () => {
		const html = await top(reading);
		expect(html).toContain(
			`<p id="setup-next" class="mt-2 text-muted">${SENTENCE} This page updates as it goes, and Tally will email you the moment they're ready.</p>`,
		);
		expect(html.indexOf('id="setup-status"')).toBeLessThan(
			html.indexOf('id="setup-next"'),
		);
	});

	it("reading, with a bank line too: the line still draws, before the bank's line", async () => {
		const html = await top(reading, undefined, [
			"Chase needs you to sign in again.",
		]);
		expect(html).toContain(SENTENCE);
		expect(html).toContain("Chase needs you to sign in again.");
		expect(html.indexOf(SENTENCE)).toBeLessThan(
			html.indexOf("Chase needs you to sign in again."),
		);
	});

	it("reading, once the ready email has reached someone: the sentence alone, no email clause", async () => {
		const html = await top({ ...reading, emailed: true });
		expect(html).toContain(`>${SENTENCE} This page updates as it goes.</p>`);
		expect(html).not.toContain("email you");
	});

	it("reading, not refreshing: no page-update sentence", async () => {
		const html = await top({ ...reading, refreshes: false });
		expect(html).toContain(
			`>${SENTENCE} Tally will email you the moment they're ready.</p>`,
		);
		expect(html).not.toContain("updates as it goes");
	});

	it.each([
		["ready", { phase: "ready" as const, drawn: 3, historyIn: true }],
		["answered", { phase: "answered" as const, drawn: 4 }],
		["before a bank", { phase: "before" as const, drawn: 0, bankName: null }],
	])("%s: no line under the status", async (_name, view) => {
		const html = await top(view);
		expect(html).not.toContain('id="setup-next"');
	});
});

// The presence check-in (decision 146): Home's first-week setup posts to /home/seen every 30 seconds while the reading and
// the ready phases are open, so Tally knows the person is still there. It is hidden and swaps nothing.
describe("HomeSetup's presence check-in", () => {
	const CHECK_IN = 'hx-post="/home/seen"';
	const night = { brought: 12, needYou: 0 };

	it("is drawn while the history is read by a page that refreshes, and while the questions are ready", async () => {
		expect(
			await top({
				phase: "reading",
				drawn: 1,
				bankCount: 1,
				sorted: 0,
				total: 0,
				refreshes: true,
			}),
		).toContain(CHECK_IN);
		expect(
			await top({ phase: "ready", drawn: 5, sorted: 222, total: 222 }),
		).toContain(CHECK_IN);
	});

	it("is not drawn while the page no longer refreshes (slow, or stale), so its person counts as away (decision 146)", async () => {
		// The page cannot show the change itself, so it stops checking in and the ready email reaches the person.
		expect(
			await top({
				phase: "reading",
				drawn: 1,
				bankCount: 1,
				sorting: true,
				slow: true,
				refreshes: false,
				sorted: 192,
				total: 222,
			}),
		).not.toContain(CHECK_IN);
		expect(
			await top({
				phase: "reading",
				drawn: 1,
				bankCount: 1,
				refreshes: false,
			}),
		).not.toContain(CHECK_IN);
	});

	it("draws the check-in with an id, so a poll that stops refreshing can take it out of the page", async () => {
		const html = await top({
			phase: "reading",
			drawn: 1,
			bankCount: 1,
			refreshes: true,
		});
		expect(html).toContain(`<div id="home-seen" hidden`);
	});

	it("is hidden, polls on load and every 30 seconds, and swaps nothing", async () => {
		const html = await top({
			phase: "reading",
			drawn: 1,
			bankCount: 1,
			refreshes: true,
		});
		const tag = html.slice(
			html.indexOf(CHECK_IN) - 80,
			html.indexOf(CHECK_IN) + 200,
		);
		expect(tag).toContain("hidden");
		expect(tag).toContain('hx-trigger="load, every 30s"');
		expect(tag).toContain('hx-swap="none"');
	});

	it("is not drawn once the questions are answered", async () => {
		expect(
			await top({
				phase: "answered",
				drawn: 3,
				answeredWaiting: null,
				fifth: null,
			}),
		).not.toContain(CHECK_IN);
	});

	it("is not drawn on the fifth day", async () => {
		const html = String(
			await HomeSetup({
				view: { ...base, phase: "answered", drawn: 5, fifth: night },
				fifthDay: { safeToSpendCents: 12345 },
			}),
		);
		expect(html).not.toContain(CHECK_IN);
	});
});

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
	fitsOneNight: true,
	bankCount: 1,
	historyIn: true,
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
		expect(html).not.toContain("Nothing for you to do until then.");
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
			"One. Tally's reading your last 90 days from 2 banks. Your questions will usually be ready by the morning.",
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
		expect(html).not.toContain("Nothing for you to do until then.");
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
			"One. Tally's reading your last 90 days from 2 banks. Your questions will be ready once it has read them all and sorted them.",
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
		expect(html).not.toContain("Nothing for you to do until then.");
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
		expect(reading).toContain('hx-get="/home/banks?in=3"');
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

describe("HomeSetup's ready-email line", () => {
	const reading = {
		phase: "reading" as const,
		drawn: 1,
		bankName: "Chase",
		total: 40,
	};

	it("reading, with no ready email reached anyone: the muted line sits right under the status", async () => {
		const html = await top(reading);
		expect(html).toContain("Tally will email you when they're ready.");
		expect(html.indexOf('id="setup-status"')).toBeLessThan(
			html.indexOf("Tally will email you when they're ready."),
		);
		expect(html).toContain(
			'<p class="mt-2 text-muted">Tally will email you when they\'re ready.</p>',
		);
	});

	it("reading, with a bank line too: the line still draws, before the bank's line", async () => {
		const html = await top(reading, undefined, [
			"Chase needs you to sign in again.",
		]);
		expect(html).toContain("Tally will email you when they're ready.");
		expect(html).toContain("Chase needs you to sign in again.");
		expect(
			html.indexOf("Tally will email you when they're ready."),
		).toBeLessThan(html.indexOf("Chase needs you to sign in again."));
	});

	it("reading, once the ready email has reached someone: no line", async () => {
		const html = await top({ ...reading, emailed: true });
		expect(html).not.toContain("Tally will email you when they're ready.");
	});

	it.each([
		["before a bank", { phase: "before" as const, drawn: 0, bankName: null }],
		["ready", { phase: "ready" as const, drawn: 3, historyIn: true }],
		["answered", { phase: "answered" as const, drawn: 4 }],
	])("%s: no line", async (_name, view) => {
		const html = await top(view);
		expect(html).not.toContain("Tally will email you when they're ready.");
	});
});

// The presence check-in (decision 146): Home's first-week setup posts to /home/seen every 30 seconds while the reading and
// the ready phases are open, so Tally knows the person is still there. It is hidden and swaps nothing.
describe("HomeSetup's presence check-in", () => {
	const CHECK_IN = 'hx-post="/home/seen"';
	const night = { brought: 12, needYou: 0 };

	it("is drawn while the history is read and while the questions are ready", async () => {
		expect(
			await top({
				phase: "reading",
				drawn: 1,
				bankCount: 1,
				sorted: 0,
				total: 0,
			}),
		).toContain(CHECK_IN);
		expect(
			await top({ phase: "ready", drawn: 5, sorted: 222, total: 222 }),
		).toContain(CHECK_IN);
	});

	it("is hidden, polls on load and every 30 seconds, and swaps nothing", async () => {
		const html = await top({ phase: "reading", drawn: 1, bankCount: 1 });
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

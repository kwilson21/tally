/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import type { SetupView } from "../src/first-tally/setup";
import type { YourBank } from "../src/first-tally/your-banks";
import { SetupReading } from "../src/views/setup-reading";
import { YourBanks } from "../src/views/your-banks";

// The reading screen's rules, moved from Home's setup top (#772, part 2, decision 148): each state's words and checks, drawn by
// SetupReading (the status, the bar, the next line, the email line, the check-in) and by YourBanks (the list).

const base: SetupView = {
	phase: "reading",
	bankName: "Chase",
	bankCount: 1,
	historyIn: true,
	sorting: false,
	slow: false,
	refreshes: false,
	sorted: 0,
	total: 0,
	emailed: false,
	waitsForRun: false,
	runTime: "5 AM",
};
const screen = async (view: Partial<SetupView>, bankLine?: string[]) =>
	String(
		<SetupReading view={{ ...base, ...view }} bankLine={bankLine} />,
	).replaceAll("&#39;", "'");

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
const list = async (banks: YourBank[], keepPolling = false) =>
	String(
		<YourBanks
			banks={banks}
			today={TODAY}
			keepPolling={keepPolling}
			step="reading"
		/>,
	).replaceAll("&#39;", "'");

describe("the reading screen's status and next line, by step (decision 146)", () => {
	it("while every history is in and something waits, the status counts what is sorted, and the line says when the questions open", async () => {
		const html = await screen({
			sorting: true,
			historyIn: true,
			sorted: 900,
			total: 1500,
			refreshes: true,
		});
		expect(html).toContain("Sorting your last 90 days: 900 of 1,500 done.");
		expect(html).toContain(
			"Your three questions open the moment it's done, usually in a few minutes. This page updates as it goes.",
		);
		expect(html).toContain('<rect width="60%"');
	});

	it("taking longer than usual: the status says so with the count, no time is promised, and the line says Tally keeps trying", async () => {
		const html = await screen({
			sorting: true,
			slow: true,
			sorted: 900,
			total: 1500,
			refreshes: false,
		});
		expect(html).toContain(
			"Sorting is taking longer than usual: 900 of 1,500.",
		);
		expect(html).toContain(
			"Tally keeps trying on its own. Nothing for you to do.",
		);
		expect(html).not.toContain("This page updates as it goes");
	});

	it("taking longer, with a bank line: the line leaves out 'Nothing for you to do', since the bank's Fix is the thing to do", async () => {
		const html = await screen(
			{ sorting: true, slow: true, sorted: 900, total: 1500 },
			["Chase stopped updating."],
		);
		expect(html).toContain("Tally keeps trying on its own.");
		expect(html).not.toContain("Nothing for you to do");
	});

	it("while the history is still coming in, the status names the bank and the line says what it does next and that the page updates", async () => {
		const html = await screen({
			historyIn: false,
			bankName: "Chase",
			refreshes: true,
			total: 40,
			sorted: 0,
		});
		expect(html).toContain("Tally's reading your last 90 days from Chase.");
		expect(html).toContain(
			"Next it sorts them, then you answer three quick questions and your budget is ready. This page updates as it goes.",
		);
		expect(html).not.toContain("Nothing for you to do until then.");
	});

	it("with two banks, the status counts the banks and names neither", async () => {
		const html = await screen({
			bankCount: 2,
			bankName: "Chase",
			historyIn: false,
			refreshes: false,
		});
		expect(html).toContain("Tally's reading your last 90 days from 2 banks.");
		expect(html).not.toContain("from Chase");
	});
});

describe("the reading screen's presence check-in (decision 146)", () => {
	const CHECK_IN = 'hx-post="/home/seen"';

	it("is still drawn while the page no longer refreshes (slow, or stale), so its person is still there", async () => {
		expect(
			await screen({
				sorting: true,
				slow: true,
				refreshes: false,
				sorted: 192,
				total: 222,
			}),
		).toContain(CHECK_IN);
		expect(await screen({ refreshes: false })).toContain(CHECK_IN);
	});

	it("posts the step it shows, so a slow sort's check-in names slow, not sorting", async () => {
		const html = await screen({
			sorting: true,
			slow: true,
			refreshes: false,
			sorted: 1,
			total: 2,
		});
		expect(html).toContain('hx-vals="{&quot;step&quot;:&quot;slow&quot;}"');
	});
});

describe("the check-in element (decision 146)", () => {
	it("is hidden, checks in on load, every 30 seconds and when the tab comes back, and swaps nothing", async () => {
		const html = await screen({ refreshes: true });
		const tag = html.match(/<div id="home-seen"[^>]*>/)?.[0] ?? "";
		expect(tag).toContain("hidden");
		expect(tag).toContain('hx-post="/home/seen"');
		expect(tag).toContain("load, every 30s, visibilitychange from:document");
		expect(tag).toContain('hx-swap="none"');
	});

	it("carries an id, so a refresh can take it out of the page", async () => {
		const html = await screen({ refreshes: false });
		expect(html).toContain('id="home-seen"');
	});
});

describe("YourBanks on the reading screen (decision 146)", () => {
	it("lists each bank's state in link order, with the ring only for a bank being read", async () => {
		const html = await list([chase, amex]);
		expect(html).toContain("90 days in · 412");
		expect(html).toContain("Reading · 86 so far");
		expect(html.match(/button-spinner/g)?.length ?? 0).toBe(1);
		expect(html.indexOf("Chase")).toBeLessThan(
			html.indexOf("American Express"),
		);
	});

	it("a paused bank says Paused, with no ring", async () => {
		const html = await list([chase, { ...amex, status: "needs_attention" }]);
		expect(html).toContain("Paused · 86 so far");
		expect(html.match(/button-spinner/g)?.length ?? 0).toBe(0);
	});

	it("polls the list at /setup/banks only while a bank is being read, and never swaps a 4xx or 5xx in", async () => {
		const reading = await list([chase, amex]);
		expect(reading).toContain('hx-trigger="every 5s"');
		expect(reading).toContain('hx-get="/setup/banks?in=3&amp;step=reading"');
		expect(reading).toContain('hx-status:4xx="swap:none"');
		expect(reading).toContain('hx-status:5xx="swap:none"');
		expect(reading).toContain("data-quiet");
		const done = await list([chase]);
		expect(done).not.toContain('hx-trigger="every 5s"');
		expect(done).not.toContain('hx-get="/home/banks');
	});

	it("keeps polling while Tally sorts within the hour, even with every bank in", async () => {
		const html = await list([chase], true);
		expect(html).toContain('hx-trigger="every 5s"');
	});
});

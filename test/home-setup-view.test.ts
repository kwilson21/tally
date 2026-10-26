import { describe, expect, it } from "vitest";
import type { SetupView } from "../src/first-tally/setup";
import { HomeSetup } from "../src/views/home-setup";

// Home's setup top once the questions are answered (P125 E, decision 114, spec §8.8): the answered status, the bank's line, and the
// fifth-day view. The before, reading and ready states are setup's own screens now (setup-reading-view.test.tsx, setup-welcome.test.tsx,
// setup-route.test.ts), and the answered top draws no presence check-in.
const base: SetupView = {
	phase: "answered",
	drawn: 4,
	steps: [],
	bankName: "Chase",
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
	waitsForRun: false,
	runTime: "5 AM",
};
const top = async (view: Partial<SetupView>, bankLine?: string[]) =>
	String(await HomeSetup({ view: { ...base, ...view }, bankLine })).replaceAll(
		"&#39;",
		"'",
	);

describe("HomeSetup: the answered top", () => {
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
			["Chase stopped updating Oct 9"],
		);
		expect(html).toContain(">Four.</p>");
		expect(html).toContain("Chase stopped updating Oct 9");
		expect(html).not.toContain("Tomorrow Tally keeps count");
	});

	it("shows a bank that stopped updating under the status, as Home's top does", async () => {
		const html = await top(
			{ phase: "answered", drawn: 4, bankName: "Chase", total: 40, sorted: 40 },
			["Chase stopped updating Oct 9"],
		);
		expect(html).toContain("Chase stopped updating Oct 9");
		expect(html).toContain('href="/accounts"');
		expect(html).not.toContain("Nothing for you to do");
	});

	it("shows a bank that needs signing in in place of 'Nothing for you to do', above its Fix", async () => {
		const html = await top(
			{ phase: "answered", drawn: 4, bankName: "Chase", total: 40, sorted: 40 },
			["Chase needs signing in"],
		);
		expect(html).toContain("Chase needs signing in");
		expect(html).toContain('href="/accounts"');
		expect(html).not.toContain("Nothing for you to do");
	});

	it("draws no presence check-in: the answered top is Home's, and nothing on it checks in", async () => {
		expect(
			await top({ phase: "answered", drawn: 3, fifth: null }),
		).not.toContain('hx-post="/home/seen"');
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

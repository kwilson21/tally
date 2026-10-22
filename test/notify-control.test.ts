import { describe, expect, it } from "vitest";
import type { SetupView } from "../src/first-tally/setup";
import type { YourBank } from "../src/first-tally/your-banks";
import { HomeSetup } from "../src/views/home-setup";
import { NotifyControl, type NotifyShown } from "../src/views/notify-control";

// The notify control (decision 148, N1): "Notify me on this device" under Home's first-week setup while the questions are not
// yet open. Four states, each hidden until push.js shows one, so with no JavaScript, or in a browser without Web Push, nothing
// shows. A catalog drawing passes `shown` to un-hide one state. It goes right after the reading phase's status line, as a
// sibling of #setup-next, #setup-status and Your banks, never inside them: those are swapped, and a swap must not touch it.

const VAPID =
	"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const STATES: NotifyShown[] = ["off", "on", "iphone", "blocked"];

const html = (node: unknown) => String(node).replaceAll("&#39;", "'");

const control = async (shown?: NotifyShown) =>
	html(await NotifyControl({ vapidKey: VAPID, shown }));

/** The tag that opens with `data-notify-state="<state>"`, and the text between it and the next tag. */
const stateTag = (markup: string, state: string) => {
	const match = new RegExp(
		`<[a-z]+[^>]*data-notify-state="${state}"[^>]*>`,
	).exec(markup);
	return match?.[0] ?? null;
};

const base: SetupView = {
	phase: "reading",
	drawn: 1,
	steps: [],
	bankName: "Chase",
	bankCount: 1,
	historyIn: false,
	sorting: false,
	slow: false,
	refreshes: true,
	sorted: 0,
	total: 0,
	fifth: null,
	answeredWaiting: null,
	emailed: false,
};

const TODAY = "2026-10-22";
const chase: YourBank = {
	id: 3,
	name: "Chase",
	status: "ok",
	lastSyncedAt: "2026-10-22 08:00:00",
	historyCompleteAt: null,
	fresh: true,
	count: 40,
};

describe("the notify control's four states", () => {
	it("hides every state by default, Off included, so nothing shows without JavaScript", async () => {
		const markup = await control();
		expect(markup).toContain('data-notify="true"');
		for (const state of STATES) {
			const tag = stateTag(markup, state);
			if (state === "off") {
				// The Off state is a wrapper div; it carries the hidden attribute as the other states do.
				expect(markup).toMatch(
					/<div class="mt-4" data-notify-state="off" hidden/,
				);
			} else {
				expect(tag, state).toMatch(/\shidden[\s>=]/);
			}
		}
	});

	it("un-hides exactly the state it is given", async () => {
		for (const shown of STATES) {
			const markup = await control(shown);
			for (const state of STATES) {
				const hidden =
					state === "off"
						? /<div class="mt-4" data-notify-state="off"[^>]*\shidden/.test(
								markup,
							)
						: /\shidden[\s>=]/.test(stateTag(markup, state) ?? "");
				expect(hidden, `${shown} shown, ${state}`).toBe(state !== shown);
			}
		}
	});

	it("carries the subscription's VAPID key on the wrapper, with no margin of its own", async () => {
		const markup = await control();
		expect(markup).toContain(`data-vapid-key="${VAPID}"`);
		expect(markup).toMatch(/<div data-notify="true" data-vapid-key="[^"]+">/);
	});

	it("gives a drawing's help line its own id, and points its button at that id (idSuffix, catalog only)", async () => {
		const markup = html(
			await NotifyControl({ vapidKey: VAPID, shown: "off", idSuffix: "sorting" }),
		);
		expect(markup).toContain('id="notify-help-sorting"');
		expect(markup).toContain('aria-describedby="notify-help-sorting"');
		expect(markup).not.toContain('id="notify-help"');
	});

	it("keeps an empty alert region for a tap that is refused", async () => {
		expect(await control()).toContain('<div data-notify-alert="true"></div>');
	});
});

describe("the notify control's words and button", () => {
	it("draws the Off button: secondary, full width, busy as Turning on…, described by its help line", async () => {
		const markup = await control("off");
		expect(markup).toMatch(
			/<button[^>]*type="button"[^>]*data-notify-on="true"[^>]*aria-describedby="notify-help"[^>]*>/,
		);
		expect(markup).toContain("Notify me on this device");
		expect(markup).toContain("Turning on…");
		expect(markup).toMatch(
			/<p id="notify-help" class="mt-2 text-sm text-muted">One notification when your questions are ready, if you've left Tally\.<\/p>/,
		);
	});

	it("draws the On line with the check icon, focusable so it reads once", async () => {
		const markup = await control("on");
		const tag = stateTag(markup, "on");
		expect(tag).toContain('tabindex="-1"');
		expect(markup).toContain("Notifications are on for this device.");
		expect(markup).toMatch(/<svg[^>]*class="size-5"/);
	});

	it("draws the iPhone hint with its words", async () => {
		const markup = await control("iphone");
		expect(markup).toContain(
			"To get a notification on iPhone, add Tally to your Home Screen first: tap Share, then Add to Home Screen. Then open Tally from there and tap Notify me.",
		);
	});

	it("draws the quiet Blocked line, focusable for the script's alert", async () => {
		const markup = await control("blocked");
		const tag = stateTag(markup, "blocked");
		expect(tag).toContain('tabindex="-1"');
		expect(markup).toContain(
			"Notifications are blocked for Tally in this device's settings.",
		);
	});
});

describe("HomeSetup draws the control", () => {
	const top = async (
		view: Partial<SetupView>,
		notify?: { vapidKey: string; shown?: NotifyShown },
		yourBanks?: { banks: YourBank[]; today: string },
	) => html(await HomeSetup({ view: { ...base, ...view }, notify, yourBanks }));

	it("draws it while reading, after the status line and before Your banks", async () => {
		const markup = await top(
			{},
			{ vapidKey: VAPID },
			{ banks: [chase], today: TODAY },
		);
		const next = markup.indexOf('id="setup-next"');
		const control = markup.indexOf("data-notify=");
		const banks = markup.indexOf('id="your-banks"');
		expect(next).toBeGreaterThan(-1);
		expect(control).toBeGreaterThan(next);
		expect(banks).toBeGreaterThan(control);
	});

	it("draws it right after the setup-next paragraph, as its sibling", async () => {
		const markup = await top({}, { vapidKey: VAPID });
		expect(markup).toMatch(/id="setup-next"[^>]*>[^<]*<\/p><div data-notify/);
	});

	it("draws nothing without notify", async () => {
		expect(await top({})).not.toContain("data-notify");
	});

	it("draws it only in the reading phase", async () => {
		for (const phase of ["before", "ready"] as const) {
			expect(await top({ phase }, { vapidKey: VAPID }), phase).not.toContain(
				"data-notify",
			);
		}
	});

	it("never draws it inside the status, the next line or Your banks", async () => {
		const markup = await top(
			{},
			{ vapidKey: VAPID },
			{ banks: [chase], today: TODAY },
		);
		const control = markup.indexOf("data-notify=");
		const statusClose = markup.indexOf(
			"</p>",
			markup.indexOf('id="setup-status"'),
		);
		const nextClose = markup.indexOf("</p>", markup.indexOf('id="setup-next"'));
		expect(control).toBeGreaterThan(statusClose);
		expect(control).toBeGreaterThan(nextClose);
		const banksOpen = markup.indexOf('id="your-banks"');
		const banksClose = markup.indexOf("</section>", banksOpen);
		expect(control < banksOpen || control > banksClose).toBe(true);
	});
});

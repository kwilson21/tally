import { describe, expect, it, vi } from "vitest";
import { setupHomeSeen } from "../public/js/home-seen.js";

// The presence check-in's script (decision 148): a tab that isn't on screen counts as away. It runs against a fake document,
// as plaid-link-js.test.ts does: one listener for htmx:before:request, a visibilityState the test sets, and requests the test
// sends from elements. htmx 4 dispatches a cancelable htmx:before:request on the element that sends a request, and sends
// nothing when it is prevented (node_modules/htmx.org/dist/htmx.js, #issueRequest).

type RequestEvent = {
	target?: unknown;
	defaultPrevented: boolean;
	preventDefault: () => void;
};
type RequestListener = (event: RequestEvent) => void;

function fakeDocument(visibilityState: string) {
	const listeners = new Map<string, RequestListener[]>();
	const document = {
		visibilityState,
		addEventListener: vi.fn((name: string, listener: RequestListener) => {
			listeners.set(name, [...(listeners.get(name) ?? []), listener]);
		}),
		/** The before-request event htmx 4 dispatches on a request's source, and whether a listener cancelled it. */
		beforeRequest(source: unknown) {
			const event: RequestEvent = {
				target: source,
				defaultPrevented: false,
				preventDefault() {
					event.defaultPrevented = true;
				},
			};
			for (const listener of listeners.get("htmx:before:request") ?? [])
				listener(event);
			return event;
		},
	};
	return document;
}

const checkIn = { id: "home-seen" };

describe("home-seen.js: a tab that isn't on screen counts as away (decision 148)", () => {
	it("cancels the check-in's request while the tab is hidden", () => {
		const document = fakeDocument("hidden");
		setupHomeSeen({ document });
		expect(document.beforeRequest(checkIn).defaultPrevented).toBe(true);
	});

	it("leaves the check-in's request alone while the tab is on screen", () => {
		const document = fakeDocument("visible");
		setupHomeSeen({ document });
		expect(document.beforeRequest(checkIn).defaultPrevented).toBe(false);
	});

	it("never touches another element's request, hidden or not", () => {
		for (const state of ["hidden", "visible"]) {
			const document = fakeDocument(state);
			setupHomeSeen({ document });
			const others = [
				{ id: "your-banks" },
				{ id: "setup-next" },
				{ id: "" },
				{},
				undefined,
			];
			for (const other of others)
				expect(document.beforeRequest(other).defaultPrevented).toBe(false);
		}
	});

	it("registers one listener, for htmx:before:request, and nothing else", () => {
		const document = fakeDocument("hidden");
		setupHomeSeen({ document });
		expect(document.addEventListener).toHaveBeenCalledTimes(1);
		expect(document.addEventListener.mock.calls[0]?.[0]).toBe(
			"htmx:before:request",
		);
	});

	it("follows the tab: hidden, then back on screen, cancels then lets through", () => {
		const document = fakeDocument("hidden");
		setupHomeSeen({ document });
		expect(document.beforeRequest(checkIn).defaultPrevented).toBe(true);
		document.visibilityState = "visible";
		expect(document.beforeRequest(checkIn).defaultPrevented).toBe(false);
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { setupPlaidLink } from "../public/js/plaid-link.js";

const genericFailure = "Couldn't link the bank. Try again.";

type RequestEvent = {
	target?: unknown;
	detail?: { ctx?: unknown };
	defaultPrevented: boolean;
	preventDefault: () => void;
};
type RequestListener = (event: RequestEvent) => void;

/** A cancelable htmx event, as htmx 4 dispatches one on the element it concerns (htmx.js #trigger). */
function requestEvent(target?: unknown, ctx?: unknown): RequestEvent {
	const event: RequestEvent = {
		target,
		detail: { ctx },
		defaultPrevented: false,
		preventDefault() {
			event.defaultPrevented = true;
		},
	};
	return event;
}

/** The listeners on one element, which htmx's request events reach. */
function elementListeners() {
	const listeners = new Map<string, Set<RequestListener>>();
	return {
		listeners,
		addEventListener: (name: string, listener: RequestListener) => {
			const set = listeners.get(name) ?? new Set<RequestListener>();
			set.add(listener);
			listeners.set(name, set);
		},
		removeEventListener: vi.fn((name: string, listener: RequestListener) => {
			listeners.get(name)?.delete(listener);
		}),
		dispatchRequest: (name: string, ctx: unknown) => {
			for (const listener of listeners.get(name) ?? [])
				listener(requestEvent(undefined, ctx));
		},
	};
}

function harness({
	sdkLoaded = true,
	linkBank = true,
	errorRegionOnScreen = true,
	redrawKeepsLinkButton = false,
	visibilityState = "visible",
	dataset,
	tokenResponse = {
		ok: true,
		json: async () => ({ link_token: "link-secret" }),
	},
	ajax = vi.fn(),
	refreshResponse = {
		ok: true,
		text: async () =>
			'<section id="accounts-summary" data-version="new"></section>',
	},
	homeRefreshResponse = {
		ok: true,
		text: async () =>
			'<main id="page" data-version="new"><p id="setup-status" data-link-bank-focus></p></main>',
	},
	setupRefreshResponse = {
		ok: true,
		text: async () =>
			'<main id="setup-screen" data-version="new"><p id="setup-status" data-link-bank-focus></p></main>',
	},
}: {
	sdkLoaded?: boolean;
	linkBank?: boolean;
	/** False when no [data-link-bank-error] is on screen (a first-week redraw can take it away). */
	errorRegionOnScreen?: boolean;
	redrawKeepsLinkButton?: boolean;
	visibilityState?: "visible" | "hidden";
	dataset?: Record<string, string>;
	tokenResponse?: {
		ok: boolean;
		json?: () => Promise<{ link_token: string }>;
		text?: () => Promise<string>;
	};
	ajax?: ReturnType<typeof vi.fn>;
	refreshResponse?: {
		ok: boolean;
		redirected?: boolean;
		url?: string;
		text: () => Promise<string>;
	};
	homeRefreshResponse?: {
		ok: boolean;
		text: () => Promise<string>;
	};
	/** Setup's refresh (/setup). A redirect there means setup has moved on (decision 146's screens). */
	setupRefreshResponse?: {
		ok: boolean;
		redirected?: boolean;
		url?: string;
		text: () => Promise<string>;
	};
} = {}) {
	let click: () => Promise<void> = async () => {};
	let delegatedClick: (event: unknown) => Promise<void> = async () => {};
	let linkOptions:
		| {
				onSuccess: (token: string) => Promise<void>;
				onExit: (error?: unknown) => void;
		  }
		| undefined;
	type RequestListener = (event: { detail?: { ctx?: unknown } }) => void;
	const listeners = new Map<string, Set<RequestListener>>();
	const button = {
		dataset,
		isConnected: true,
		disabled: false,
		focus: vi.fn(),
		setAttribute: vi.fn(),
		classList: { toggle: vi.fn() },
		addEventListener: (name: string, listener: never) => {
			if (name === "click") click = listener;
			else {
				const requestListeners = listeners.get(name) ?? new Set();
				requestListeners.add(listener);
				listeners.set(name, requestListeners);
			}
		},
		removeEventListener: vi.fn((name: string, listener: RequestListener) => {
			listeners.get(name)?.delete(listener);
		}),
		dispatchRequest: (name: string, ctx: unknown) => {
			for (const listener of listeners.get(name) ?? []) {
				listener({ detail: { ctx } });
			}
		},
	};
	const children: Array<{ textContent?: string; role?: string }> = [];
	const errorRegion = {
		replaceChildren: vi.fn((...nodes) =>
			children.splice(0, children.length, ...nodes),
		),
	};
	const repairChildren: Array<{ textContent?: string; role?: string }> = [];
	const repairError = {
		replaceChildren: vi.fn((...nodes) =>
			repairChildren.splice(0, repairChildren.length, ...nodes),
		),
	};
	let liveRepairError = repairError;
	let liveLinkButton: typeof button | undefined;
	let liveErrorRegion = errorRegion;
	const repairedHeading = { focus: vi.fn() };
	const section = {
		querySelector: (selector: string) =>
			selector === "[data-fix-error]" ? repairError : undefined,
	};
	const repairButton = {
		isConnected: true,
		disabled: false,
		setAttribute: vi.fn(),
		classList: { toggle: vi.fn() },
		getAttribute: (name: string) => (name === "data-item-id" ? "42" : null),
		closest: (selector: string) =>
			selector === "[data-bank-item-id]" ? section : undefined,
		addEventListener: button.addEventListener,
		removeEventListener: button.removeEventListener,
		dispatchRequest: button.dispatchRequest,
	};
	const currentSummary = {
		version: "old",
		replaceWith: vi.fn(),
	};
	const parsedSummaries: Array<{ version: string }> = [];
	// Home's #page holds Link a bank, so the refresh that swaps it in also takes the button away. A reading-phase Home
	// redraws its own Have more accounts? button, so the refresh keeps one (redrawKeepsLinkButton).
	let linkButtonGone = false;
	const currentPage = {
		version: "old",
		replaceWith: vi.fn(() => {
			linkButtonGone = !redrawKeepsLinkButton;
		}),
	};
	const parsedPages: Array<{ version: string }> = [];
	// Setup's screen (#setup-screen), which a setup link's refresh swaps in.
	const currentSetup = {
		version: "old",
		replaceWith: vi.fn(),
	};
	const parsedSetups: Array<{ version: string }> = [];
	const status = { focus: vi.fn() };
	// The document body, which an exchange with no Link a bank on screen uses as its source (plaid-link.js).
	const body = {
		isConnected: true,
		dispatchEvent: vi.fn(),
		...elementListeners(),
	};
	// The document's own listeners: the click delegate, and the before-request guard for Home's waiting refreshes.
	const documentEvents = elementListeners();
	const document = {
		body,
		injectedScripts: [] as Array<{
			src: string;
			async?: boolean;
			onload?: () => void;
			onerror?: () => void;
		}>,
		head: {
			appendChild(script: {
				src: string;
				async?: boolean;
				onload?: () => void;
				onerror?: () => void;
			}) {
				document.injectedScripts.push(script);
			},
		},
		// Where a setup refresh that redirected sends the person (plaid-link.js uses document.location, not window.location).
		location: { assign: vi.fn() },
		// A tab on screen, unless the test says otherwise. The presence ping ignores it while a link is open (decision 149).
		visibilityState,
		addEventListener: (name: string, listener: never) => {
			if (name === "click") delegatedClick = listener;
			else documentEvents.addEventListener(name, listener);
		},
		querySelector: (selector: string) => {
			if (selector === "[data-link-bank]")
				return linkButtonGone
					? undefined
					: (liveLinkButton ?? (linkBank ? button : undefined));
			if (selector === "[data-link-bank-error]")
				return errorRegionOnScreen ? liveErrorRegion : undefined;
			if (selector === "#accounts-summary") return currentSummary;
			if (selector === "#page") return currentPage;
			if (selector === "#setup-screen") return currentSetup;
			// Setup's status line (setup-reading.tsx) is the focus target; this harness returns it only for a #page refresh, so the setup tests have none.
			if (selector === "[data-link-bank-focus]")
				return dataset?.linkBankTarget === "#page" ? status : undefined;
			if (selector === '[data-bank-item-id="42"] [data-fix-error]')
				return liveRepairError;
		},
		createElement: () => ({
			src: "",
			async: false,
			onload: undefined as (() => void) | undefined,
			onerror: undefined as (() => void) | undefined,
			role: undefined as string | undefined,
			setAttribute(name: string, value: string) {
				if (name === "role") this.role = value;
			},
			textContent: "",
		}),
	};
	const fetch = vi.fn(async (url: string) => {
		if (url === "/accounts") return refreshResponse;
		if (url === "/") return homeRefreshResponse;
		if (url === "/setup") return setupRefreshResponse;
		return tokenResponse;
	});
	const create = vi.fn((options) => {
		linkOptions = options;
		return { open: vi.fn() };
	});
	class DOMParser {
		parseFromString(text: string) {
			const match = text.match(/role=["']alert["'][^>]*>([^<]*)/);
			const summaryMatch = text.match(
				/id=["']accounts-summary["'][^>]*data-version=["']([^"']*)/,
			);
			const summary = summaryMatch?.[1]
				? {
						version: summaryMatch[1],
						querySelector: (selector: string) =>
							selector === '[data-bank-item-id="42"]'
								? {
										querySelector: (childSelector: string) =>
											childSelector === "h2" ? repairedHeading : undefined,
									}
								: undefined,
					}
				: undefined;
			if (summary) parsedSummaries.push(summary);
			const pageMatch = text.match(
				/id=["']page["'][^>]*data-version=["']([^"']*)/,
			);
			const page = pageMatch?.[1] ? { version: pageMatch[1] } : undefined;
			if (page) parsedPages.push(page);
			const setupMatch = text.match(
				/id=["']setup-screen["'][^>]*data-version=["']([^"']*)/,
			);
			const setup = setupMatch?.[1] ? { version: setupMatch[1] } : undefined;
			if (setup) parsedSetups.push(setup);
			return {
				querySelector: (selector: string) =>
					selector === "#accounts-summary"
						? summary
						: selector === "#page"
							? page
							: selector === "#setup-screen"
								? setup
								: match
									? { textContent: match[1] }
									: undefined,
			};
		}
	}
	if (sdkLoaded) (globalThis as { Plaid?: unknown }).Plaid = { create };
	else delete (globalThis as { Plaid?: unknown }).Plaid;
	const process = vi.fn();
	// htmx 4 sends no request for a source that is no longer in the document: its #handleTriggerEvent returns when
	// !elt.isConnected (node_modules/htmx.org/dist/htmx.js). The fake refuses one the same way, so an exchange that
	// depends on a redrawn button fails here as it would in the browser.
	const htmxAjax = vi.fn(
		async (method: string, url: string, options: { source?: unknown }) => {
			if ((options.source as { isConnected?: boolean })?.isConnected === false)
				return;
			// The harness's mock, called as htmx calls it (its union type is not callable directly).
			const send = ajax as unknown as (
				method: string,
				url: string,
				options: unknown,
			) => unknown;
			return send(method, url, options);
		},
	);
	setupPlaidLink({
		document,
		fetch,
		htmx: { ajax: htmxAjax, process },
		DOMParser,
	});
	return {
		ajax,
		body,
		/** The before-request event htmx 4 dispatches on a request's source, and whether a listener cancelled it. */
		beforeRequest: (source: unknown) => {
			const event = requestEvent(source);
			for (const listener of documentEvents.listeners.get(
				"htmx:before:request",
			) ?? [])
				listener(event);
			return event;
		},
		button,
		repairButton,
		repairChildren,
		repairError,
		repairedHeading,
		children,
		click: (target: unknown = button) =>
			delegatedClick({
				target: {
					closest: (selector: string) =>
						selector === "[data-link-bank]" ? target : undefined,
				},
			}),
		directClick: () => click(),
		repairClick: (target: unknown = repairButton) =>
			delegatedClick({
				target: {
					closest: (selector: string) =>
						selector === "[data-fix-connection]" ? target : undefined,
				},
			}),
		create,
		fetch,
		get linkOptions() {
			return linkOptions;
		},
		listeners,
		document,
		currentSummary,
		parsedSummaries,
		currentPage,
		parsedPages,
		currentSetup,
		parsedSetups,
		status,
		process,
		replaceRepairError(region: typeof repairError) {
			liveRepairError = region;
		},
		/** A summary refresh re-renders Link a bank and its error region (decision 55). */
		replaceLinkButton(next: typeof button, region?: typeof errorRegion) {
			liveLinkButton = next;
			if (region) liveErrorRegion = region;
		},
	};
}

afterEach(() => {
	delete (globalThis as { Plaid?: unknown }).Plaid;
});

describe("plaid-link.js", () => {
	it("loads Plaid's stable SDK only after a Link action is selected", async () => {
		const h = harness({ sdkLoaded: false });
		const pending = h.click();

		expect(h.document.injectedScripts).toHaveLength(1);
		expect(h.document.injectedScripts[0]?.src).toBe(
			"https://cdn.plaid.com/link/v2/stable/link-initialize.js",
		);
		expect(h.fetch).not.toHaveBeenCalled();

		(globalThis as { Plaid?: unknown }).Plaid = { create: h.create };
		h.document.injectedScripts[0]?.onload?.();
		await pending;
		expect(h.fetch).toHaveBeenCalledWith("/plaid/link-token", {
			method: "POST",
		});
	});

	it("retries loading Plaid after an interrupted SDK request", async () => {
		const h = harness({ sdkLoaded: false });
		const interrupted = h.click();
		h.document.injectedScripts[0]?.onerror?.();
		await interrupted;
		expect(h.button.disabled).toBe(false);

		const retry = h.click();
		expect(h.document.injectedScripts).toHaveLength(2);
		(globalThis as { Plaid?: unknown }).Plaid = { create: h.create };
		h.document.injectedScripts[1]?.onload?.();
		await retry;
		expect(h.fetch).toHaveBeenCalledWith("/plaid/link-token", {
			method: "POST",
		});
	});

	describe("Fix connection", () => {
		it("handles Fix connection when Link a bank is absent", async () => {
			const h = harness({ linkBank: false });
			await h.repairClick();
			expect(h.fetch).toHaveBeenCalledWith("/plaid/items/42/link-token", {
				method: "POST",
			});
		});

		function repairedAjax(status = 204) {
			return vi.fn(
				async (
					_method: string,
					_url: string,
					options: {
						source: { dispatchRequest: (name: string, ctx: unknown) => void };
					},
				) => {
					const ctx = {
						response: { status },
						text: status >= 400 ? '<p role="alert">Repair failed.</p>' : "",
						hx: {
							trigger: JSON.stringify({
								toast: { message: "Fixed First Bank.", type: "success" },
								announce: "Fixed First Bank.",
							}),
						},
					};
					options.source.dispatchRequest("htmx:after:request", ctx);
					options.source.dispatchRequest("htmx:finally:request", ctx);
				},
			);
		}

		it("repairs, refreshes, announces once, and focuses that bank heading", async () => {
			const ajax = repairedAjax();
			const h = harness({ ajax });
			await h.repairClick();
			expect(h.create).toHaveBeenCalledWith(
				expect.objectContaining({ token: "link-secret" }),
			);
			await h.linkOptions?.onSuccess("unused-public-token");
			expect(ajax).toHaveBeenCalledWith(
				"POST",
				"/plaid/items/42/repaired",
				expect.objectContaining({ source: h.repairButton, swap: "none" }),
			);
			expect(h.currentSummary.replaceWith).toHaveBeenCalledWith(
				h.parsedSummaries[0],
			);
			const announcements = h.document.body.dispatchEvent.mock.calls.filter(
				([event]) => event.type === "announce",
			);
			expect(announcements).toHaveLength(1);
			expect(announcements[0]?.[0].detail).toEqual({
				value: "Fixed First Bank.",
			});
			expect(h.repairedHeading.focus).toHaveBeenCalledOnce();
		});

		it("shows the link-token error and enables the repair button", async () => {
			const h = harness({
				tokenResponse: {
					ok: false,
					text: async () => '<p role="alert">Token failed.</p>',
				},
			});
			await h.repairClick();
			expect(h.repairChildren[0]?.textContent).toBe("Token failed.");
			expect(h.repairButton.disabled).toBe(false);
		});

		it("shows one alert and enables the button when Plaid exits with an error", async () => {
			const h = harness();
			await h.repairClick();
			h.linkOptions?.onExit(new Error("exit"));
			expect(h.repairChildren).toHaveLength(1);
			expect(h.repairChildren[0]?.textContent).toBe(
				"Couldn't fix the connection. Try again.",
			);
			expect(h.repairButton.disabled).toBe(false);
		});

		it("shows one server alert and enables the button when repaired returns 502", async () => {
			const ajax = repairedAjax(502);
			const h = harness({ ajax });
			await h.repairClick();
			await h.linkOptions?.onSuccess("unused");
			expect(h.repairChildren).toHaveLength(1);
			expect(h.repairChildren[0]?.textContent).toBe("Repair failed.");
			expect(h.repairButton.disabled).toBe(false);
		});

		it("shows one alert and enables the button when finally has no response", async () => {
			const ajax = vi.fn(
				async (
					_method: string,
					_url: string,
					options: {
						source: { dispatchRequest: (name: string, ctx: unknown) => void };
					},
				) => {
					options.source.dispatchRequest("htmx:finally:request", {});
				},
			);
			const h = harness({ ajax });
			await h.repairClick();
			await h.linkOptions?.onSuccess("unused");
			expect(h.repairChildren).toHaveLength(1);
			expect(h.repairChildren[0]?.textContent).toBe(
				"Couldn't fix the connection. Try again.",
			);
			expect(h.repairButton.disabled).toBe(false);
		});

		it("shows one alert and enables the button when repaired rejects", async () => {
			const h = harness({
				ajax: vi.fn(async () => {
					throw new TypeError("network");
				}),
			});
			await h.repairClick();
			await h.linkOptions?.onSuccess("unused");
			expect(h.repairChildren).toHaveLength(1);
			expect(h.repairChildren[0]?.textContent).toBe(
				"Couldn't fix the connection. Try again.",
			);
			expect(h.repairButton.disabled).toBe(false);
		});

		it("shows a repaired failure in the live region after the summary is replaced", async () => {
			const h = harness({ ajax: repairedAjax(502) });
			const liveChildren: Array<{ textContent?: string; role?: string }> = [];
			const liveRegion = {
				replaceChildren: vi.fn((...nodes) =>
					liveChildren.splice(0, liveChildren.length, ...nodes),
				),
			};
			await h.repairClick();
			h.replaceRepairError(liveRegion);
			await h.linkOptions?.onSuccess("unused");
			expect(liveChildren).toHaveLength(1);
			expect(liveChildren[0]?.textContent).toBe("Repair failed.");
		});

		it("shows an alert and leaves the repair button enabled when Plaid is missing", async () => {
			const h = harness();
			delete (globalThis as { Plaid?: unknown }).Plaid;
			const pending = h.repairClick();
			h.document.injectedScripts[0]?.onerror?.();
			await pending;
			expect(h.repairChildren).toHaveLength(1);
			expect(h.repairButton.disabled).toBe(false);
		});

		it("keeps the summary and shows one alert when refresh returns 500", async () => {
			const ajax = repairedAjax();
			const h = harness({
				ajax,
				refreshResponse: { ok: false, text: async () => "failed" },
			});
			await h.repairClick();
			await h.linkOptions?.onSuccess("unused");
			expect(h.currentSummary.replaceWith).not.toHaveBeenCalled();
			expect(h.repairChildren).toHaveLength(1);
			expect(h.repairChildren[0]?.textContent).toContain(
				"the list didn't refresh",
			);
			expect(h.repairButton.disabled).toBe(false);
		});

		it("handles a replacement Fix button through delegated clicks", async () => {
			const h = harness();
			await h.repairClick();
			// The first fix ends (Link closed) before the redrawn button is clicked.
			h.linkOptions?.onExit();
			const replacement = {
				...h.repairButton,
				disabled: false,
				setAttribute: vi.fn(),
				classList: { toggle: vi.fn() },
			};
			await h.repairClick(replacement);
			expect(h.fetch).toHaveBeenCalledTimes(2);
			expect(replacement.disabled).toBe(true);
		});
	});

	it("refreshes the whole account summary, then announces the linked bank once", async () => {
		const ajax = vi.fn(async (method: string) => {
			if (method === "POST") {
				const ctx = {
					response: { status: 204 },
					text: "",
					hx: {
						trigger: JSON.stringify({
							toast: { message: "Linked First Bank.", type: "success" },
							announce: "Linked First Bank.",
						}),
					},
				};
				h.button.dispatchRequest("htmx:after:request", ctx);
				const earlyTriggers = JSON.parse(ctx.hx.trigger);
				for (const [type, detail] of Object.entries(earlyTriggers)) {
					h.document.body.dispatchEvent(new CustomEvent(type, { detail }));
				}
				h.button.dispatchRequest("htmx:finally:request", ctx);
			}
		});
		const h = harness({ ajax });
		await h.click();
		await h.linkOptions?.onSuccess("public-secret");
		const announced = () =>
			h.document.body.dispatchEvent.mock.calls.filter(
				([event]) => event.type === "announce",
			);
		expect(h.document.body.dispatchEvent.mock.calls[0]?.[0].type).toBe("toast");
		expect(ajax).toHaveBeenNthCalledWith(
			1,
			"POST",
			"/plaid/exchange",
			expect.objectContaining({
				swap: "none",
				values: { public_token: "public-secret" },
			}),
		);
		expect(h.fetch).toHaveBeenCalledWith("/accounts");
		expect(h.currentSummary.replaceWith).toHaveBeenCalledWith(
			h.parsedSummaries[0],
		);
		expect(h.process).toHaveBeenCalledWith(h.parsedSummaries[0]);
		expect(announced()).toHaveLength(1);
		const event = announced()[0]?.[0];
		expect(event.type).toBe("announce");
		expect(event.detail).toEqual({ value: "Linked First Bank." });
		expect(h.button.focus).toHaveBeenCalledOnce();
	});

	it("on Home, refreshes the page its button names (/, not Accounts' list), then focuses the status line, not the gone button", async () => {
		const ajax = vi.fn(async (method: string) => {
			if (method === "POST") {
				const ctx = { response: { status: 204 }, text: "" };
				h.button.dispatchRequest("htmx:after:request", ctx);
				h.button.dispatchRequest("htmx:finally:request", ctx);
			}
		});
		const h = harness({
			ajax,
			dataset: { linkBankRefresh: "/", linkBankTarget: "#page" },
		});
		await h.click();
		await h.linkOptions?.onSuccess("public-secret");
		expect(h.fetch).toHaveBeenCalledWith("/");
		expect(h.fetch).not.toHaveBeenCalledWith("/accounts");
		expect(h.parsedPages).toHaveLength(1);
		expect(h.currentPage.replaceWith).toHaveBeenCalledWith(h.parsedPages[0]);
		expect(h.process).toHaveBeenCalledWith(h.parsedPages[0]);
		expect(h.currentSummary.replaceWith).not.toHaveBeenCalled();
		expect(h.children).toHaveLength(0);
		expect(h.status.focus).toHaveBeenCalledOnce();
		expect(h.button.focus).not.toHaveBeenCalled();
	});

	it("on Home while the import is read, the redrawn page still has Link a bank, and focus still goes to the status line, not the button", async () => {
		const ajax = vi.fn(async (method: string) => {
			if (method === "POST") {
				const ctx = { response: { status: 204 }, text: "" };
				h.button.dispatchRequest("htmx:after:request", ctx);
				h.button.dispatchRequest("htmx:finally:request", ctx);
			}
		});
		const h = harness({
			ajax,
			redrawKeepsLinkButton: true,
			dataset: { linkBankRefresh: "/", linkBankTarget: "#page" },
		});
		await h.click();
		await h.linkOptions?.onSuccess("public-secret");
		expect(h.currentPage.replaceWith).toHaveBeenCalledWith(h.parsedPages[0]);
		expect(h.status.focus).toHaveBeenCalledOnce();
		expect(h.button.focus).not.toHaveBeenCalled();
	});

	it("on Home, a failed page refresh after linking says the page didn't refresh, not the list", async () => {
		const ajax = vi.fn(async (method: string) => {
			if (method === "POST") {
				h.button.dispatchRequest("htmx:finally:request", {
					response: { status: 204 },
					text: "",
					hx: {
						trigger: JSON.stringify({
							announce:
								"First Bank is linked. Tally's reading your last 90 days.",
						}),
					},
				});
			}
		});
		const h = harness({
			ajax,
			dataset: { linkBankRefresh: "/", linkBankTarget: "#page" },
			homeRefreshResponse: { ok: false, text: async () => "Refresh failed." },
		});

		await h.click();
		await h.linkOptions?.onSuccess("public-secret");

		expect(h.children).toEqual([
			expect.objectContaining({
				role: "alert",
				textContent:
					"First Bank is linked. Tally's reading your last 90 days, but the page didn't refresh. Reload the page to see it.",
			}),
		]);
		const announcements = h.document.body.dispatchEvent.mock.calls.filter(
			([event]) => event.type === "announce",
		);
		expect(announcements).toHaveLength(1);
		expect(h.currentPage.replaceWith).not.toHaveBeenCalled();
		expect(h.status.focus).not.toHaveBeenCalled();
		expect(h.button.focus).not.toHaveBeenCalled();
		expect(h.button.disabled).toBe(false);
	});

	it("on setup, a refresh that redirected (setup has moved on) goes to the page it reached, with no swap, alert or announce", async () => {
		const ajax = vi.fn(async (method: string) => {
			if (method === "POST") {
				const ctx = {
					response: { status: 204 },
					text: "",
					hx: {
						trigger: JSON.stringify({
							announce:
								"First Bank is linked. Tally's reading your last 90 days.",
						}),
					},
				};
				h.button.dispatchRequest("htmx:after:request", ctx);
				h.button.dispatchRequest("htmx:finally:request", ctx);
			}
		});
		const h = harness({
			ajax,
			dataset: { linkBankRefresh: "/setup", linkBankTarget: "#setup-screen" },
			setupRefreshResponse: {
				ok: true,
				redirected: true,
				url: "https://tally.example/first-page",
				text: async () => '<main id="setup-screen" data-version="new"></main>',
			},
		});

		await h.click();
		await h.linkOptions?.onSuccess("public-secret");

		expect(h.fetch).toHaveBeenCalledWith("/setup");
		expect(h.document.location.assign).toHaveBeenCalledOnce();
		expect(h.document.location.assign).toHaveBeenCalledWith(
			"https://tally.example/first-page",
		);
		expect(h.parsedSetups).toHaveLength(0);
		expect(h.currentSetup.replaceWith).not.toHaveBeenCalled();
		expect(h.children).toHaveLength(0);
		expect(h.document.body.dispatchEvent).not.toHaveBeenCalled();
		expect(h.button.disabled).toBe(false);
	});

	it("on setup, a refresh that did not redirect swaps its screen in as before", async () => {
		const ajax = vi.fn(async (method: string) => {
			if (method === "POST") {
				const ctx = { response: { status: 204 }, text: "" };
				h.button.dispatchRequest("htmx:after:request", ctx);
				h.button.dispatchRequest("htmx:finally:request", ctx);
			}
		});
		const h = harness({
			ajax,
			dataset: { linkBankRefresh: "/setup", linkBankTarget: "#setup-screen" },
			setupRefreshResponse: {
				ok: true,
				redirected: false,
				text: async () => '<main id="setup-screen" data-version="new"></main>',
			},
		});

		await h.click();
		await h.linkOptions?.onSuccess("public-secret");

		expect(h.fetch).toHaveBeenCalledWith("/setup");
		expect(h.parsedSetups).toHaveLength(1);
		expect(h.currentSetup.replaceWith).toHaveBeenCalledWith(h.parsedSetups[0]);
		expect(h.document.location.assign).not.toHaveBeenCalled();
		expect(h.button.focus).toHaveBeenCalledOnce();
	});

	it("shows a generic alert and keeps the button enabled when Plaid did not load", async () => {
		const h = harness();
		delete (globalThis as { Plaid?: unknown }).Plaid;
		const pending = h.click();
		h.document.injectedScripts[0]?.onerror?.();
		await pending;
		expect(h.children).toEqual([
			expect.objectContaining({ role: "alert", textContent: genericFailure }),
		]);
		expect(h.button.disabled).toBe(false);
	});

	it("shows the link-token server alert and re-enables the button", async () => {
		const h = harness({
			tokenResponse: {
				ok: false,
				text: async () => '<p role="alert">Plaid is unavailable.</p>',
			},
		});
		await h.click();
		expect(h.children[0]?.textContent).toBe("Plaid is unavailable.");
		expect(h.button.disabled).toBe(false);
	});

	it("shows one alert when the exchange returns 502", async () => {
		const ajax = vi.fn(async () =>
			h.button.dispatchRequest("htmx:finally:request", {
				response: { status: 502 },
				text: '<p role="alert">Exchange failed.</p>',
			}),
		);
		const h = harness({ ajax });
		await h.click();
		await h.linkOptions?.onSuccess("public-secret");
		expect(h.children).toEqual([
			expect.objectContaining({
				role: "alert",
				textContent: "Exchange failed.",
			}),
		]);
	});

	it("shows the generic alert when Plaid exits with an error", async () => {
		const h = harness();
		await h.click();
		h.linkOptions?.onExit(new Error("exit"));
		expect(h.children[0]?.textContent).toBe(genericFailure);
	});

	it("shows the generic alert when the exchange request rejects", async () => {
		const h = harness({
			ajax: vi.fn(async () => {
				throw new TypeError("network");
			}),
		});
		await h.click();
		await h.linkOptions?.onSuccess("public-secret");
		expect(h.children[0]?.textContent).toBe(genericFailure);
		expect(h.button.disabled).toBe(false);
	});

	it("cleans up exchange listeners after a rejection so a retry announces once", async () => {
		let exchangeAttempt = 0;
		const ajax = vi.fn(async (method: string) => {
			if (method !== "POST") return;
			exchangeAttempt += 1;
			if (exchangeAttempt === 1) throw new TypeError("network");
			const ctx = {
				response: { status: 204 },
				text: "",
				hx: {
					trigger: JSON.stringify({ announce: "Linked Retry Bank." }),
				},
			};
			h.button.dispatchRequest("htmx:after:request", ctx);
			h.button.dispatchRequest("htmx:finally:request", ctx);
		});
		const h = harness({ ajax });

		await h.click();
		await h.linkOptions?.onSuccess("first-public-secret");
		expect(h.listeners.get("htmx:after:request")?.size ?? 0).toBe(0);
		expect(h.listeners.get("htmx:finally:request")?.size ?? 0).toBe(0);

		await h.click();
		await h.linkOptions?.onSuccess("retry-public-secret");
		const announcements = h.document.body.dispatchEvent.mock.calls.filter(
			([event]) => event.type === "announce",
		);
		expect(announcements).toHaveLength(1);
		expect(announcements[0]?.[0].detail).toEqual({
			value: "Linked Retry Bank.",
		});
		expect(h.listeners.get("htmx:after:request")?.size ?? 0).toBe(0);
		expect(h.listeners.get("htmx:finally:request")?.size ?? 0).toBe(0);
	});

	it("reports a linked bank without confirming a failed summary refresh", async () => {
		const ajax = vi.fn(async () => {
			const ctx = {
				response: { status: 204 },
				text: "",
				hx: {
					trigger: JSON.stringify({ announce: "Linked First Bank." }),
				},
			};
			h.button.dispatchRequest("htmx:finally:request", ctx);
		});
		const h = harness({
			ajax,
			refreshResponse: { ok: false, text: async () => "Refresh failed." },
		});

		await h.click();
		await h.linkOptions?.onSuccess("public-secret");

		expect(h.children).toEqual([
			expect.objectContaining({
				role: "alert",
				textContent:
					"Linked First Bank, but the list didn't refresh. Reload the page to see it.",
			}),
		]);
		const announcements = h.document.body.dispatchEvent.mock.calls.filter(
			([event]) => event.type === "announce",
		);
		expect(announcements).toHaveLength(1);
		expect(announcements[0]?.[0].detail).toEqual({
			value: "Linked First Bank.",
		});
		expect(h.button.disabled).toBe(false);
		expect(h.button.focus).not.toHaveBeenCalled();
		expect(h.currentSummary.replaceWith).not.toHaveBeenCalled();
	});

	it("on Accounts, a failed list refresh while the household is setting up still says the list", async () => {
		const ajax = vi.fn(async (method: string) => {
			if (method === "POST") {
				h.button.dispatchRequest("htmx:finally:request", {
					response: { status: 204 },
					text: "",
					hx: {
						trigger: JSON.stringify({
							announce:
								"First Bank is linked. Tally's reading your last 90 days.",
						}),
					},
				});
			}
		});
		const h = harness({
			ajax,
			refreshResponse: { ok: false, text: async () => "Refresh failed." },
		});

		await h.click();
		await h.linkOptions?.onSuccess("public-secret");

		expect(h.children).toEqual([
			expect.objectContaining({
				role: "alert",
				textContent:
					"First Bank is linked. Tally's reading your last 90 days, but the list didn't refresh. Reload the page to see it.",
			}),
		]);
	});

	it("leaves the summary unchanged and reports a refresh network error", async () => {
		const ajax = vi.fn(async () => {
			h.button.dispatchRequest("htmx:finally:request", {
				response: { status: 204 },
				hx: { trigger: JSON.stringify({ announce: "Linked First Bank." }) },
			});
		});
		const h = harness({ ajax });
		h.fetch.mockImplementationOnce(async () => ({
			ok: true,
			json: async () => ({ link_token: "link-secret" }),
		}));
		h.fetch.mockRejectedValueOnce(new TypeError("network"));

		await h.click();
		await h.linkOptions?.onSuccess("public-secret");

		expect(h.currentSummary.replaceWith).not.toHaveBeenCalled();
		expect(h.children[0]?.textContent).toBe(
			"Linked First Bank, but the list didn't refresh. Reload the page to see it.",
		);
	});
	describe("Link a bank inside the summary (decision 55)", () => {
		function linkedAjax() {
			return vi.fn(
				async (
					_method: string,
					_url: string,
					options: {
						source: { dispatchRequest: (name: string, ctx: unknown) => void };
					},
				) => {
					const ctx = {
						response: { status: 204 },
						text: "",
						hx: {
							trigger: JSON.stringify({
								toast: { message: "Linked First Bank.", type: "success" },
								announce: "Linked First Bank.",
							}),
						},
					};
					options.source.dispatchRequest("htmx:after:request", ctx);
					options.source.dispatchRequest("htmx:finally:request", ctx);
				},
			);
		}

		it("installs no listener on the button itself; clicks arrive through the document", async () => {
			const h = harness();
			await h.directClick();
			expect(h.fetch).not.toHaveBeenCalled();
			await h.click();
			expect(h.fetch).toHaveBeenCalledWith("/plaid/link-token", {
				method: "POST",
			});
		});

		it("still works when a refresh replaced the button", async () => {
			const h = harness();
			const replacement = { ...h.button, focus: vi.fn() };
			h.replaceLinkButton(replacement);
			await h.click(replacement);
			expect(h.fetch).toHaveBeenCalledWith("/plaid/link-token", {
				method: "POST",
			});
		});

		it("focuses the live Link a bank button after the summary refresh", async () => {
			const ajax = linkedAjax();
			const h = harness({ ajax });
			await h.click();
			const refreshed = { ...h.button, focus: vi.fn() };
			h.currentSummary.replaceWith.mockImplementation(() =>
				h.replaceLinkButton(refreshed),
			);
			await h.linkOptions?.onSuccess("public-token");
			expect(refreshed.focus).toHaveBeenCalled();
			expect(h.button.focus).not.toHaveBeenCalled();
		});

		it("writes a failure into the live error region after a refresh replaced it", async () => {
			const h = harness({
				tokenResponse: {
					ok: false,
					text: async () => '<p role="alert">Server said no.</p>',
				},
			});
			const liveChildren: Array<{ textContent?: string }> = [];
			const liveRegion = {
				replaceChildren: vi.fn((...nodes) =>
					liveChildren.splice(0, liveChildren.length, ...nodes),
				),
			};
			h.replaceLinkButton(h.button, liveRegion);
			await h.click();
			expect(liveChildren.map((c) => c.textContent)).toEqual([
				"Server said no.",
			]);
			expect(h.children).toHaveLength(0);
		});
	});

	describe("one flow at a time, whichever button is on screen", () => {
		it("ignores a click on a redrawn Link a bank while a link is still running", async () => {
			const h = harness();
			await h.click();
			expect(h.create).toHaveBeenCalledTimes(1);
			const redrawn = { ...h.button, disabled: false, focus: vi.fn() };
			h.replaceLinkButton(redrawn);
			await h.click(redrawn);
			expect(h.fetch).toHaveBeenCalledTimes(1);
			expect(h.create).toHaveBeenCalledTimes(1);
		});

		it("keeps a redrawn Link a bank busy until the running link ends, then frees it", async () => {
			const h = harness();
			await h.click();
			const redrawn = {
				...h.button,
				disabled: false,
				setAttribute: vi.fn(),
				classList: { toggle: vi.fn() },
				focus: vi.fn(),
			};
			h.replaceLinkButton(redrawn);
			// The end of the running link reaches the button now on screen.
			h.linkOptions?.onExit();
			expect(redrawn.disabled).toBe(false);
			expect(redrawn.setAttribute).toHaveBeenCalledWith("aria-busy", "false");
			await h.click(redrawn);
			expect(h.create).toHaveBeenCalledTimes(2);
		});

		it("ignores a second Fix connection click for the same bank while its fix is running", async () => {
			const h = harness();
			await h.repairClick();
			await h.repairClick({ ...h.repairButton, disabled: false });
			expect(
				h.fetch.mock.calls.filter(
					([url]) => url === "/plaid/items/42/link-token",
				),
			).toHaveLength(1);
		});
	});

	// Home's first-week refreshes (the Your banks poll and the presence check-in) carry data-waits-for-link. While Plaid
	// Link is open they are skipped, so a sort that finishes mid-link can't redraw the first-week top and take the bank being
	// linked away (decision 146). The exchange is never skipped.
	describe("Home's waiting refreshes, and the exchange after a redraw (decision 146)", () => {
		const waiting = () => ({
			isConnected: true,
			hasAttribute: (name: string) => name === "data-waits-for-link",
		});
		const announcements = (h: ReturnType<typeof harness>) =>
			h.document.body.dispatchEvent.mock.calls
				.map(([event]) => event)
				.filter((event) => event.type === "announce")
				.map((event) => event.detail.value);
		const linked = () => ({
			response: { status: 204 },
			text: "",
			hx: {
				trigger: JSON.stringify({ announce: "Linked First Bank." }),
			},
		});

		/** The presence check-in's element (home-seen.tsx), which says the person is still there. */
		const checkIn = () => ({
			id: "home-seen",
			isConnected: true,
			hasAttribute: (name: string) => name === "data-waits-for-link",
		});
		/** The POSTs to /home/seen the page has sent, as fetch was called. */
		const pingsOf = (h: ReturnType<typeof harness>) =>
			h.fetch.mock.calls
				.filter(([url]) => url === "/home/seen")
				.map((call) => call as unknown as [string, RequestInit]);

		it("cancels a request from an element that waits for the link, while a link is running", async () => {
			const h = harness();
			await h.click();
			expect(h.beforeRequest(waiting()).defaultPrevented).toBe(true);
		});

		it("sends one quiet presence ping in place of a skipped check-in, while a link is running", async () => {
			const h = harness();
			await h.click();
			expect(h.beforeRequest(checkIn()).defaultPrevented).toBe(true);
			const pings = pingsOf(h);
			expect(pings).toHaveLength(1);
			const [, init] = pings[0] ?? [];
			expect(init?.method).toBe("POST");
			expect(init?.headers).toEqual({
				"Content-Type": "application/x-www-form-urlencoded",
			});
			// An empty body: no step, so /home/seen only moves home_seen_at and answers 204 (the route's tests pin that).
			expect(init?.body).toBe("");
		});

		it("hidden while linking still sends one ping: a bank's own sign-in in another tab counts as there (decision 149)", async () => {
			const h = harness({ visibilityState: "hidden" });
			await h.click();
			expect(h.beforeRequest(checkIn()).defaultPrevented).toBe(true);
			expect(pingsOf(h)).toHaveLength(1);
		});

		it("sends one ping while the tab is on screen and a link is running (decision 149)", async () => {
			const h = harness({ visibilityState: "visible" });
			await h.click();
			expect(h.beforeRequest(checkIn()).defaultPrevented).toBe(true);
			expect(pingsOf(h)).toHaveLength(1);
		});

		it("sends a ping for each skipped check-in tick, one at a time", async () => {
			const h = harness();
			await h.click();
			h.beforeRequest(checkIn());
			h.beforeRequest(checkIn());
			h.beforeRequest(checkIn());
			expect(pingsOf(h)).toHaveLength(3);
		});

		it("sends no ping for a skipped poll or refresh, since only the check-in says the person is there", async () => {
			const h = harness();
			await h.click();
			const poll = { ...waiting(), id: "your-banks" };
			expect(h.beforeRequest(poll).defaultPrevented).toBe(true);
			expect(h.beforeRequest(waiting()).defaultPrevented).toBe(true);
			expect(pingsOf(h)).toEqual([]);
		});

		it("sends nothing extra when no link is running, so the check-in runs as usual", async () => {
			const h = harness();
			expect(h.beforeRequest(checkIn()).defaultPrevented).toBe(false);
			expect(pingsOf(h)).toEqual([]);
		});

		it("ignores a ping that fails, so a skipped tick never throws", async () => {
			const h = harness();
			await h.click();
			h.fetch.mockRejectedValueOnce(new TypeError("offline"));
			expect(h.beforeRequest(checkIn()).defaultPrevented).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(pingsOf(h)).toHaveLength(1);
		});

		it("leaves a request from any other element alone while a link is running", async () => {
			const h = harness();
			await h.click();
			const plain = { isConnected: true, hasAttribute: () => false };
			expect(h.beforeRequest(plain).defaultPrevented).toBe(false);
		});

		it("leaves the exchange alone while the link is running", async () => {
			const cancelled: boolean[] = [];
			const ajax = vi.fn(
				async (_method: string, _url: string, options: { source: unknown }) => {
					cancelled.push(h.beforeRequest(options.source).defaultPrevented);
					h.button.dispatchRequest("htmx:finally:request", linked());
				},
			);
			const h = harness({ ajax });
			await h.click();
			await h.linkOptions?.onSuccess("public-secret");
			expect(ajax).toHaveBeenCalledWith(
				"POST",
				"/plaid/exchange",
				expect.anything(),
			);
			expect(cancelled).toEqual([false]);
		});

		it("stops cancelling once onExit ends the link, so the next tick runs as usual", async () => {
			const h = harness();
			await h.click();
			h.linkOptions?.onExit();
			expect(h.beforeRequest(waiting()).defaultPrevented).toBe(false);
		});

		it("stops cancelling once onSuccess ends the link, so the next tick runs as usual", async () => {
			const h = harness();
			await h.click();
			await h.linkOptions?.onSuccess("public-secret");
			expect(h.beforeRequest(waiting()).defaultPrevented).toBe(false);
		});

		it("exchanges through the live Link a bank when the clicked one was redrawn away before onSuccess", async () => {
			const ajax = vi.fn(
				async (
					_method: string,
					_url: string,
					options: {
						source: { dispatchRequest: (n: string, c: unknown) => void };
					},
				) => {
					options.source.dispatchRequest("htmx:after:request", linked());
					options.source.dispatchRequest("htmx:finally:request", linked());
				},
			);
			const h = harness({ ajax });
			await h.click();
			const live = { ...h.button, isConnected: true, focus: vi.fn() };
			h.replaceLinkButton(live);
			h.button.isConnected = false;
			await h.linkOptions?.onSuccess("public-secret");
			expect(ajax).toHaveBeenCalledWith(
				"POST",
				"/plaid/exchange",
				expect.objectContaining({
					source: live,
					values: { public_token: "public-secret" },
				}),
			);
			expect(announcements(h)).toEqual(["Linked First Bank."]);
		});

		it("exchanges through document.body when no Link a bank is on screen either", async () => {
			const ajax = vi.fn(
				async (
					_method: string,
					_url: string,
					options: {
						source: { dispatchRequest: (n: string, c: unknown) => void };
					},
				) => {
					options.source.dispatchRequest("htmx:after:request", linked());
					options.source.dispatchRequest("htmx:finally:request", linked());
				},
			);
			const h = harness({ ajax, linkBank: false });
			await h.click();
			h.button.isConnected = false;
			await h.linkOptions?.onSuccess("public-secret");
			expect(ajax).toHaveBeenCalledWith(
				"POST",
				"/plaid/exchange",
				expect.objectContaining({ source: h.body }),
			);
			expect(announcements(h)).toEqual(["Linked First Bank."]);
		});

		it("says a failed exchange in a toast when no error region is on screen, so the words still reach the person", async () => {
			const ajax = vi.fn(async () => {
				h.button.dispatchRequest("htmx:finally:request", {
					response: { status: 502 },
					text: '<p role="alert">Exchange failed.</p>',
				});
			});
			const h = harness({ ajax, errorRegionOnScreen: false });
			await h.click();
			await h.linkOptions?.onSuccess("public-secret");
			const toasts = h.document.body.dispatchEvent.mock.calls
				.map(([event]) => event)
				.filter((event) => event.type === "toast");
			expect(toasts).toHaveLength(1);
			expect(toasts[0]?.detail).toEqual({
				message: "Exchange failed.",
				type: "error",
			});
		});

		it("writes a failed exchange into the error region, not a toast, when one is on screen", async () => {
			const ajax = vi.fn(async () => {
				h.button.dispatchRequest("htmx:finally:request", {
					response: { status: 502 },
					text: '<p role="alert">Exchange failed.</p>',
				});
			});
			const h = harness({ ajax });
			await h.click();
			await h.linkOptions?.onSuccess("public-secret");
			expect(h.children.map((child) => child.textContent)).toEqual([
				"Exchange failed.",
			]);
			expect(
				h.document.body.dispatchEvent.mock.calls.filter(
					([event]) => event.type === "toast",
				),
			).toHaveLength(0);
		});
	});
});

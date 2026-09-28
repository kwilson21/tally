import { afterEach, describe, expect, it, vi } from "vitest";
import { setupPlaidLink } from "../public/js/plaid-link.js";

const genericFailure = "Couldn't link the bank. Try again.";

function harness({
	linkBank = true,
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
}: {
	linkBank?: boolean;
	tokenResponse?: {
		ok: boolean;
		json?: () => Promise<{ link_token: string }>;
		text?: () => Promise<string>;
	};
	ajax?: ReturnType<typeof vi.fn>;
	refreshResponse?: {
		ok: boolean;
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
	const document = {
		body: { dispatchEvent: vi.fn() },
		addEventListener: (name: string, listener: never) => {
			if (name === "click") delegatedClick = listener;
		},
		querySelector: (selector: string) => {
			if (selector === "[data-link-bank]")
				return liveLinkButton ?? (linkBank ? button : undefined);
			if (selector === "[data-link-bank-error]") return liveErrorRegion;
			if (selector === "#accounts-summary") return currentSummary;
			if (selector === '[data-bank-item-id="42"] [data-fix-error]')
				return liveRepairError;
		},
		createElement: () => ({
			role: undefined as string | undefined,
			setAttribute(name: string, value: string) {
				if (name === "role") this.role = value;
			},
			textContent: "",
		}),
	};
	const fetch = vi.fn(async (url: string) =>
		url === "/accounts" ? refreshResponse : tokenResponse,
	);
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
			return {
				querySelector: (selector: string) =>
					selector === "#accounts-summary"
						? summary
						: match
							? { textContent: match[1] }
							: undefined,
			};
		}
	}
	(globalThis as { Plaid?: unknown }).Plaid = { create };
	const process = vi.fn();
	setupPlaidLink({ document, fetch, htmx: { ajax, process }, DOMParser });
	return {
		ajax,
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
			await h.repairClick();
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

	it("shows a generic alert and keeps the button enabled when Plaid did not load", async () => {
		const h = harness();
		delete (globalThis as { Plaid?: unknown }).Plaid;
		await h.click();
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
});

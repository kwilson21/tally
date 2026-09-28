import { afterEach, describe, expect, it, vi } from "vitest";
import { setupPlaidLink } from "../public/js/plaid-link.js";

const genericFailure = "Couldn't link the bank. Try again.";

function harness({
	tokenResponse = {
		ok: true,
		json: async () => ({ link_token: "link-secret" }),
	},
	ajax = vi.fn(),
}: {
	tokenResponse?: {
		ok: boolean;
		json?: () => Promise<{ link_token: string }>;
		text?: () => Promise<string>;
	};
	ajax?: ReturnType<typeof vi.fn>;
} = {}) {
	let click: () => Promise<void> = async () => {};
	let linkOptions:
		| {
				onSuccess: (token: string) => Promise<void>;
				onExit: (error?: unknown) => void;
		  }
		| undefined;
	const listeners = new Map<
		string,
		(event: { detail?: { ctx?: unknown } }) => void
	>();
	const button = {
		disabled: false,
		focus: vi.fn(),
		setAttribute: vi.fn(),
		classList: { toggle: vi.fn() },
		addEventListener: (name: string, listener: never) => {
			if (name === "click") click = listener;
			else listeners.set(name, listener);
		},
		removeEventListener: vi.fn(),
	};
	const children: Array<{ textContent?: string; role?: string }> = [];
	const errorRegion = {
		replaceChildren: vi.fn((...nodes) =>
			children.splice(0, children.length, ...nodes),
		),
	};
	const document = {
		body: { dispatchEvent: vi.fn() },
		querySelector: (selector: string) =>
			selector === "[data-link-bank]" ? button : errorRegion,
		createElement: () => ({
			role: undefined as string | undefined,
			setAttribute(name: string, value: string) {
				if (name === "role") this.role = value;
			},
			textContent: "",
		}),
	};
	const fetch = vi.fn(async () => tokenResponse);
	const create = vi.fn((options) => {
		linkOptions = options;
		return { open: vi.fn() };
	});
	class DOMParser {
		parseFromString(text: string) {
			const match = text.match(/role=["']alert["'][^>]*>([^<]*)/);
			return {
				querySelector: () => (match ? { textContent: match[1] } : undefined),
			};
		}
	}
	(globalThis as { Plaid?: unknown }).Plaid = { create };
	setupPlaidLink({ document, fetch, htmx: { ajax }, DOMParser });
	return {
		ajax,
		button,
		children,
		click: () => click(),
		create,
		fetch,
		get linkOptions() {
			return linkOptions;
		},
		listeners,
		document,
	};
}

afterEach(() => {
	delete (globalThis as { Plaid?: unknown }).Plaid;
});

describe("plaid-link.js", () => {
	it("refreshes the whole account summary, then announces the linked bank once", async () => {
		let finishRefresh = () => {};
		const refresh = new Promise<void>((resolve) => {
			finishRefresh = resolve;
		});
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
				h.listeners.get("htmx:after:request")?.({ detail: { ctx } });
				const earlyTriggers = JSON.parse(ctx.hx.trigger);
				for (const [type, detail] of Object.entries(earlyTriggers)) {
					h.document.body.dispatchEvent(new CustomEvent(type, { detail }));
				}
				h.listeners.get("htmx:finally:request")?.({ detail: { ctx } });
			} else {
				await refresh;
			}
		});
		const h = harness({ ajax });
		await h.click();
		const success = h.linkOptions?.onSuccess("public-secret");
		await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(2));
		const announced = () =>
			h.document.body.dispatchEvent.mock.calls.filter(
				([event]) => event.type === "announce",
			);
		expect(announced()).toHaveLength(0);
		expect(h.document.body.dispatchEvent.mock.calls[0]?.[0].type).toBe("toast");
		finishRefresh();
		await success;
		expect(ajax).toHaveBeenNthCalledWith(
			1,
			"POST",
			"/plaid/exchange",
			expect.objectContaining({
				swap: "none",
				values: { public_token: "public-secret" },
			}),
		);
		expect(ajax).toHaveBeenNthCalledWith(2, "GET", "/accounts", {
			target: "#accounts-summary",
			select: "#accounts-summary",
			swap: "outerHTML",
		});
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
			h.listeners.get("htmx:finally:request")?.({
				detail: {
					ctx: {
						response: { status: 502 },
						text: '<p role="alert">Exchange failed.</p>',
					},
				},
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
});

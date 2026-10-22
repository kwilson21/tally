import { describe, expect, it, vi } from "vitest";
import swSource from "../public/sw.js?raw";

// The service worker (decision 148): push shows the ready notification from its payload, and always shows one; a tap closes
// it and opens Tally, focusing and navigating an open window or opening a new one. It caches nothing and has no fetch handler.

const FALLBACK = {
	title: "Tally",
	body: "Your three questions are ready. About three minutes to finish setting up your budget.",
	url: "/first-page",
};

type Listener = (event: Record<string, unknown>) => void;

/** The worker's global scope, faked, with the handlers the script registers. */
function worker(windows: unknown[] = []) {
	const listeners = new Map<string, Listener>();
	const scope = {
		addEventListener: (type: string, listener: Listener) =>
			listeners.set(type, listener),
		skipWaiting: vi.fn(),
		clients: {
			claim: vi.fn(async () => undefined),
			matchAll: vi.fn(async () => windows),
			openWindow: vi.fn(async () => null),
		},
		registration: { showNotification: vi.fn(async () => undefined) },
	};
	new Function("self", swSource)(scope);
	/** Runs one event's listener and waits for everything it handed to waitUntil. */
	const send = async (type: string, event: Record<string, unknown> = {}) => {
		const pending: Promise<unknown>[] = [];
		const listener = listeners.get(type);
		if (!listener) throw new Error(`no ${type} listener`);
		listener({
			...event,
			waitUntil: (promise: Promise<unknown>) => pending.push(promise),
		});
		await Promise.all(pending);
	};
	return { scope, listeners, send };
}

const pushWith = (json: () => unknown) => ({ data: { json } });

describe("the service worker's push", () => {
	it("shows the notification the payload names, with its page and the one tag", async () => {
		const { scope, send } = worker();
		await send(
			"push",
			pushWith(() => ({
				title: "Tally",
				body: "Ready now.",
				url: "/first-page",
			})),
		);
		expect(scope.registration.showNotification).toHaveBeenCalledWith("Tally", {
			body: "Ready now.",
			data: { url: "/first-page" },
			icon: "/icons/icon-192.png",
			tag: "tally-ready",
		});
	});

	it("shows the fallback words when the payload can't be read", async () => {
		const { scope, send } = worker();
		await send(
			"push",
			pushWith(() => {
				throw new SyntaxError("not json");
			}),
		);
		expect(scope.registration.showNotification).toHaveBeenCalledWith(
			FALLBACK.title,
			expect.objectContaining({
				body: FALLBACK.body,
				data: { url: FALLBACK.url },
			}),
		);
	});

	it("shows the fallback words when the push has no data at all", async () => {
		const { scope, send } = worker();
		await send("push", {});
		expect(scope.registration.showNotification).toHaveBeenCalledWith(
			FALLBACK.title,
			expect.objectContaining({
				body: FALLBACK.body,
			}),
		);
	});

	it("opens a page on this site only: another origin's address falls back to the questions page", async () => {
		const { scope, send } = worker();
		await send(
			"push",
			pushWith(() => ({
				title: "Tally",
				body: "Ready.",
				url: "https://evil.example/x",
			})),
		);
		await send(
			"push",
			pushWith(() => ({
				title: "Tally",
				body: "Ready.",
				url: "//evil.example/x",
			})),
		);
		for (const [, options] of scope.registration.showNotification.mock
			.calls as unknown as [string, { data: { url: string } }][]) {
			expect(options.data.url).toBe("/first-page");
		}
	});

	it("still shows a notification when the first one fails, with the fallback words", async () => {
		const { scope, send } = worker();
		scope.registration.showNotification
			.mockRejectedValueOnce(new Error("blocked"))
			.mockResolvedValueOnce(undefined);
		await send(
			"push",
			pushWith(() => ({ title: "Tally", body: "Ready.", url: "/first-page" })),
		);
		expect(scope.registration.showNotification).toHaveBeenCalledTimes(2);
		expect(scope.registration.showNotification).toHaveBeenLastCalledWith(
			FALLBACK.title,
			expect.objectContaining({
				body: FALLBACK.body,
			}),
		);
	});
});

describe("the service worker's tap", () => {
	it("closes the notification, focuses an open Tally window and navigates it", async () => {
		const win = {
			focus: vi.fn(async () => win),
			navigate: vi.fn(async () => win),
		};
		const { send } = worker([win]);
		const close = vi.fn();
		await send("notificationclick", {
			notification: { close, data: { url: "/first-page" } },
		});
		expect(close).toHaveBeenCalledOnce();
		expect(win.focus).toHaveBeenCalledOnce();
		expect(win.navigate).toHaveBeenCalledWith("/first-page");
	});

	it("looks at uncontrolled windows too, so a window opened before the worker is one still counts", async () => {
		const { scope, send } = worker([]);
		await send("notificationclick", {
			notification: { close: vi.fn(), data: { url: "/first-page" } },
		});
		expect(scope.clients.matchAll).toHaveBeenCalledWith({
			type: "window",
			includeUncontrolled: true,
		});
	});

	it("opens a new window when no Tally window is open", async () => {
		const { scope, send } = worker([]);
		await send("notificationclick", {
			notification: { close: vi.fn(), data: { url: "/first-page" } },
		});
		expect(scope.clients.openWindow).toHaveBeenCalledWith("/first-page");
	});

	it("opens a new window when navigating the open one fails", async () => {
		const win = {
			focus: vi.fn(async () => win),
			navigate: vi.fn(async () => {
				throw new TypeError("not controlled by this worker");
			}),
		};
		const { scope, send } = worker([win]);
		await send("notificationclick", {
			notification: { close: vi.fn(), data: { url: "/first-page" } },
		});
		expect(scope.clients.openWindow).toHaveBeenCalledWith("/first-page");
	});

	it("opens the questions page when the notification carries no page", async () => {
		const { scope, send } = worker([]);
		await send("notificationclick", { notification: { close: vi.fn() } });
		expect(scope.clients.openWindow).toHaveBeenCalledWith("/first-page");
	});
});

describe("the service worker's lifecycle and caching", () => {
	it("takes over at once: skips waiting on install and claims the clients on activate", async () => {
		const { scope, send } = worker();
		await send("install");
		expect(scope.skipWaiting).toHaveBeenCalledOnce();
		await send("activate");
		expect(scope.clients.claim).toHaveBeenCalledOnce();
	});

	it("has no fetch handler, so the server still answers every page", () => {
		const { listeners } = worker();
		expect(listeners.has("fetch")).toBe(false);
	});
});

import { describe, expect, it, vi } from "vitest";
import { setupPush } from "../public/js/push.js";

// The notify control's script (decision 148), with a fake DOM as plaid-link-js.test.ts and keyboard-js.test.ts use: a control
// drawn with its four states hidden (as the server draws it), and the browser's navigator, registration, Notification and fetch
// faked. The script asks for nothing on its own, shows the state the browser already has, and does its tap's subscribe first.

const AS_PUBLIC =
	"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const OTHER_KEY =
	"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const ON = "Notifications are on for this device.";
const BLOCKED =
	"Notifications are blocked for Tally in this device's settings.";
const COULDNT_SAVE = "Couldn't save. Check your connection and try again.";

/** base64url text as the bytes it stands for. */
const bytesOf = (text: string) => {
	const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
	return Uint8Array.from(
		atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=")),
		(c) => c.charCodeAt(0),
	);
};

type Ev = { type: string; target?: El; detail?: unknown };
type Handler = (event: Ev) => unknown;

/** A tiny element: attributes, children, the hidden and disabled flags, and the selectors push.js uses ([name] and [name="v"]). */
class El {
	readonly attrs = new Map<string, string>();
	readonly children: El[] = [];
	parent: El | null = null;
	hidden = false;
	private isDisabled = false;
	textContent = "";
	readonly classes = new Set<string>();
	readonly classList = {
		toggle: (name: string, on?: boolean) => {
			if (on) this.classes.add(name);
			else this.classes.delete(name);
		},
		contains: (name: string) => this.classes.has(name),
	};
	constructor(
		readonly tag: string,
		readonly owner: Dom,
	) {}
	get disabled() {
		return this.isDisabled;
	}
	/** A disabled element drops focus, as a browser does: a busy button that had focus leaves it on nothing. */
	set disabled(value: boolean) {
		this.isDisabled = value;
		if (value && this.owner.activeElement === this) this.owner.active = null;
	}
	setAttribute(name: string, value: string) {
		this.attrs.set(name, String(value));
	}
	getAttribute(name: string) {
		return this.attrs.get(name) ?? null;
	}
	hasAttribute(name: string) {
		return this.attrs.has(name);
	}
	append(...nodes: El[]) {
		for (const node of nodes) {
			node.parent = this;
			this.children.push(node);
		}
	}
	replaceChildren(...nodes: El[]) {
		for (const child of this.children) child.parent = null;
		this.children.length = 0;
		this.append(...nodes);
	}
	remove() {
		if (this.parent)
			this.parent.children.splice(this.parent.children.indexOf(this), 1);
		this.parent = null;
	}
	focus() {
		this.owner.active = this;
		this.owner.focused.push(this);
	}
	descendants(): El[] {
		return this.children.flatMap((child) => [child, ...child.descendants()]);
	}
	querySelectorAll(selector: string): El[] {
		return this.descendants().filter((el) => matches(el, selector));
	}
	querySelector(selector: string): El | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}
	closest(selector: string): El | null {
		for (let el: El | null = this; el; el = el.parent)
			if (matches(el, selector)) return el;
		return null;
	}
}

function matches(el: El, selector: string) {
	const match = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
	if (!match) throw new Error(`unsupported selector ${selector}`);
	const [, name, value] = match;
	if (!el.hasAttribute(name ?? "")) return false;
	return value === undefined || el.getAttribute(name ?? "") === value;
}

/** The page's document: a root, the listeners, the events it was sent, and the elements focus was moved to. */
class Dom {
	readonly root = new El("html", this);
	readonly body = new El("body", this);
	readonly focused: El[] = [];
	readonly dispatched: Ev[] = [];
	/** The element with focus, or null for none (a browser then reports the body). */
	active: El | null = null;
	private readonly listeners = new Map<string, Handler[]>();
	get activeElement(): El {
		return this.active ?? this.body;
	}
	createElement(tag: string) {
		return new El(tag, this);
	}
	addEventListener(type: string, handler: Handler) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
	}
	dispatchEvent(event: Ev) {
		this.dispatched.push(event);
		for (const handler of this.listeners.get(event.type) ?? []) handler(event);
		return true;
	}
	querySelectorAll(selector: string) {
		return this.root.querySelectorAll(selector);
	}
	querySelector(selector: string) {
		return this.root.querySelector(selector);
	}
	click(target: El) {
		this.dispatchEvent({ type: "click", target });
	}
	/** The events of one type, sent on this document. */
	sent(type: string) {
		return this.dispatched.filter((event) => event.type === type);
	}
}

/** The control as the server draws it: four states, all hidden, a button, and an empty alert region. */
function drawControl(dom: Dom, vapidKey = AS_PUBLIC) {
	const node = dom.createElement("div");
	node.setAttribute("data-notify", "true");
	node.setAttribute("data-vapid-key", vapidKey);
	const off = dom.createElement("div");
	off.setAttribute("data-notify-state", "off");
	off.hidden = true;
	const button = dom.createElement("button");
	button.setAttribute("data-notify-on", "true");
	button.setAttribute("type", "button");
	off.append(button);
	const on = dom.createElement("p");
	on.setAttribute("data-notify-state", "on");
	on.setAttribute("tabindex", "-1");
	on.hidden = true;
	const iphone = dom.createElement("p");
	iphone.setAttribute("data-notify-state", "iphone");
	iphone.hidden = true;
	const blocked = dom.createElement("p");
	blocked.setAttribute("data-notify-state", "blocked");
	blocked.setAttribute("tabindex", "-1");
	blocked.hidden = true;
	const alert = dom.createElement("div");
	alert.setAttribute("data-notify-alert", "true");
	node.append(off, on, iphone, blocked, alert);
	dom.root.append(node);
	return node;
}

/** A PushSubscription as the browser hands it out: its endpoint, its key, and the key pair's two secrets. */
function subscriptionWith(
	key: string,
	endpoint = "https://push.example.test/send/one",
) {
	const bytes = bytesOf(key);
	const p256dh = new Uint8Array([1, 2, 3, 4]);
	const auth = new Uint8Array([5, 6, 7, 8]);
	return {
		endpoint,
		options: { applicationServerKey: bytes.buffer as ArrayBuffer },
		getKey: (name: string) => (name === "p256dh" ? p256dh.buffer : auth.buffer),
		unsubscribe: vi.fn(async () => true),
		toJSON: () => ({ endpoint, keys: { p256dh: "P", auth: "A" } }),
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type Options = {
	permission?: "default" | "granted" | "denied";
	subscription?: ReturnType<typeof subscriptionWith> | null;
	subscribe?: () => Promise<unknown>;
	userAgent?: string;
	standalone?: boolean;
	supported?: boolean;
	saveStatus?: number;
	vapidKey?: string;
};

/** A page with one control, the browser faked, and the script set up on it (the script's own setup is awaited). */
async function page(options: Options = {}) {
	const dom = new Dom();
	const control = drawControl(dom, options.vapidKey);
	const fresh = subscriptionWith(
		AS_PUBLIC,
		"https://push.example.test/send/fresh",
	);
	const subscribe = vi.fn(options.subscribe ?? (async () => fresh));
	const getSubscription = vi.fn(async () => options.subscription ?? null);
	const registration = { pushManager: { subscribe, getSubscription } };
	const register = vi.fn(async () => registration);
	const navigator = {
		serviceWorker: { register, ready: Promise.resolve(registration) },
		userAgent:
			options.userAgent ?? "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
		standalone: options.standalone,
	};
	const notification = { permission: options.permission ?? "default" };
	const window =
		options.supported === false
			? {}
			: { PushManager: class {}, Notification: class {} };
	const fetch = vi.fn(
		async () => new Response(null, { status: options.saveStatus ?? 201 }),
	);
	setupPush({
		document: dom,
		navigator,
		Notification: notification,
		fetch,
		matchMedia: () => ({ matches: false }),
		window,
	});
	await flush();
	return {
		dom,
		control,
		subscribe,
		getSubscription,
		register,
		fetch,
		notification,
		registration,
		navigator,
	};
}

/** Whether a state is shown on the control (its element is not hidden). */
const shown = (control: El, state: string) => {
	const el = control.querySelector(`[data-notify-state="${state}"]`);
	return el ? !el.hidden : false;
};

describe("the notify control on a page: what the browser already has", () => {
	it("shows nothing in a browser without Web Push", async () => {
		const { control, register } = await page({ supported: false });
		for (const state of ["off", "on", "iphone", "blocked"])
			expect(shown(control, state)).toBe(false);
		expect(register).not.toHaveBeenCalled();
	});

	it("shows the iPhone hint on an iPhone outside its Home Screen app", async () => {
		const { control } = await page({
			supported: false,
			userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)",
			standalone: false,
		});
		expect(shown(control, "iphone")).toBe(true);
		expect(shown(control, "off")).toBe(false);
	});

	it("shows nothing extra on an iPhone that opened Tally from its Home Screen", async () => {
		const { control } = await page({
			supported: false,
			userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)",
			standalone: true,
		});
		expect(shown(control, "iphone")).toBe(false);
	});

	it("shows On, and posts the subscription again, when a matching subscription exists with permission granted", async () => {
		const subscription = subscriptionWith(AS_PUBLIC);
		const { control, fetch, subscribe } = await page({
			permission: "granted",
			subscription,
		});
		expect(shown(control, "on")).toBe(true);
		expect(shown(control, "off")).toBe(false);
		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("/push/subscribe");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
			"application/x-www-form-urlencoded",
		);
		expect((init.body as URLSearchParams).get("endpoint")).toBe(
			subscription.endpoint,
		);
		expect(subscribe).not.toHaveBeenCalled();
	});

	it("shows On even when the quiet re-post fails, with no words of its own", async () => {
		const { control, dom } = await page({
			permission: "granted",
			subscription: subscriptionWith(AS_PUBLIC),
			saveStatus: 500,
		});
		expect(shown(control, "on")).toBe(true);
		expect(dom.sent("toast")).toEqual([]);
	});

	it("unsubscribes a subscription made with a different key, then shows Off", async () => {
		const subscription = subscriptionWith(OTHER_KEY);
		const { control, fetch } = await page({
			permission: "granted",
			subscription,
		});
		expect(subscription.unsubscribe).toHaveBeenCalledOnce();
		expect(shown(control, "off")).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("shows the quiet Blocked line when permission is denied, and asks for nothing", async () => {
		const { control, subscribe } = await page({ permission: "denied" });
		expect(shown(control, "blocked")).toBe(true);
		expect(subscribe).not.toHaveBeenCalled();
	});

	it("shows Off, not On, for a matching subscription when permission is not granted", async () => {
		const { control } = await page({
			permission: "default",
			subscription: subscriptionWith(AS_PUBLIC),
		});
		expect(shown(control, "off")).toBe(true);
		expect(shown(control, "on")).toBe(false);
	});

	it("reveals Off once the registration is ready", async () => {
		const { control, register, getSubscription } = await page();
		expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
		expect(getSubscription).toHaveBeenCalledOnce();
		expect(shown(control, "off")).toBe(true);
	});
});

describe("the notify control's tap", () => {
	it("calls subscribe in the click itself, before any await, with the page's key as bytes", async () => {
		const { dom, control, subscribe } = await page();
		const button = control.querySelector("[data-notify-on]");
		if (!button) throw new Error("no button");
		dom.click(button);
		expect(subscribe).toHaveBeenCalledOnce();
		const [options] = subscribe.mock.calls[0] as unknown as [
			{ userVisibleOnly: boolean; applicationServerKey: Uint8Array },
		];
		expect(options.userVisibleOnly).toBe(true);
		expect(options.applicationServerKey).toEqual(bytesOf(AS_PUBLIC));
		expect(options.applicationServerKey[0]).toBe(4);
	});

	it("posts a form of the subscription when granted, then shows On and moves focus to it", async () => {
		const { dom, control, fetch } = await page();
		dom.click(control.querySelector("[data-notify-on]") as El);
		await flush();
		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("/push/subscribe");
		const body = init.body as URLSearchParams;
		expect(body.get("endpoint")).toBe("https://push.example.test/send/fresh");
		expect(body.get("p256dh")).toBeTruthy();
		expect(body.get("auth")).toBeTruthy();
		expect(shown(control, "on")).toBe(true);
		expect(dom.focused).toEqual([
			control.querySelector('[data-notify-state="on"]'),
		]);
		expect(dom.sent("announce")).toEqual([]);
	});

	it("shows the busy state while the subscribe is pending, and clears it once saved", async () => {
		let finish: (value: unknown) => void = () => {};
		const { dom, control } = await page({
			subscribe: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		});
		const button = control.querySelector("[data-notify-on]") as El;
		dom.click(button);
		expect(button.disabled).toBe(true);
		expect(button.getAttribute("aria-busy")).toBe("true");
		expect(button.classes.has("htmx-request")).toBe(true);
		finish(subscriptionWith(AS_PUBLIC));
		await flush();
		expect(button.disabled).toBe(false);
		expect(button.getAttribute("aria-busy")).toBe("false");
		expect(button.classes.has("htmx-request")).toBe(false);
	});

	it("shows Blocked, inserts the alert and moves focus to the Blocked line when refused with permission denied", async () => {
		const { dom, control, notification } = await page({
			subscribe: async () => {
				notification.permission = "denied";
				throw new DOMException("denied", "NotAllowedError");
			},
		});
		dom.click(control.querySelector("[data-notify-on]") as El);
		await flush();
		expect(shown(control, "blocked")).toBe(true);
		const region = control.querySelector("[data-notify-alert]") as El;
		const alert = region.children[0] as El;
		expect(alert.tag).toBe("p");
		expect(alert.getAttribute("role")).toBe("alert");
		expect(alert.textContent).toBe(BLOCKED);
		expect(dom.focused).toEqual([
			control.querySelector('[data-notify-state="blocked"]'),
		]);
	});

	it("goes back to Off, keeps focus on the button and says nothing when the prompt is dismissed", async () => {
		const { dom, control } = await page({
			subscribe: async () => {
				throw new DOMException("dismissed", "NotAllowedError");
			},
		});
		const button = control.querySelector("[data-notify-on]") as El;
		dom.click(button);
		await flush();
		expect(shown(control, "off")).toBe(true);
		expect(button.disabled).toBe(false);
		expect(dom.focused).toEqual([button]);
		expect(dom.sent("announce")).toEqual([]);
		expect(dom.sent("toast")).toEqual([]);
	});

	it("unsubscribes and dispatches the toast with the existing words when the save fails", async () => {
		const subscribed = subscriptionWith(
			AS_PUBLIC,
			"https://push.example.test/send/bad",
		);
		const { dom, control } = await page({
			saveStatus: 500,
			subscribe: async () => subscribed,
		});
		dom.click(control.querySelector("[data-notify-on]") as El);
		await flush();
		expect(subscribed.unsubscribe).toHaveBeenCalledOnce();
		expect(shown(control, "off")).toBe(true);
		expect(dom.sent("toast")).toEqual([
			expect.objectContaining({
				detail: { message: COULDNT_SAVE, type: "error" },
			}),
		]);
	});

	it("keeps focus on the button after a failed save, so a keyboard user keeps their place", async () => {
		const { dom, control } = await page({
			saveStatus: 500,
			subscribe: async () => subscriptionWith(AS_PUBLIC),
		});
		const button = control.querySelector("[data-notify-on]") as El;
		// Enter or Space on a focused button is the keyboard's tap; the busy state then disables that focused button.
		button.focus();
		dom.click(button);
		await flush();
		expect(shown(control, "off")).toBe(true);
		expect(button.disabled).toBe(false);
		expect(dom.activeElement).toBe(button);
	});

	it("keeps focus on the button when the subscribe fails with permission still granted, and toasts the save words", async () => {
		const { dom, control } = await page({
			permission: "granted",
			subscribe: async () => {
				throw new DOMException("aborted", "AbortError");
			},
		});
		const button = control.querySelector("[data-notify-on]") as El;
		button.focus();
		dom.click(button);
		await flush();
		expect(shown(control, "off")).toBe(true);
		expect(button.disabled).toBe(false);
		expect(dom.activeElement).toBe(button);
		expect(dom.sent("toast")).toEqual([
			expect.objectContaining({
				detail: { message: COULDNT_SAVE, type: "error" },
			}),
		]);
	});

	it("leaves focus where the person moved it when a failed save ends, rather than taking it back", async () => {
		const { dom, control } = await page({
			saveStatus: 500,
			subscribe: async () => subscriptionWith(AS_PUBLIC),
		});
		const button = control.querySelector("[data-notify-on]") as El;
		button.focus();
		dom.click(button);
		// The person tabs to a link while the save is out, so focus is on something of theirs.
		const elsewhere = dom.createElement("a");
		dom.root.append(elsewhere);
		elsewhere.focus();
		await flush();
		expect(dom.activeElement).toBe(elsewhere);
	});

	it("announces On, and does not focus, when the control has left the page while the tap was saved", async () => {
		const { dom, control } = await page();
		dom.click(control.querySelector("[data-notify-on]") as El);
		control.remove();
		await flush();
		expect(dom.focused).toEqual([]);
		expect(dom.sent("announce")).toEqual([
			expect.objectContaining({ detail: { value: ON } }),
		]);
	});
});

describe("the notify control's setup on a page", () => {
	it("moves no focus and announces nothing on setup", async () => {
		const { dom } = await page({
			permission: "granted",
			subscription: subscriptionWith(AS_PUBLIC),
		});
		expect(dom.focused).toEqual([]);
		expect(dom.sent("announce")).toEqual([]);
	});

	it("sets up a control drawn by a swap, once, when htmx finishes processing it", async () => {
		const { dom, getSubscription } = await page();
		const before = getSubscription.mock.calls.length;
		const swapped = drawControl(dom);
		dom.dispatchEvent({ type: "htmx:after:process", target: swapped });
		await flush();
		expect(getSubscription.mock.calls.length).toBe(before + 1);
		expect(swapped.hasAttribute("data-notify-ready")).toBe(true);
	});

	it("does not set a control up twice, however often htmx processes the page", async () => {
		const { dom, getSubscription } = await page();
		const calls = getSubscription.mock.calls.length;
		dom.dispatchEvent({ type: "htmx:after:process" });
		dom.dispatchEvent({ type: "htmx:after:process" });
		await flush();
		expect(getSubscription.mock.calls.length).toBe(calls);
	});
});

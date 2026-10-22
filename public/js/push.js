// The notify control's script (decision 148): Web Push for a new family's first questions. The browser asks for permission only
// in a tap, so the tap's first call is the subscribe. The control is found by [data-notify] alone, so a page that draws it
// (Home now, /setup later, #772) needs no change here. Setup is quiet and idempotent: it never moves focus, never announces, and
// costs nothing on the 5-second poll (only a node not yet set up is touched). Text is set with textContent, never HTML.

const SW_URL = "/sw.js";
const SUBSCRIBE_URL = "/push/subscribe";
const COULDNT_SAVE = "Couldn't save. Check your connection and try again.";
const ON_WORDS = "Notifications are on for this device.";
const BLOCKED_WORDS =
	"Notifications are blocked for Tally in this device's settings.";

/** The VAPID public key's bytes, from its base64url text. */
function keyBytes(text) {
	const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
	const padded = base64.padEnd(
		base64.length + ((4 - (base64.length % 4)) % 4),
		"=",
	);
	return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

/** A binary value as base64url without padding, as the subscribe route reads it. */
function base64Url(buffer) {
	let binary = "";
	for (const byte of new Uint8Array(buffer))
		binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

/** True when two binary values hold the same bytes (a subscription's key against the page's). */
function sameBytes(first, second) {
	if (!first || !second) return false;
	const a = new Uint8Array(first);
	const b = new Uint8Array(second);
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Sets up the notify control on a page. Each argument is the browser's own (passed in so tests can fake them). It runs once
 * now and again after each htmx swap, for each control not yet set up.
 */
export function setupPush({
	document,
	navigator,
	Notification,
	fetch,
	matchMedia,
	window,
}) {
	// The registration is made once, and each control waits for it. Nothing is asked: registering a worker is silent.
	let registration = null;
	let registering = null;
	const register = () => {
		registering ??= navigator.serviceWorker
			.register(SW_URL, { scope: "/" })
			.then(() => navigator.serviceWorker.ready)
			.then((ready) => {
				registration = ready;
				return ready;
			});
		return registering;
	};

	const supported = () =>
		"serviceWorker" in navigator &&
		"PushManager" in window &&
		"Notification" in window;
	const onIPhone = () =>
		/iPhone|iPod/.test(navigator.userAgent) &&
		navigator.standalone !== true &&
		!matchMedia("(display-mode: standalone)").matches;

	/** Shows one state of the control and hides the others (each state carries data-notify-state). */
	const showState = (node, state) => {
		for (const element of node.querySelectorAll("[data-notify-state]"))
			element.hidden = element.getAttribute("data-notify-state") !== state;
	};

	/** The button's busy look, set on the element itself, as plaid-link.js does (Button's busyLabel shows through htmx-request). */
	const setBusy = (node, busy) => {
		const button = node.querySelector("[data-notify-on]");
		if (!button) return;
		button.disabled = busy;
		button.setAttribute("aria-busy", String(busy));
		button.classList.toggle("htmx-request", busy);
	};

	const focusOn = (node, state) =>
		node.querySelector(`[data-notify-state="${state}"]`)?.focus();

	const announce = (value) =>
		document.dispatchEvent(new CustomEvent("announce", { detail: { value } }));
	const toast = (message) =>
		document.dispatchEvent(
			new CustomEvent("toast", { detail: { message, type: "error" } }),
		);

	/** The one-line alert for a refused tap: a fresh paragraph, so a screen reader reads it when it lands. */
	const alertBlocked = (node) => {
		const region = node.querySelector("[data-notify-alert]");
		if (!region) return;
		const alert = document.createElement("p");
		alert.setAttribute("role", "alert");
		alert.textContent = BLOCKED_WORDS;
		region.replaceChildren(alert);
	};

	/** The subscription's keys, from getKey (or the JSON's keys where getKey is absent). */
	const keysOf = (subscription) => {
		if (typeof subscription.getKey === "function")
			return {
				p256dh: base64Url(subscription.getKey("p256dh")),
				auth: base64Url(subscription.getKey("auth")),
			};
		return subscription.toJSON().keys;
	};

	/**
	 * Stores a device: a form post, so Hono's csrf check applies. A tap stores it for the person who tapped. A page load's quiet
	 * re-post (`restore`) only brings back a lost row, and the server never moves a device to whoever is looking at it (decision 148).
	 */
	const save = (subscription, { restore = false } = {}) => {
		const keys = keysOf(subscription);
		const body = new URLSearchParams({
			endpoint: subscription.endpoint,
			p256dh: keys.p256dh,
			auth: keys.auth,
		});
		if (restore) body.set("restore", "1");
		return fetch(SUBSCRIBE_URL, {
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
		});
	};

	/** Focus is on nothing, or on the body: a busy button that had it was disabled, and a browser drops it there (toast.js's #460). */
	const focusLost = () => {
		const active = document.activeElement;
		return !active || active === document.body;
	};

	/** The tap did not finish: the control is Off again with its button usable, and focus is back on the button if a busy one lost it. */
	const backToOff = (node) => {
		setBusy(node, false);
		showState(node, "off");
		if (focusLost()) node.querySelector("[data-notify-on]")?.focus();
	};

	/** The tap's subscription was made: store it, then show On (or, if the control has left the page, announce it). */
	const subscribed = async (subscription) => {
		let saved = false;
		try {
			saved = (await save(subscription)).ok;
		} catch {
			saved = false;
		}
		if (!saved) {
			await subscription.unsubscribe().catch(() => {});
			const live = document.querySelector("[data-notify]");
			if (live) backToOff(live);
			toast(COULDNT_SAVE);
			return;
		}
		const live = document.querySelector("[data-notify]");
		if (live) {
			setBusy(live, false);
			showState(live, "on");
			focusOn(live, "on");
		} else announce(ON_WORDS);
	};

	/** The tap's subscription was refused or failed: blocked, dismissed, or any other failure, each said as the design says. */
	const refused = () => {
		const live = document.querySelector("[data-notify]");
		if (!live) return;
		setBusy(live, false);
		if (Notification.permission === "denied") {
			showState(live, "blocked");
			alertBlocked(live);
			focusOn(live, "blocked");
			return;
		}
		if (Notification.permission === "default") {
			// Dismissed: the button is usable again, focus stays on it, and nothing is announced.
			showState(live, "off");
			live.querySelector("[data-notify-on]")?.focus();
			return;
		}
		backToOff(live);
		toast(COULDNT_SAVE);
	};

	/**
	 * The tap. Its first call is the subscribe, with no await before it: the browser asks for permission only inside the
	 * gesture's own handler, and in every browser that call is what asks (Apple: call it immediately from the event handler).
	 */
	const tap = (node) => {
		const key = keyBytes(node.getAttribute("data-vapid-key") ?? "");
		let pending;
		try {
			pending = registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: key,
			});
		} catch (error) {
			pending = Promise.reject(error);
		}
		setBusy(node, true);
		pending.then(subscribed, refused);
	};

	/** Sets up one control: its state from what the browser already has, once the registration is ready. */
	const setUp = async (node) => {
		node.setAttribute("data-notify-ready", "");
		if (!supported()) {
			if (onIPhone()) showState(node, "iphone");
			return;
		}
		try {
			await register();
		} catch {
			return;
		}
		if (Notification.permission === "denied") {
			showState(node, "blocked");
			return;
		}
		const key = keyBytes(node.getAttribute("data-vapid-key") ?? "");
		const subscription = await registration.pushManager.getSubscription();
		if (
			subscription &&
			!sameBytes(subscription.options?.applicationServerKey, key)
		)
			// The keys were changed: a subscription made with the old key can't receive, so it goes.
			await subscription.unsubscribe().catch(() => {});
		else if (subscription && Notification.permission === "granted") {
			showState(node, "on");
			// Quietly stored again, so the server's row comes back if it was lost. A failure shows nothing extra.
			save(subscription, { restore: true }).catch(() => {});
			return;
		}
		showState(node, "off");
	};

	/** Sets up each control on the page that is not set up yet. */
	const setUpAll = () => {
		for (const node of document.querySelectorAll("[data-notify]"))
			if (!node.hasAttribute("data-notify-ready")) setUp(node);
	};

	document.addEventListener("click", (event) => {
		if (!event.target?.closest?.("[data-notify-on]")) return;
		const live = document.querySelector("[data-notify]");
		if (live && registration) tap(live);
	});
	document.addEventListener("htmx:after:process", setUpAll);
	setUpAll();
}

if (typeof document !== "undefined") {
	setupPush({
		document,
		navigator,
		Notification: globalThis.Notification,
		fetch,
		matchMedia: (query) => window.matchMedia(query),
		window,
	});
}

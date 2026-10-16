// Shows HX-Trigger "toast" messages and speaks "announce" messages to screen readers.
// Text only (textContent), never HTML.
// A request that fails says so too (spec §8.5, decision 72): see the htmx:error listeners below. A switch whose
// auto-save fails goes back to how the page drew it, when its form carries data-switches-revert.
(() => {
	const DISPLAY_MS = 4000;
	const SVG_NS = "http://www.w3.org/2000/svg";
	const COULDNT_SAVE = "Couldn't save. Check your connection and try again.";
	const COULDNT_LOAD = "Couldn't load. Check your connection and try again.";
	// The alert icon from src/views/icons.tsx (test/toast-js.test.ts checks they match).
	const ALERT_PATHS = [
		"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
		"M12 9v4",
		"M12 17h.01",
	];

	// An error is never colour alone: the alert icon, in the over token, comes before the words.
	function alertIcon() {
		const icon = document.createElement("span");
		icon.className = "shrink-0 text-over";
		const svg = document.createElementNS(SVG_NS, "svg");
		svg.setAttribute("class", "size-5");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "1.75");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		svg.setAttribute("aria-hidden", "true");
		for (const d of ALERT_PATHS) {
			const path = document.createElementNS(SVG_NS, "path");
			path.setAttribute("d", d);
			svg.append(path);
		}
		icon.append(svg);
		return icon;
	}

	// The Undo toasts on screen, each with the token its Undo posts. A newer plain or error toast never removes
	// one of them early; only an Undo's answer ends the one it answers (undoDone, below).
	const undoToasts = new WeakMap();
	// Each Undo form's button and toast, so a failed Undo request can turn its button back on while its
	// toast is still up (the error toast says to try again).
	const undoButtons = new WeakMap();

	// Toasts clear Select mode's action bar by its measured height, set on #toasts. (The toasts' own
	// height goes on the root element instead: see measureToasts.) htmx 4 fires HX-Trigger after
	// `await this.swap(ctx)`, so the bar measured is the swapped-in one. The observer's callback only
	// measures again: calling observe() there would repeat its first notification every frame.
	function measureSelectionBar() {
		const region = document.getElementById("toasts");
		if (!region) return;
		const bar = document.getElementById("selection-bar");
		if (bar)
			region.style.setProperty(
				"--selection-bar-height",
				`${bar.offsetHeight}px`,
			);
		else region.style.removeProperty("--selection-bar-height");
	}
	// The bar wraps to more rows on a narrow phone, and rotating a phone changes its width.
	const barSize =
		typeof ResizeObserver === "function"
			? new ResizeObserver(measureSelectionBar)
			: null;

	// A phone sheet leaves room above it for the toasts on screen: app.css's --toast-top-room reads
	// --toasts-height from the root element, so the height is set there, not on #toasts or the body.
	// It's removed when no toast shows, and the sheet keeps its floor.
	function measureToasts() {
		const region = document.getElementById("toasts");
		if (!region) return;
		if (region.children.length)
			document.documentElement.style.setProperty(
				"--toasts-height",
				`${region.offsetHeight}px`,
			);
		else document.documentElement.style.removeProperty("--toasts-height");
	}
	// Toasts wrap to more lines when they're long, and rotating a phone changes their width. This is a
	// second observer, not barSize, since barSize is disconnected on every toast. Each observer follows
	// the node on the page now: a body swap or a history restore replaces #toasts, and a list change can
	// swap in a new Select bar. The callback only measures again, since calling observe() there would
	// repeat its first notification every frame.
	const toastsSize =
		typeof ResizeObserver === "function"
			? new ResizeObserver(measureToasts)
			: null;

	// The heading that takes focus when a toast hands it back. While a sheet is open the page behind it is inert,
	// so the sheet's own title takes it (its heading, not its first control: sheet.js's Tab goes on from the heading
	// to the sheet's first stop). With no sheet, the Transactions heading takes it (every Transactions page has one,
	// the first-visit page too), and a page without it, a bill's page, takes focus on its own page-title.
	function focusHeading() {
		// The open sheet is the first one with no inert ancestor: a drawing (the catalog's) sits inside one.
		const sheet = [...document.querySelectorAll("section[data-sheet]")].find(
			(node) => !node.closest("[inert]"),
		);
		const heading =
			(sheet &&
				document.getElementById(sheet.getAttribute("aria-labelledby"))) ??
			document.getElementById("transactions-title") ??
			document.getElementById("page-title");
		if (heading) {
			if (!heading.hasAttribute("tabindex"))
				heading.setAttribute("tabindex", "-1");
			heading.focus();
		}
	}
	// Focus is on nothing: a disabled Undo button drops it to the body.
	function focusLost() {
		const active = document.activeElement;
		return !active || active === document.body;
	}

	// Takes a toast off the page. Focus on the toast would be lost with it, so the heading takes it (focusHeading: the
	// open sheet's title, while a sheet is open). `lostToo` also counts focus on nothing: an Undo's answer (undoDone: a
	// restore's, or a cash or bill Undo's refusal) uses it.
	// A timer doesn't, since it would scroll the page to the heading when focus is only on the body. An answer or a
	// failure that arrives after the time has run out still moves focus left on nothing to the heading (onToast's
	// undoDone block and failed()).
	function takeOffPage(toast, lostToo = false) {
		if (toast.contains(document.activeElement) || (lostToo && focusLost()))
			focusHeading();
		toast.remove();
		measureToasts();
	}

	// The toast the last "toast" event made. failed() reads it straight after dispatching, since the
	// event is synchronous.
	let lastToast = null;
	// Both events are heard on document. htmx sends each HX-Trigger event from its request's element, or from
	// document once that element has left the page: an Undo form whose toast ends during the restore's own
	// triggers (#397). plaid-link.js sends announce from the body, and it bubbles up to document.
	const onToast = (event) => {
		const {
			message,
			type = "success",
			undo,
			undoExpiresInMs,
			undoDone,
			// Where the Undo posts: the cash-delete Undo unless the toast names another (a Not this one's, #340).
			undoAction = "/transactions/undo-cash-delete",
		} = event.detail ?? {};
		if (!message) return;
		if (undo && !(undoExpiresInMs > 0)) return;
		const toast = document.createElement("div");
		lastToast = toast;
		// An Undo toast's button, focused once the toast is on the page (see the undo block below).
		let undoButton = null;
		toast.className = `${undo ? "undo-toast " : ""}min-w-0 max-w-full wrap-anywhere rounded-control border border-rule bg-paper px-4 py-3 text-sm text-ink shadow-sm`;
		toast.setAttribute("role", type === "error" ? "alert" : "status");
		if (type === "error") {
			toast.className += " flex items-start gap-2";
			const words = document.createElement("span");
			words.textContent = message;
			toast.append(alertIcon(), words);
		} else if (undo) {
			const words = document.createElement("span");
			words.textContent = message;
			toast.append(words);
			toast.className +=
				" pointer-events-auto flex items-center justify-center gap-4";
			const form = document.createElement("form");
			form.method = "post";
			form.action = undoAction;
			form.setAttribute("hx-post", form.action);
			form.setAttribute("hx-target", "#page");
			form.setAttribute("hx-select", "#page");
			form.setAttribute("hx-swap", "outerHTML");
			for (const [name, value] of Object.entries({
				token: undo,
				back: location.pathname + location.search,
			})) {
				const input = document.createElement("input");
				input.type = "hidden";
				input.name = name;
				input.value = value;
				form.append(input);
			}
			const button = document.createElement("button");
			button.type = "submit";
			button.className = "min-h-11 px-2 font-medium underline";
			button.textContent = "Undo";
			// keyboard.js presses this with u while the toast shows (decision 118, #516).
			button.setAttribute("aria-keyshortcuts", "u");
			form.addEventListener("submit", () => {
				button.disabled = true;
			});
			undoButtons.set(form, { button, toast });
			form.append(button);
			undoButton = button;
			toast.append(form);
		} else {
			toast.textContent = message;
		}
		// Only the newest plain or error toast shows: it takes the place of the ones before it. An Undo
		// toast is never removed early, so a newer toast leaves it to run its own time.
		const region = document.getElementById("toasts");
		if (!undo)
			for (const old of [...(region?.children ?? [])]) {
				if (!undoToasts.has(old)) old.remove();
			}
		// The one exception: an Undo's answer names the Undo toast it answers, and that one ends now. A successful
		// Undo's toast ends its Deleted toast, since the entry is back (#397), and a refusal ends its toast too, a
		// cash entry's (#444) or a bill's (#340). The other Undo toasts run their own time. If the Undo toast's time
		// has already run out, focus left on nothing still moves to the heading (#444).
		if (undoDone) {
			const ended = [...(region?.children ?? [])].filter(
				(old) => undoToasts.get(old) === undoDone,
			);
			if (ended.length) for (const old of ended) takeOffPage(old, true);
			else if (focusLost()) focusHeading();
		}
		measureSelectionBar();
		region?.append(toast);
		// Measured after the append, so the older toasts just replaced are gone and this one is in.
		measureToasts();
		// Follow the #toasts on the page now, since a body swap can have replaced it.
		toastsSize?.disconnect();
		if (region) toastsSize?.observe(region);
		// Follow the bar that is on the page now, since a list change can have swapped it in.
		barSize?.disconnect();
		const bar = document.getElementById("selection-bar");
		if (bar) barSize?.observe(bar);
		if (undo) {
			undoToasts.set(toast, undo);
			window.htmx?.process(toast);
			// A property, not a style attribute: the page's CSP (style-src 'self') refuses the attribute.
			toast.style.setProperty(
				"--duration-undo-toast",
				`${Math.min(10_000, undoExpiresInMs)}ms`,
			);
			// The swap that removed the delete's sheet left focus nowhere, so focus moves to Undo and a keyboard
			// user can press it at once. The HX-Trigger runs after the swap (htmx's finally), so this wins over
			// any autofocus the swap set.
			undoButton?.focus();
		}
		setTimeout(
			() => takeOffPage(toast),
			undo ? Math.min(10_000, undoExpiresInMs) : DISPLAY_MS,
		);
	};
	document.addEventListener("toast", onToast);

	const onAnnounce = (event) => {
		const region = document.getElementById("announcer");
		const message = event.detail?.value;
		if (!region || !message) return;
		region.textContent = "";
		requestAnimationFrame(() => {
			region.textContent = message;
		});
	};
	document.addEventListener("announce", onAnnounce);

	// A failed request shows an error toast, and the page is left as it is, so an open sheet keeps
	// what was typed (a switch's form is the one exception: failed() resets it to the drawn state).
	// htmx 4's names: htmx:error is a request that never got an answer (the network
	// dropped, or it timed out); htmx:response:error is any 4xx or 5xx reply, and only a 500 is a failure here: it's
	// what an unhandled error sends, and Layout's noSwap keeps it out of the page. Every other 4xx
	// and 5xx carries its own message on purpose, such as a field's error (422) or a bank that
	// couldn't be reached (502), so it's swapped in and says its own words. The words follow what
	// was being done: a GET (a filter, opening a sheet) couldn't load; anything else couldn't save.
	// The events go to document, because htmx sends them there when their element has left the
	// page. Several at once (queued taps on a dead connection) show one toast, not a stack: an
	// identical failure within a second is dropped only while its own toast is still on screen. Once
	// another toast has replaced it, or a body swap has removed it, the failure is said again. So a
	// retry that fails a couple of seconds later is a new failure too: it replaces the toast with a
	// fresh alert (a screen reader hears it again) and a fresh 4 seconds.
	// A button that a form's hx-disable turned off for the request is focused again once htmx turns it back
	// on (see htmx:finally:request), so a keyboard user keeps their place after a failure (#460).
	const BURST_MS = 1000;
	// The newest failure: its words, when it was said, and its toast. One record is enough, since only
	// the newest plain or error toast is ever on screen.
	let lastFailure = null;
	// The guarded button each failed request sent, keyed by the request's ctx.
	const guardedButtons = new WeakMap();
	function failed(ctx) {
		// A switch whose auto-save failed goes back to how the page drew it (#606): its form opts in with
		// data-switches-revert, and reset() puts each control back to its drawn (default) state. Other forms keep what
		// was typed (decision 72). The request's form is set by htmx; a switch's closest form covers a request without one.
		const form = ctx?.request?.form ?? ctx?.sourceElement?.closest?.("form");
		if (form?.hasAttribute?.("data-switches-revert")) form.reset();
		if (
			ctx?.sourceElement?.hasAttribute?.("hx-disable") &&
			ctx.request?.submitter
		)
			guardedButtons.set(ctx, ctx.request.submitter);
		// An Undo request that failed turns its button back on while its toast is still up: the error toast
		// says to try again. The request's source element is the Undo form (htmx 4's ctx.sourceElement).
		const undo = undoButtons.get(ctx?.sourceElement);
		if (undo && document.getElementById("toasts")?.contains(undo.toast)) {
			undo.button.disabled = false;
			// Focus was on Undo when it was pressed, and a disabled button dropped it, so it comes back to Undo (#397).
			// Not when the person has moved it somewhere else during the request.
			if (focusLost() || undo.toast.contains(document.activeElement))
				undo.button.focus();
		} else if (undo && focusLost()) {
			// The toast's time ran out while this Undo was being answered (#444): focus left on nothing goes to the heading.
			focusHeading();
		}
		const message =
			String(ctx?.request?.method).toUpperCase() === "GET"
				? COULDNT_LOAD
				: COULDNT_SAVE;
		// The page's own clock, not the device's: a clock moved back must not silence later failures.
		const now = performance.now();
		if (
			lastFailure?.message === message &&
			now - lastFailure.at < BURST_MS &&
			document.getElementById("toasts")?.contains(lastFailure.toast)
		)
			return;
		document.dispatchEvent(
			new CustomEvent("toast", { detail: { message, type: "error" } }),
		);
		lastFailure = { message, at: now, toast: lastToast };
	}
	// htmx 4 aborts a request that timed out exactly as it aborts one that was replaced (hx-sync) or
	// cancelled (htmx:abort): ctx.request.abort(), an AbortError with no reason and no timeout event
	// of its own. So Layout turns htmx's own timeout off (defaultTimeout: 0) and the 60 seconds are
	// kept here: when a request's timer fires it is marked as timed out, then aborted, and only a
	// marked request's AbortError is a failure. The timer stops when the request ends.
	const REQUEST_TIMEOUT_MS = 60000;
	const timers = new Map();
	const timedOut = new WeakSet();
	document.addEventListener("htmx:before:request", (event) => {
		const ctx = event.detail?.ctx;
		if (!ctx) return;
		clearTimeout(timers.get(ctx));
		timers.set(
			ctx,
			setTimeout(() => {
				timedOut.add(ctx);
				ctx.request?.abort?.();
			}, REQUEST_TIMEOUT_MS),
		);
	});
	document.addEventListener("htmx:finally:request", (event) => {
		const ctx = event.detail?.ctx;
		if (!ctx) return;
		clearTimeout(timers.get(ctx));
		timers.delete(ctx);
		const button = guardedButtons.get(ctx);
		if (button) {
			guardedButtons.delete(ctx);
			// htmx turns the guarded buttons back on right after this event, in the same turn, so the focus waits
			// for that turn to end. It checks the button then: a button another request still holds disabled stays
			// disabled (htmx counts its disables) and is not focused, nor one that has left the page, nor one the
			// person has moved focus away from.
			queueMicrotask(() => {
				const active = document.activeElement;
				if (
					button.isConnected &&
					!button.disabled &&
					(!active || active === document.body)
				)
					button.focus();
			});
		}
	});
	// Older and Newer in Select mode (#456): the reply's first tick is autofocus, but the rows stay hidden until the
	// load ends, so the tick is focused on the next frame. Only a list htmx swapped in counts: a count's reply, or a
	// 500 that Layout's noSwap keeps out, leaves focus alone. And only when focus went with the replaced page link:
	// a person who moved to a filter during the load stays there.
	document.addEventListener("htmx:finally:request", (event) => {
		const ctx = event.detail?.ctx;
		if (
			ctx?.status !== "swapped" ||
			ctx.swap === "none" ||
			ctx.target?.id !== "results"
		)
			return;
		const list = ctx.target;
		requestAnimationFrame(() => {
			if (!focusLost()) return;
			list.querySelector("input[name=ids][autofocus]")?.focus();
		});
	});
	// Select all's focus across a count reply (#475). The link and the count's stand-in for it (drawn when no link is)
	// share the id select-all-link. htmx puts focus back by that id as each task of a swap lands, and the count's own
	// swap lands before the link's wrapper, so a link the count draws again finds nothing and focus falls to the body.
	// So a swap that began with focus on Select all gives it back to Select all once the swap has ended: the link, or
	// the stand-in if that is what the reply drew. A swap that began with focus anywhere else (a mouse click that left
	// it on the body, or a person who moves it during the reply) leaves focus alone.
	const selectAllSwaps = new WeakSet();
	document.addEventListener("htmx:before:swap", (event) => {
		const ctx = event.detail?.ctx;
		if (ctx && document.activeElement?.id === "select-all-link")
			selectAllSwaps.add(ctx);
	});
	document.addEventListener("htmx:after:swap", (event) => {
		const ctx = event.detail?.ctx;
		if (!ctx || !selectAllSwaps.has(ctx) || !focusLost()) return;
		document.getElementById("select-all-link")?.focus({ preventScroll: true });
	});
	document.addEventListener("htmx:error", (event) => {
		const { ctx, error } = event.detail ?? {};
		// Only a request has a ctx; htmx also reports a bug in someone's hx-on handler this way.
		if (!ctx) return;
		// A request replaced by a newer one, or cancelled, is not a failure; a timeout is.
		if (error?.name === "AbortError" && !timedOut.has(ctx)) return;
		failed(ctx);
	});
	document.addEventListener("htmx:response:error", (event) => {
		const { ctx } = event.detail ?? {};
		if (ctx?.response?.status === 500) failed(ctx);
	});

	// A normal form redirect carries the same feedback as an HTMX response.
	const query = new URLSearchParams(location.search);
	const sent = query.get("sent");
	if (sent === "feedback") {
		const message = "Thanks. Sent.";
		document.dispatchEvent(new CustomEvent("toast", { detail: { message } }));
		document.dispatchEvent(
			new CustomEvent("announce", { detail: { value: message } }),
		);
		query.delete("sent");
		const search = query.toString();
		history.replaceState(
			null,
			"",
			`${location.pathname}${search ? `?${search}` : ""}${location.hash}`,
		);
	}
})();

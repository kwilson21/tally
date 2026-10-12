// Shows HX-Trigger "toast" messages and speaks "announce" messages to screen readers.
// Text only (textContent), never HTML.
// A request that fails says so too (spec §8.5, decision 72): see the htmx:error listeners below.
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

	// Takes a toast off the page. Focus on the toast would be lost with it, so the Transactions heading takes it
	// (every Transactions page has one, the first-visit page too). `lostToo` also counts focus on nothing: a
	// disabled Undo button drops focus to the body, so an Undo's answer (undoDone: a restore's, or a bill Undo's
	// refusal) uses it. A timer doesn't, since it would scroll the page to the heading when focus is only on the body.
	function takeOffPage(toast, lostToo = false) {
		const active = document.activeElement;
		if (
			toast.contains(active) ||
			(lostToo && (!active || active === document.body))
		) {
			// A page without the Transactions title (a bill's page) takes focus on its own page-title.
			const heading =
				document.getElementById("transactions-title") ??
				document.getElementById("page-title");
			if (heading) {
				heading.setAttribute("tabindex", "-1");
				heading.focus();
			}
		}
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
		// Undo's toast ends its Deleted toast, since the entry is back (#397), and a bill Undo's refusal ends its
		// toast too (#340). The other Undo toasts run their own time.
		if (undoDone)
			for (const old of [...(region?.children ?? [])]) {
				if (undoToasts.get(old) === undoDone) takeOffPage(old, true);
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
	// what was typed. htmx 4's names: htmx:error is a request that never got an answer (the network
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
	const BURST_MS = 1000;
	// The newest failure: its words, when it was said, and its toast. One record is enough, since only
	// the newest plain or error toast is ever on screen.
	let lastFailure = null;
	function failed(ctx) {
		// An Undo request that failed turns its button back on while its toast is still up: the error toast
		// says to try again. The request's source element is the Undo form (htmx 4's ctx.sourceElement).
		const undo = undoButtons.get(ctx?.sourceElement);
		if (undo && document.getElementById("toasts")?.contains(undo.toast)) {
			undo.button.disabled = false;
			// Focus was on Undo when it was pressed, and a disabled button dropped it, so it comes back to Undo (#397).
			// Not when the person has moved it somewhere else during the request.
			const active = document.activeElement;
			if (!active || active === document.body || undo.toast.contains(active))
				undo.button.focus();
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

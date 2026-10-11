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

	// The Undo toasts on screen. A newer plain or error toast never removes one of them early.
	const undoToasts = new WeakSet();

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

	// The toast the last "toast" event made. failed() reads it straight after dispatching, since the
	// event is synchronous.
	let lastToast = null;
	document.body.addEventListener("toast", (event) => {
		const {
			message,
			type = "success",
			undo,
			undoExpiresInMs,
		} = event.detail ?? {};
		if (!message) return;
		if (undo && !(undoExpiresInMs > 0)) return;
		const toast = document.createElement("div");
		lastToast = toast;
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
			form.action = "/transactions/undo-cash-delete";
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
			form.append(button);
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
			undoToasts.add(toast);
			window.htmx?.process(toast);
			toast.setAttribute(
				"style",
				`--duration-undo-toast: ${Math.min(10_000, undoExpiresInMs)}ms`,
			);
		}
		setTimeout(
			() => {
				// Focus on Undo would be lost with the toast, so the list's result count takes it, or the
				// page's title when the list has no count (the first-visit list).
				if (toast.contains(document.activeElement)) {
					const target =
						document.getElementById("result-count") ??
						document.getElementById("transactions-title");
					if (target) {
						target.setAttribute("tabindex", "-1");
						target.focus();
					}
				}
				toast.remove();
				measureToasts();
			},
			undo ? Math.min(10_000, undoExpiresInMs) : DISPLAY_MS,
		);
	});

	document.body.addEventListener("announce", (event) => {
		const region = document.getElementById("announcer");
		const message = event.detail?.value;
		if (!region || !message) return;
		region.textContent = "";
		requestAnimationFrame(() => {
			region.textContent = message;
		});
	});

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
		document.body.dispatchEvent(
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
		document.body.dispatchEvent(
			new CustomEvent("toast", { detail: { message } }),
		);
		document.body.dispatchEvent(
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

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

	document.body.addEventListener("toast", (event) => {
		const { message, type = "success", undo } = event.detail ?? {};
		if (!message) return;
		const toast = document.createElement("div");
		toast.className = undo
			? "undo-toast rounded-control border border-rule bg-paper px-4 py-3 text-sm text-ink shadow-sm"
			: "rounded-control border border-rule bg-paper px-4 py-3 text-sm text-ink shadow-sm";
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
			form.append(button);
			toast.append(form);
		} else {
			toast.textContent = message;
		}
		document.getElementById("toasts")?.append(toast);
		if (undo) window.htmx?.process(toast);
		const undoDuration = getComputedStyle(toast).getPropertyValue(
			"--duration-undo-toast",
		);
		setTimeout(
			() => toast.remove(),
			undo ? Number.parseFloat(undoDuration) * 1000 : DISPLAY_MS,
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
	// page. Several at once (queued taps on a dead connection) show each message once, not a stack.
	// "At once" is a second: a retry that fails again a couple of seconds later is a new failure, so
	// it replaces the toast with a fresh alert (a screen reader hears it again) and a fresh 4 seconds.
	const BURST_MS = 1000;
	const failedAt = new Map();
	function failed(ctx) {
		const message =
			String(ctx?.request?.method).toUpperCase() === "GET"
				? COULDNT_LOAD
				: COULDNT_SAVE;
		// The page's own clock, not the device's: a clock moved back must not silence later failures.
		const now = performance.now();
		if (now - (failedAt.get(message) ?? -Infinity) < BURST_MS) return;
		failedAt.set(message, now);
		const toasts = document.getElementById("toasts");
		for (const toast of [...(toasts?.children ?? [])]) {
			if (toast.textContent === message) toast.remove();
		}
		document.body.dispatchEvent(
			new CustomEvent("toast", { detail: { message, type: "error" } }),
		);
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

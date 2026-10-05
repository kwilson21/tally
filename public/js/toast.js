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
		const { message, type = "success" } = event.detail ?? {};
		if (!message) return;
		const toast = document.createElement("p");
		toast.className =
			"rounded-control border border-rule bg-paper px-4 py-3 text-sm text-ink shadow-sm";
		toast.setAttribute("role", type === "error" ? "alert" : "status");
		if (type === "error") {
			toast.className += " flex items-start gap-2";
			const words = document.createElement("span");
			words.textContent = message;
			toast.append(alertIcon(), words);
		} else {
			toast.textContent = message;
		}
		document.getElementById("toasts")?.append(toast);
		setTimeout(() => toast.remove(), DISPLAY_MS);
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
	const showing = new Set();
	function failed(ctx) {
		const message =
			String(ctx?.request?.method).toUpperCase() === "GET"
				? COULDNT_LOAD
				: COULDNT_SAVE;
		if (showing.has(message)) return;
		showing.add(message);
		setTimeout(() => showing.delete(message), DISPLAY_MS);
		document.body.dispatchEvent(
			new CustomEvent("toast", { detail: { message, type: "error" } }),
		);
	}
	// htmx 4 aborts a request that timed out exactly as it aborts one that was replaced (hx-sync) or
	// cancelled (htmx:abort): an AbortError with no reason and no timeout event of its own. So a
	// timeout is known by how long the request ran: as long as its limit, less a second's slack.
	const startedAt = new WeakMap();
	document.addEventListener("htmx:before:request", (event) => {
		const ctx = event.detail?.ctx;
		if (ctx) startedAt.set(ctx, Date.now());
	});
	function timedOut(ctx) {
		const started = startedAt.get(ctx);
		const own = ctx.request?.timeout;
		const { htmx } = globalThis;
		const limit =
			Number(
				own != null ? htmx?.parseInterval(own) : htmx?.config.defaultTimeout,
			) || 0;
		return (
			started !== undefined && limit > 0 && Date.now() - started >= limit - 1000
		);
	}
	document.addEventListener("htmx:error", (event) => {
		const { ctx, error } = event.detail ?? {};
		// Only a request has a ctx; htmx also reports a bug in someone's hx-on handler this way.
		if (!ctx) return;
		// A request replaced by a newer one, or cancelled, is not a failure; a timeout is.
		if (error?.name === "AbortError" && !timedOut(ctx)) return;
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

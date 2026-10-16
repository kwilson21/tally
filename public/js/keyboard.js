// Keyboard shortcuts (#72, decisions 109 and 118). The keys: / moves focus to search (or opens Transactions with
// it focused), ? opens the keys sheet (focus on an Undo toast moves into it), j and k move between a list's rows, e
// opens the row focus is on (Enter already does, on a link), ← and → go to the previous and next month on Home, and u
// presses the Undo of the toast on screen. Shift is part of ? and of / and nothing else. No key acts while focus is in
// a field, with Ctrl, Alt or Cmd held, or while a sheet is open (sheet.js owns the keys then). The sheet keeps the
// page's #fragment, and a keys response is dropped when another sheet opened or the address moved while it loaded.
// A second ? while the keys sheet loads sends nothing, so a key repeat sends one request.
// A swap of #keys moves the sheet's return, and so does a history restore (Back) that redraws the page without the
// sheet: that counts as the close, and when the opener is gone, focus goes to the page's heading. A keys request that
// ends without a swap gives focus back (to Undo) and forgets it. Without this script every page works as a plain
// page: the keys are a details at the foot, and More lists them. Pages say what they can do with data attributes and
// aria-keyshortcuts; this script only reads them.

const FIELD = "input, textarea, select, [contenteditable]";
// The row a person opens, marked on transaction, Home's savings goal and category rows, and Bills' bill and planned
// expense rows. Only a link can take focus, so a details row (Settings' category rows) is passed over.
const ROW = "a[data-row]";
// A region that scrolls sideways (month-end's chart) keeps the arrows for itself.
const SIDEWAYS = "[data-sideways]";
// The list that takes the search when a page has no search of its own.
const SEARCH_PAGE = "/transactions?focus=search";

/** The keys sheet's address: this page's own, with keys after its query. */
export function keysHref({ pathname, search }) {
	// A path that starts with more than one "/", or has a backslash, tab or newline, would lead to another host. The browser
	// has already normalised location.pathname, so this only mirrors the server's sitePath, which is the real guard.
	const path = /[\\\t\n\r]/.test(pathname)
		? "/"
		: pathname.replace(/^\/+/, "/");
	return `${path}${search ? `${search}&` : "?"}keys`;
}

/** A page's address without its #fragment: the path and the query, which is what a push (a filter's, say) changes. */
const pathAndQuery = ({ pathname, search }) => pathname + search;

/**
 * Shown, and live: not drawn inside an inert ancestor (the page behind an open sheet) or an hx-ignore one (a catalog
 * drawing, which htmx leaves alone, so a key must not follow its links either).
 */
function usable(node) {
	return (
		node.getClientRects().length > 0 && !node.closest("[inert], [hx-ignore]")
	);
}

/** The open sheet: the first [data-sheet] not drawn inside an inert ancestor, as sheet.js finds it. */
export function openSheet(doc) {
	return (
		[...doc.querySelectorAll("[data-sheet]")].find(
			(node) => !node.closest("[inert]"),
		) ?? null
	);
}

/** The page's control for a key: the last usable element that names it in aria-keyshortcuts. */
export function controlFor(doc, key) {
	const named = [...doc.querySelectorAll("[aria-keyshortcuts]")].filter(
		(node) => node.getAttribute("aria-keyshortcuts") === key && usable(node),
	);
	return named.at(-1) ?? null;
}

/** The rows a list has, in page order, that a person can see and reach. */
export function rowsOf(doc) {
	return [...doc.querySelectorAll(ROW)].filter(usable);
}

/**
 * The keys for one page. `doc` is the document and `win` the window (its location, and htmx for the keys sheet). The
 * sheet's close returns focus to whatever opened it, once htmx has swapped the sheet away: `settled` is htmx's
 * after-settle, and it acts on a swap of #keys or of a region that holds it, after the sheet has been seen open. A
 * history restore (Back) that redraws the page without the sheet counts as the close, and when the opener is gone,
 * focus goes to the page's heading. `ended` is htmx's finally-request, and clears the return when a keys request ends
 * without a swap. `responded` is htmx's after-request, and drops a keys response when another sheet opened or the
 * address moved while it loaded.
 */
export function keyboard(doc, win) {
	let returnTo = null;
	let armed = false;
	// The #fragment the page had when the keys sheet opened. The sheet's address has none, so its close puts it back.
	let keptHash = "";
	// A keys request is in flight: a second ? sends nothing until it ends or the keys region settles.
	let loading = false;

	// A page loaded with the keys sheet already open (a reload) keeps its fragment on close, as a sheet opened with ? does.
	const loaded = openSheet(doc);
	if (loaded && doc.getElementById("keys")?.contains(loaded)) {
		keptHash = win.location.hash;
		armed = true;
	}

	/** Forgets the keys' return: what opened the sheet, the fragment it kept, and that a sheet was seen open. */
	function forget() {
		armed = false;
		returnTo = null;
		keptHash = "";
	}

	/** Focuses the page's heading: the first h1 in #main, or else #main, as toast.js's focusHeading does. */
	function focusHeading() {
		const main = doc.getElementById("main");
		if (!main) return;
		const heading =
			[...doc.querySelectorAll("h1")].find((h1) => main.contains(h1)) ?? main;
		if (!heading.hasAttribute("tabindex"))
			heading.setAttribute("tabindex", "-1");
		heading.focus();
	}

	/** Moves focus to the row j or k goes to: from the row focus is on, one down or up, stopping at the ends. */
	function moveRow(key, active) {
		const rows = rowsOf(doc);
		if (rows.length === 0) return;
		const at = rows.findIndex((row) => row === active || row.contains(active));
		let next;
		if (at === -1) next = key === "j" ? 0 : rows.length - 1;
		else
			next = Math.min(
				Math.max(at + (key === "j" ? 1 : -1), 0),
				rows.length - 1,
			);
		rows[next].focus();
		rows[next].scrollIntoView?.({ block: "nearest" });
	}

	return {
		keydown(event) {
			if (event.defaultPrevented || event.isComposing) return;
			if (event.ctrlKey || event.altKey || event.metaKey) return;
			// Shift is part of ? and of / (on layouts such as German, where / needs it); a shifted letter or arrow does nothing.
			if (event.shiftKey && event.key !== "?" && event.key !== "/") return;
			const active = doc.activeElement ?? doc.body;
			if (active.closest(FIELD) || openSheet(doc)) return;
			// Caps Lock makes a letter's key a capital; a letter is read the same either way.
			const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
			switch (key) {
				case "/": {
					const search = controlFor(doc, "/");
					event.preventDefault();
					if (search) search.focus();
					else win.location.assign(SEARCH_PAGE);
					return;
				}
				case "?": {
					event.preventDefault();
					if (loading) return;
					returnTo = active === doc.body ? null : active;
					// Focus on an Undo toast is blurred so the sheet can take focus (sheet.js moves it only from nothing).
					if (doc.getElementById("toasts")?.contains(active)) active.blur();
					keptHash = win.location.hash;
					const url = keysHref(win.location);
					loading = true;
					// The address is pushed as given: htmx reads a boolean push as a path, so `true` would push "/true".
					// The fragment is pushed but not requested: htmx would scroll to an anchor the request carries.
					win.htmx.ajax("GET", url, {
						target: "#keys",
						select: "#keys",
						swap: "outerHTML",
						push: url + keptHash,
					});
					return;
				}
				case "j":
				case "k":
					moveRow(key, active);
					return;
				case "e":
					if (!active.hasAttribute("data-row")) return;
					event.preventDefault();
					active.click();
					return;
				default: {
					// ← and → (Home's month links) and u (the Undo toast) are the page's own controls, named by their key.
					if (
						(key === "ArrowLeft" || key === "ArrowRight") &&
						active.closest(SIDEWAYS)
					)
						return;
					const control = controlFor(doc, key);
					if (!control) return;
					event.preventDefault();
					control.click();
				}
			}
		},
		settled(event) {
			// A settle of #keys, or of a region that holds it (a history restore swaps the body, which holds #keys), is the
			// keys sheet's swap. Another request's settle (Sync now, a row's sheet) leaves the return alone.
			const region = doc.getElementById("keys");
			if (!region || !event?.target?.contains?.(region)) return;
			// htmx can drop a queued keys request on a history restore without a finish: the settle ends its wait too.
			loading = false;
			const sheet = openSheet(doc);
			if (sheet) {
				// Only the keys sheet's own open arms the return; a different sheet's settle changes nothing.
				if (region.contains(sheet)) armed = true;
				return;
			}
			// A settle with no sheet open ends the keys' return: it was the close (a failed request is ended(), below).
			const back = armed ? returnTo : null;
			const fragment = armed ? keptHash : "";
			forget();
			// The close's address has no fragment, so the page's own goes back on. replaceState keeps htmx's state and
			// neither scrolls nor adds a history entry.
			if (fragment && !win.location.hash)
				win.history.replaceState(
					win.history.state,
					"",
					win.location.pathname + win.location.search + fragment,
				);
			// When the opener is gone (a Back redrew the page, or an Undo left its toast), focus goes to the page's heading,
			// but only from nothing, as ended() gives it back.
			if (back?.isConnected) back.focus();
			else if (back && (doc.activeElement === doc.body || !doc.activeElement))
				focusHeading();
		},
		/** A keys request that ends with no swap forgets the return, and refocuses its opener if focus is on nothing. */
		ended(event) {
			const ctx = event.detail?.ctx;
			if (ctx?.target?.id !== "keys") return;
			// Every keys request ends here, cancelled, dropped or failed, so a ? after this one sends a new request.
			loading = false;
			// A swap's settle ends the return, so a finish that comes first leaves it for that settle.
			if (ctx.status === "swapped" && ctx.swap !== "none") return;
			const sheet = openSheet(doc);
			// A failed close leaves the sheet up, so its return stays for the retried Escape or Cancel.
			if (sheet && doc.getElementById("keys")?.contains(sheet)) return;
			// A sheet that opened meanwhile takes the focus with it, so the old opener gets none back.
			const back = sheet ? null : returnTo;
			forget();
			// Focus moves back only from nothing (an Undo that ? blurred), so a person who moved it keeps it.
			if (
				back?.isConnected &&
				(doc.activeElement === doc.body || !doc.activeElement)
			)
				back.focus();
		},
		/**
		 * A keys response is thrown away when a sheet outside #keys opened while it loaded: its swap would put the keys
		 * sheet over that one, so that drop forgets the return at once. It is also thrown away when the address moved since
		 * the request was made (HX-Current-URL, which htmx sends with every request), so a filter's push is not followed
		 * by this older address; that drop keeps the return, and ended() gives focus back to it (Undo, say) when the request
		 * finishes. htmx returns before the swap when htmx:after:request is cancelled, so no address is pushed either. The
		 * keys sheet's own close is kept, since its sheet is inside #keys.
		 */
		responded(event) {
			const target = event.detail?.ctx?.target;
			if (target?.id !== "keys") return;
			const sheet = openSheet(doc);
			const otherSheet = !!sheet && !target.contains(sheet);
			const from = event.detail?.ctx?.request?.headers?.["HX-Current-URL"];
			const moved =
				!!from && pathAndQuery(new URL(from)) !== pathAndQuery(win.location);
			if (!otherSheet && !moved) return;
			event.preventDefault();
			if (otherSheet) forget();
		},
	};
}

// The browser wiring. A test runs this module without a page, so it is skipped there.
if (typeof document !== "undefined") {
	const keys = keyboard(document, window);
	document.addEventListener("keydown", (event) => keys.keydown(event));
	document.addEventListener("htmx:after:settle", (event) =>
		keys.settled(event),
	);
	document.addEventListener("htmx:finally:request", (event) =>
		keys.ended(event),
	);
	document.addEventListener("htmx:after:request", (event) =>
		keys.responded(event),
	);
}

// Keyboard shortcuts (#72, decisions 109 and 118). The keys: / moves focus to search (or opens Transactions with
// it focused), ? opens the keys sheet (focus on an Undo toast moves into it), j and k move between a list's rows, e
// opens the row focus is on (Enter already does, on a link), ← and → go to the previous and next month on Home, and u
// presses the Undo of the toast on screen. Shift is part of ? and of / and nothing else. No key acts while focus is in
// a field, with Ctrl, Alt or Cmd held, or while a sheet is open (sheet.js owns the keys then). The sheet keeps the
// page's #fragment, and a keys response that arrives after another sheet opened is dropped. Without this script every
// page works as a plain page: the keys are a details at the foot, and More lists them. Pages say what they can do with
// data attributes and aria-keyshortcuts; this script only reads them.

const FIELD = "input, textarea, select, [contenteditable]";
// The row a person opens, marked on transaction, Home's category and bill rows. Only a link can take focus, so a
// details row (Settings' category rows) is passed over.
const ROW = "a[data-row]";
// A region that scrolls sideways (month-end's chart) keeps the arrows for itself.
const SIDEWAYS = "[data-sideways]";
// The list that takes the search when a page has no search of its own.
const SEARCH_PAGE = "/transactions?focus=search";

/** The keys sheet's address: this page's own, with keys after its query. */
export function keysHref({ pathname, search }) {
	// A path that starts with more than one "/" would lead to another host, so it is kept to one.
	const path = pathname.replace(/^\/+/, "/");
	return `${path}${search ? `${search}&` : "?"}keys`;
}

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
 * after-settle, and it only acts after the sheet has been seen open.
 */
export function keyboard(doc, win) {
	let returnTo = null;
	let armed = false;
	// The #fragment the page had when the keys sheet opened. The sheet's address has none, so its close puts it back.
	let keptHash = "";

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
					returnTo = active === doc.body ? null : active;
					// Focus on an Undo toast is blurred so the sheet can take focus (sheet.js moves it only from nothing).
					if (doc.getElementById("toasts")?.contains(active)) active.blur();
					keptHash = win.location.hash;
					const url = keysHref(win.location);
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
		settled() {
			if (openSheet(doc)) {
				armed = true;
				return;
			}
			// A settle with no sheet open ends the keys' return: it was the close, or nothing ever opened (a failed request).
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
			if (back?.isConnected) back.focus();
		},
		/**
		 * A keys response is thrown away when a sheet outside #keys opened while it loaded: its swap would put the keys
		 * sheet over that one. htmx returns before the swap when htmx:after:request is cancelled, so no address is pushed
		 * either. The keys sheet's own close is kept, since its sheet is inside #keys.
		 */
		responded(event) {
			const target = event.detail?.ctx?.target;
			if (target?.id !== "keys") return;
			const sheet = openSheet(doc);
			if (!sheet || target.contains(sheet)) return;
			event.preventDefault();
			forget();
		},
	};
}

// The browser wiring. A test runs this module without a page, so it is skipped there.
if (typeof document !== "undefined") {
	const keys = keyboard(document, window);
	document.addEventListener("keydown", (event) => keys.keydown(event));
	document.addEventListener("htmx:after:settle", () => keys.settled());
	document.addEventListener("htmx:after:request", (event) =>
		keys.responded(event),
	);
}

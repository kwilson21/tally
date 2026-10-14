// Makes an open sheet (BottomSheet, decision 109) a true modal: Escape closes it the way Cancel and the
// backdrop do, Tab stays inside it, focus moves into it when nothing in it has focus, the page behind it is
// inert, and a screen reader hears a modal dialog.
// Without this script a sheet is the page region it has always been, closed by Cancel or the backdrop.
// The sheet is found by its markers: data-sheet on its section, data-sheet-close on its backdrop link.
(() => {
	const MARK = "data-sheet-inert";
	// Toasts stay usable while a sheet is open (an Undo's button), and so does the announcer.
	const KEPT_OPEN = ["toasts", "announcer"];
	const TABBABLE =
		"a[href], button, input, select, textarea, summary, [tabindex]";

	const openSheet = () => document.querySelector("[data-sheet]");

	// Focus on nothing in the sheet (the body, or a row the sheet now covers) moves into it: to its [autofocus] field,
	// or else to its title. Focus that is already in the sheet stays, and so does focus on an Undo toast, which toast.js
	// put there on purpose. The field comes before the title, since on a full page load the browser skips its own
	// autofocus once something has focus, so focusing the title first would take the field's place.
	function takeFocus(sheet) {
		const active = document.activeElement;
		if (
			sheet.contains(active) ||
			document.getElementById("toasts")?.contains(active)
		)
			return;
		const target =
			sheet.querySelector("[autofocus]") ??
			document.getElementById(sheet.getAttribute("aria-labelledby"));
		if (!target) return;
		if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
		target.focus();
	}

	// Takes off every inert mark this script set, then marks the page outside the sheet again. The marks
	// live on the elements, so a page restored from a history snapshot (taken while a sheet was open)
	// is released too, and nothing is marked twice when a redrawn sheet replaces the open one.
	function sync() {
		for (const marked of document.querySelectorAll(`[${MARK}]`)) {
			marked.removeAttribute("inert");
			marked.removeAttribute(MARK);
		}
		const sheet = openSheet();
		if (!sheet) return;
		sheet.setAttribute("aria-modal", "true");
		let node = sheet;
		while (node !== document.body && node.parentElement) {
			const parent = node.parentElement;
			for (const sibling of parent.children) {
				if (
					sibling === node ||
					sibling.hasAttribute("data-sheet-close") ||
					KEPT_OPEN.includes(sibling.id) ||
					// Already inert before this script ran: not ours to change.
					sibling.hasAttribute("inert")
				)
					continue;
				sibling.setAttribute("inert", "");
				sibling.setAttribute(MARK, "");
			}
			node = parent;
		}
		takeFocus(sheet);
	}

	// Escape is the backdrop's own close, so htmx runs the same swap as a tap (without htmx the link navigates).
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || event.isComposing || event.defaultPrevented)
			return;
		const close = document.querySelector("[data-sheet-close]");
		if (!close) return;
		event.preventDefault();
		close.click();
	});

	// A stop is a control that can take focus now: in the Tab order, enabled and drawn.
	function stopsIn(root) {
		if (!root) return [];
		return [...root.querySelectorAll(TABBABLE)].filter(
			(node) =>
				node.tabIndex >= 0 && !node.disabled && node.getClientRects().length,
		);
	}

	// Radios with one name in one form are one group; an unnamed radio is a group of its own. A group is one stop,
	// where its first radio is: its checked radio, or that first radio when none is checked.
	const sameGroup = (a, b) =>
		a === b ||
		(a.type === "radio" &&
			b.type === "radio" &&
			a.name !== "" &&
			a.name === b.name &&
			a.form === b.form);
	function oneStopPerGroup(stops) {
		const kept = [];
		for (const node of stops) {
			const group = stops.filter((other) => sameGroup(node, other));
			if (group[0] === node)
				kept.push(group.find((radio) => radio.checked) ?? node);
		}
		return kept;
	}

	// Tab moves through the sheet's stops and on to the Undo toasts on screen, and wraps at both ends of that
	// cycle. The page behind the sheet is inert, but the toasts are not, so the browser's own order could carry
	// focus out of the sheet. Between two stops of one region the browser moves focus itself; a wrap, or a move
	// from the sheet into the toasts or back, is done here. Focus outside the cycle (the heading, the body)
	// goes to the sheet's first stop, or its last for Shift+Tab, never to a toast.
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Tab" || event.defaultPrevented) return;
		const sheet = openSheet();
		if (!sheet) return;
		const sheetStops = oneStopPerGroup(stopsIn(sheet));
		const cycle = [
			...sheetStops,
			...stopsIn(document.getElementById("toasts")),
		];
		const focused = document.activeElement;
		const at = cycle.findIndex((stop) => sameGroup(stop, focused));
		if (at === -1) {
			event.preventDefault();
			(event.shiftKey ? sheetStops.at(-1) : sheetStops[0])?.focus();
			return;
		}
		const seam = sheetStops.length;
		const next = at + (event.shiftKey ? -1 : 1);
		const sameRegion = next < seam === at < seam;
		if (next >= 0 && next < cycle.length && sameRegion) return;
		event.preventDefault();
		cycle[(next + cycle.length) % cycle.length].focus();
	});

	sync();
	document.addEventListener("htmx:after:swap", sync);
	document.addEventListener("htmx:after:settle", sync);
})();

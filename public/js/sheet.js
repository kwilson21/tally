// Makes an open sheet (BottomSheet, decision 109) a true modal: Escape closes it the way Cancel and the
// backdrop do, Tab stays inside it, the page behind it is inert, and a screen reader hears a modal dialog.
// Without this script a sheet is the page region it has always been, closed by Cancel or the backdrop.
// The sheet is found by its markers: data-sheet on its section, data-sheet-close on its backdrop link.
(() => {
	const MARK = "data-sheet-inert";
	// Toasts stay usable while a sheet is open (an Undo's button), and so does the announcer.
	const KEPT_OPEN = ["toasts", "announcer"];
	const TABBABLE =
		"a[href], button, input, select, textarea, summary, [tabindex]";

	const openSheet = () => document.querySelector("[data-sheet]");

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

	// Tab stays inside the sheet. The page behind it is inert, but the toasts are not, so the browser's own
	// order could carry focus out of the sheet at either end. Focus outside the sheet, or on its heading (which
	// takes focus but is not a stop), goes to the first stop, or to the last one for Shift+Tab. Between two
	// stops the browser moves focus itself.
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Tab" || event.defaultPrevented) return;
		const sheet = openSheet();
		if (!sheet) return;
		const stops = [...sheet.querySelectorAll(TABBABLE)].filter(
			(node) =>
				node.tabIndex >= 0 && !node.disabled && node.getClientRects().length,
		);
		if (!stops.length) {
			event.preventDefault();
			return;
		}
		const at = stops.indexOf(document.activeElement);
		let target = null;
		if (at === -1) target = event.shiftKey ? stops.at(-1) : stops[0];
		else if (event.shiftKey && at === 0) target = stops.at(-1);
		else if (!event.shiftKey && at === stops.length - 1) target = stops[0];
		if (!target) return;
		event.preventDefault();
		target.focus();
	});

	sync();
	document.addEventListener("htmx:after:swap", sync);
	document.addEventListener("htmx:after:settle", sync);
})();

// A tab that isn't on screen counts as away (decision 148, the owner's pick). The presence check-in (home-seen.tsx) fires on
// load, every 30 seconds, and when the tab comes back; htmx 4's trigger filters need eval, which Tally's CSP forbids, so this
// script cancels the check-in's request while the tab is hidden, and nothing else on the page.
export function setupHomeSeen({ document }) {
	document.addEventListener("htmx:before:request", (event) => {
		if (event.target?.id !== "home-seen") return;
		if (document.visibilityState !== "hidden") return;
		event.preventDefault();
	});
}

if (typeof document !== "undefined") {
	setupHomeSeen({ document });
}

// The design system catalog's own controls (decision 44), loaded only on /design-system.
// It sends the same toast and announce events an HX-Trigger header would, so toast.js shows the
// real toast. It never intercepts or fakes a request.
document.addEventListener("click", (event) => {
	const button = event.target.closest?.("[data-ds-toast]");
	if (!button) return;
	const message = button.dataset.dsMessage;
	button.dispatchEvent(
		new CustomEvent("toast", {
			bubbles: true,
			detail: { message, type: button.dataset.dsToast },
		}),
	);
	button.dispatchEvent(
		new CustomEvent("announce", { bubbles: true, detail: { value: message } }),
	);
});

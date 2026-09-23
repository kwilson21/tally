// Shows HX-Trigger "toast" messages and speaks "announce" messages to screen readers.
// Text only (textContent), never HTML.
(() => {
	const DISPLAY_MS = 4000;

	document.body.addEventListener("toast", (event) => {
		const { message, type = "success" } = event.detail ?? {};
		if (!message) return;
		const toast = document.createElement("p");
		toast.className =
			"rounded-control border border-rule bg-paper px-4 py-3 text-sm text-ink shadow-sm";
		toast.setAttribute("role", type === "error" ? "alert" : "status");
		toast.textContent = message;
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
})();

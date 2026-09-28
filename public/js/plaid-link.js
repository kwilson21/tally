// Opens Plaid Link, exchanges its one-time token, then refreshes the bank list.
// Tokens stay only in memory and are never logged or stored by this script.
export function setupPlaidLink({ document, fetch, htmx, DOMParser }) {
	const button = document.querySelector("[data-link-bank]");
	const errorRegion = document.querySelector("[data-link-bank-error]");
	if (!button || !errorRegion) return;

	const genericFailure = "Couldn't link the bank. Try again.";
	const showAlert = (message) => {
		const alert = document.createElement("p");
		alert.setAttribute("role", "alert");
		alert.textContent = message;
		errorRegion.replaceChildren(alert);
	};
	const busy = (value) => {
		button.disabled = value;
		button.setAttribute("aria-busy", String(value));
		button.classList.toggle("htmx-request", value);
	};
	const showFailure = (responseText) => {
		const serverAlert = responseText
			? new DOMParser()
					.parseFromString(responseText, "text/html")
					.querySelector('[role="alert"]')?.textContent
			: undefined;
		showAlert(serverAlert?.trim() || genericFailure);
	};
	const responseText = (error) =>
		error && typeof error === "object" && "xhr" in error
			? error.xhr?.responseText
			: undefined;

	button.addEventListener("click", async () => {
		const Plaid = globalThis.Plaid;
		if (!Plaid) {
			showFailure();
			busy(false);
			return;
		}
		busy(true);
		errorRegion.replaceChildren();
		try {
			const response = await fetch("/plaid/link-token", { method: "POST" });
			if (!response.ok) {
				showFailure(await response.text());
				busy(false);
				return;
			}
			const { link_token: token } = await response.json();
			const link = Plaid.create({
				token,
				onSuccess: async (publicToken) => {
					let announcement;
					try {
						let exchangeContext;
						const finished = (event) => {
							exchangeContext = event.detail?.ctx;
							const trigger = exchangeContext?.hx?.trigger;
							if (typeof trigger !== "string") return;
							try {
								const events = JSON.parse(trigger);
								if (Object.hasOwn(events, "announce")) {
									announcement = events.announce;
									delete events.announce;
									exchangeContext.hx.trigger = JSON.stringify(events);
								}
							} catch {
								// Leave malformed headers to htmx's normal handling.
							}
						};
						button.addEventListener("htmx:after:request", finished);
						button.addEventListener("htmx:finally:request", finished);
						try {
							await htmx.ajax("POST", "/plaid/exchange", {
								source: button,
								target: errorRegion,
								swap: "none",
								headers: {
									"Content-Type": "application/x-www-form-urlencoded",
								},
								values: { public_token: publicToken },
							});
						} finally {
							button.removeEventListener("htmx:after:request", finished);
							button.removeEventListener("htmx:finally:request", finished);
						}
						if (
							!exchangeContext?.response ||
							exchangeContext.response.status >= 400
						) {
							showFailure(exchangeContext?.text);
							return;
						}
						// The POST's completion removes htmx-request from its source.
						busy(true);
						let refreshContext;
						const refreshed = (event) => {
							refreshContext = event.detail?.ctx;
						};
						button.addEventListener("htmx:finally:request", refreshed);
						try {
							await htmx.ajax("GET", "/accounts", {
								source: button,
								target: "#accounts-summary",
								select: "#accounts-summary",
								swap: "outerHTML",
							});
						} finally {
							button.removeEventListener("htmx:finally:request", refreshed);
						}
						if (announcement) {
							document.body.dispatchEvent(
								new CustomEvent("announce", {
									detail: { value: announcement },
								}),
							);
						}
						if (
							!refreshContext?.response ||
							refreshContext.response.status >= 400
						) {
							const bank = announcement?.replace(/[.!?]$/, "") || "Bank linked";
							showAlert(
								`${bank}, but the list didn't refresh. Reload the page to see it.`,
							);
							return;
						}
						button.focus();
					} catch (error) {
						showFailure(responseText(error));
					} finally {
						busy(false);
					}
				},
				onExit: (error) => {
					if (error) showFailure();
					busy(false);
				},
			});
			link.open();
		} catch {
			showFailure();
			busy(false);
		}
	});
}

if (typeof document !== "undefined") {
	setupPlaidLink({ document, fetch, htmx, DOMParser });
}

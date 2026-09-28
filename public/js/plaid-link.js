// Opens Plaid Link, exchanges its one-time token, then refreshes the bank list.
// Tokens stay only in memory and are never logged or stored by this script.
export function setupPlaidLink({ document, fetch, htmx, DOMParser }) {
	const button = document.querySelector("[data-link-bank]");
	const errorRegion = document.querySelector("[data-link-bank-error]");

	const repairFailure = "Couldn't fix the connection. Try again.";
	const repairAlert = (region, responseBody, itemId) => {
		const liveRegion = itemId
			? document.querySelector(
					`[data-bank-item-id="${itemId}"] [data-fix-error]`,
				)
			: undefined;
		const serverAlert = responseBody
			? new DOMParser()
					.parseFromString(responseBody, "text/html")
					.querySelector('[role="alert"]')?.textContent
			: undefined;
		const alert = document.createElement("p");
		alert.setAttribute("role", "alert");
		alert.textContent = serverAlert?.trim() || repairFailure;
		(liveRegion || region).replaceChildren(alert);
	};
	const setRepairBusy = (repairButton, value) => {
		repairButton.disabled = value;
		repairButton.setAttribute("aria-busy", String(value));
		repairButton.classList.toggle("htmx-request", value);
	};
	const repairClick = async (event) => {
		const repairButton = event.target?.closest?.("[data-fix-connection]");
		if (!repairButton) return;
		const itemId = repairButton.getAttribute("data-item-id");
		const section = repairButton.closest("[data-bank-item-id]");
		const repairError = section?.querySelector("[data-fix-error]");
		if (!itemId || !repairError) return;
		const Plaid = globalThis.Plaid;
		if (!Plaid) {
			repairAlert(repairError, undefined, itemId);
			setRepairBusy(repairButton, false);
			return;
		}
		setRepairBusy(repairButton, true);
		repairError.replaceChildren();
		try {
			const response = await fetch(`/plaid/items/${itemId}/link-token`, {
				method: "POST",
			});
			if (!response.ok) {
				repairAlert(repairError, await response.text(), itemId);
				setRepairBusy(repairButton, false);
				return;
			}
			const { link_token: token } = await response.json();
			const link = Plaid.create({
				token,
				onSuccess: async () => {
					let requestContext;
					let announcement;
					const finished = (requestEvent) => {
						requestContext = requestEvent.detail?.ctx;
						const trigger = requestContext?.hx?.trigger;
						if (typeof trigger !== "string") return;
						try {
							const events = JSON.parse(trigger);
							if (Object.hasOwn(events, "announce")) {
								announcement = events.announce;
								delete events.announce;
								requestContext.hx.trigger = JSON.stringify(events);
							}
						} catch {
							// Leave malformed headers to htmx.
						}
					};
					repairButton.addEventListener("htmx:after:request", finished);
					repairButton.addEventListener("htmx:finally:request", finished);
					try {
						await htmx.ajax("POST", `/plaid/items/${itemId}/repaired`, {
							source: repairButton,
							target: repairError,
							swap: "none",
						});
					} catch {
						repairAlert(repairError, undefined, itemId);
						setRepairBusy(repairButton, false);
						return;
					} finally {
						repairButton.removeEventListener("htmx:after:request", finished);
						repairButton.removeEventListener("htmx:finally:request", finished);
					}
					if (
						!requestContext?.response ||
						requestContext.response.status >= 400
					) {
						repairAlert(repairError, requestContext?.text, itemId);
						setRepairBusy(repairButton, false);
						return;
					}
					setRepairBusy(repairButton, true);
					let newSummary;
					try {
						const refresh = await fetch("/accounts");
						if (refresh.ok) {
							const parsed = new DOMParser().parseFromString(
								await refresh.text(),
								"text/html",
							);
							newSummary = parsed.querySelector("#accounts-summary");
							const oldSummary = document.querySelector("#accounts-summary");
							if (newSummary && oldSummary) {
								oldSummary.replaceWith(newSummary);
								htmx.process(newSummary);
							} else newSummary = undefined;
						}
					} catch {
						// The repair succeeded; report the stale view below.
					}
					if (announcement) {
						document.body.dispatchEvent(
							new CustomEvent("announce", { detail: { value: announcement } }),
						);
					}
					if (!newSummary) {
						repairAlert(
							repairError,
							'<p role="alert">The connection was fixed, but the list didn\'t refresh. Reload the page to see it.</p>',
							itemId,
						);
						setRepairBusy(repairButton, false);
						return;
					}
					const refreshedBank = newSummary.querySelector?.(
						`[data-bank-item-id="${itemId}"]`,
					);
					const focusTarget =
						refreshedBank?.querySelector?.("h2") ??
						document.querySelector("[data-link-bank]");
					focusTarget?.focus();
					setRepairBusy(repairButton, false);
				},
				onExit: (error) => {
					if (error) repairAlert(repairError, undefined, itemId);
					setRepairBusy(repairButton, false);
				},
			});
			link.open();
		} catch {
			repairAlert(repairError, undefined, itemId);
			setRepairBusy(repairButton, false);
		}
	};
	if (document.addEventListener)
		document.addEventListener("click", repairClick);
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
						let refreshed = false;
						try {
							const refreshResponse = await fetch("/accounts");
							if (refreshResponse.ok) {
								const parsed = new DOMParser().parseFromString(
									await refreshResponse.text(),
									"text/html",
								);
								const newSummary = parsed.querySelector("#accounts-summary");
								const currentSummary =
									document.querySelector("#accounts-summary");
								if (newSummary && currentSummary) {
									currentSummary.replaceWith(newSummary);
									htmx.process(newSummary);
									refreshed = true;
								}
							}
						} catch {
							// The exchange succeeded, so report the stale summary below.
						}
						if (announcement) {
							document.body.dispatchEvent(
								new CustomEvent("announce", {
									detail: { value: announcement },
								}),
							);
						}
						if (!refreshed) {
							const bank = announcement?.replace(/[.!?]$/, "") || "Bank linked";
							showAlert(
								`${bank}, but the list didn't refresh. Reload the page to see it.`,
							);
							return;
						}
						button.focus();
					} catch {
						showFailure();
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

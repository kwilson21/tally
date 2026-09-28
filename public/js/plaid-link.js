// Opens Plaid Link, exchanges its one-time token, then refreshes the bank list.
// Tokens stay only in memory and are never logged or stored by this script.
export function setupPlaidLink({ document, fetch, htmx, DOMParser }) {
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
	// The banks with a fix running. A refresh can redraw a bank's button mid-fix, so a second click
	// is refused by id, and the busy state reaches whichever button is on screen.
	const repairing = new Set();
	const repairClick = async (event) => {
		const repairButton = event.target?.closest?.("[data-fix-connection]");
		if (!repairButton) return;
		const itemId = repairButton.getAttribute("data-item-id");
		const section = repairButton.closest("[data-bank-item-id]");
		const repairError = section?.querySelector("[data-fix-error]");
		if (!itemId || !repairError || repairing.has(itemId)) return;
		const setBusy = (value) => {
			if (value) repairing.add(itemId);
			else repairing.delete(itemId);
			const live = document.querySelector(
				`[data-bank-item-id="${itemId}"] [data-fix-connection]`,
			);
			for (const button of new Set([repairButton, live])) {
				if (button) setRepairBusy(button, value);
			}
		};
		const Plaid = globalThis.Plaid;
		if (!Plaid) {
			repairAlert(repairError, undefined, itemId);
			setBusy(false);
			return;
		}
		setBusy(true);
		repairError.replaceChildren();
		try {
			const response = await fetch(`/plaid/items/${itemId}/link-token`, {
				method: "POST",
			});
			if (!response.ok) {
				repairAlert(repairError, await response.text(), itemId);
				setBusy(false);
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
						setBusy(false);
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
						setBusy(false);
						return;
					}
					setBusy(true);
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
						setBusy(false);
						return;
					}
					const refreshedBank = newSummary.querySelector?.(
						`[data-bank-item-id="${itemId}"]`,
					);
					const focusTarget =
						refreshedBank?.querySelector?.("h2") ??
						document.querySelector("[data-link-bank]");
					focusTarget?.focus();
					setBusy(false);
				},
				onExit: (error) => {
					if (error) repairAlert(repairError, undefined, itemId);
					setBusy(false);
				},
			});
			link.open();
		} catch {
			repairAlert(repairError, undefined, itemId);
			setBusy(false);
		}
	};

	const genericFailure = "Couldn't link the bank. Try again.";
	// Link a bank lives inside #accounts-summary, which a refresh replaces (decision 55), so its
	// button and error region are looked up when needed rather than kept from page load.
	const linkErrorRegion = () =>
		document.querySelector("[data-link-bank-error]");
	const showAlert = (message) => {
		const alert = document.createElement("p");
		alert.setAttribute("role", "alert");
		alert.textContent = message;
		linkErrorRegion()?.replaceChildren(alert);
	};
	const showFailure = (responseText) => {
		const serverAlert = responseText
			? new DOMParser()
					.parseFromString(responseText, "text/html")
					.querySelector('[role="alert"]')?.textContent
			: undefined;
		showAlert(serverAlert?.trim() || genericFailure);
	};
	// One link at a time: a refresh (a fix finishing, say) can redraw Link a bank mid-link, so a
	// second click is refused, and the busy state reaches whichever button is on screen.
	let linking = false;
	const linkClick = async (button) => {
		if (linking) return;
		const busy = (value) => {
			linking = value;
			const live = document.querySelector("[data-link-bank]");
			for (const target of new Set([button, live])) {
				if (!target) continue;
				target.disabled = value;
				target.setAttribute("aria-busy", String(value));
				target.classList.toggle("htmx-request", value);
			}
		};
		const Plaid = globalThis.Plaid;
		if (!Plaid) {
			showFailure();
			busy(false);
			return;
		}
		busy(true);
		linkErrorRegion()?.replaceChildren();
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
								target: linkErrorRegion() ?? button,
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
						// The refresh drew a new button; focus that one, not the one clicked.
						document.querySelector("[data-link-bank]")?.focus();
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
	};

	// One delegated listener for both buttons, so a button a refresh replaced still works.
	if (document.addEventListener)
		document.addEventListener("click", (event) => {
			const linkButton = event.target?.closest?.("[data-link-bank]");
			if (linkButton) return linkClick(linkButton);
			return repairClick(event);
		});
}

if (typeof document !== "undefined") {
	setupPlaidLink({ document, fetch, htmx, DOMParser });
}

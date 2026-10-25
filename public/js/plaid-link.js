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
							new CustomEvent("announce", {
								bubbles: true,
								detail: { value: announcement },
							}),
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
		const region = linkErrorRegion();
		if (region) {
			const alert = document.createElement("p");
			alert.setAttribute("role", "alert");
			alert.textContent = message;
			region.replaceChildren(alert);
			return;
		}
		// No error region is on screen (a first-week redraw can take it away while Plaid's window is open), so the
		// words still reach the person as a toast: the same "toast" event an HX-Trigger toast dispatches (toast.js).
		document.body.dispatchEvent(
			new CustomEvent("toast", {
				bubbles: true,
				detail: { message, type: "error" },
			}),
		);
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
		// What a success redraws: Accounts' list by default; setup's screens set their own (LinkBank's data attributes).
		const refreshUrl = button.dataset?.linkBankRefresh || "/accounts";
		const refreshTarget = button.dataset?.linkBankTarget || "#accounts-summary";
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
						// The exchange's source is the clicked button while it is on the page, else the live Link a bank, else
						// the body. A first-week redraw can replace the button while Plaid's window is open, and htmx 4 sends
						// nothing for a source that is no longer in the document, so the exchange never depends on the one clicked.
						const source = button.isConnected
							? button
							: (document.querySelector("[data-link-bank]") ?? document.body);
						source.addEventListener("htmx:after:request", finished);
						source.addEventListener("htmx:finally:request", finished);
						try {
							await htmx.ajax("POST", "/plaid/exchange", {
								source,
								target: linkErrorRegion() ?? source,
								swap: "none",
								headers: {
									"Content-Type": "application/x-www-form-urlencoded",
								},
								values: { public_token: publicToken },
							});
						} finally {
							source.removeEventListener("htmx:after:request", finished);
							source.removeEventListener("htmx:finally:request", finished);
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
							const refreshResponse = await fetch(refreshUrl);
							if (refreshResponse.ok) {
								const parsed = new DOMParser().parseFromString(
									await refreshResponse.text(),
									"text/html",
								);
								const newSummary = parsed.querySelector(refreshTarget);
								const currentSummary = document.querySelector(refreshTarget);
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
									bubbles: true,
									detail: { value: announcement },
								}),
							);
						}
						if (!refreshed) {
							const bank = announcement?.replace(/[.!?]$/, "") || "Bank linked";
							const stale =
								refreshTarget === "#accounts-summary" ? "list" : "page";
							showAlert(
								`${bank}, but the ${stale} didn't refresh. Reload the page to see it.`,
							);
							return;
						}
						// The refresh drew a new button, or setup's status line; focus that, not the one clicked. The status
						// wins over the screen's own Link another bank (the foot keeps one).
						(
							document.querySelector("[data-link-bank-focus]") ??
							document.querySelector("[data-link-bank]")
						)?.focus();
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

	// Setup's reading-screen refreshes, the Your banks poll and the presence check-in, carry data-waits-for-link. While Plaid Link
	// is open they are skipped, so a sort that finishes mid-link can't redraw the first-week top and take the bank being linked
	// away (decision 146). htmx 4.0.0 (node_modules/htmx.org/dist/htmx.js, #issueRequest) dispatches a cancelable
	// htmx:before:request on a request's source element, and sends nothing when it is prevented. A skipped tick is not queued:
	// the next tick after onSuccess or onExit runs as usual. The exchange is never skipped.
	//
	// An open Plaid Link counts as the person being there, including a bank's own sign-in in another tab, which hides Tally's
	// tab for the whole sign-in. So the check-in's skipped tick is replaced by a quiet presence ping whatever the tab's
	// visibility: a form post with no step, so /home/seen only moves home_seen_at and answers 204 (decision 146). Neither the
	// push (2 minutes) nor the email (10 minutes) goes while Plaid Link is open (decision 149). The poll and the refreshes
	// send nothing in its place.
	const presencePing = () =>
		fetch("/home/seen", {
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "",
		}).catch(() => {});
	const skipWhileLinking = (event) => {
		if (!linking || !event.target?.hasAttribute?.("data-waits-for-link"))
			return;
		event.preventDefault();
		if (event.target.id === "home-seen") presencePing();
	};

	// One delegated listener for both buttons, so a button a refresh replaced still works.
	if (document.addEventListener) {
		document.addEventListener("click", (event) => {
			const linkButton = event.target?.closest?.("[data-link-bank]");
			if (linkButton) return linkClick(linkButton);
			return repairClick(event);
		});
		document.addEventListener("htmx:before:request", skipWhileLinking);
	}
}

if (typeof document !== "undefined") {
	setupPlaidLink({ document, fetch, htmx, DOMParser });
}

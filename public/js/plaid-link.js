// Opens Plaid Link, exchanges its one-time token, then refreshes the bank list.
// Tokens stay only in memory and are never logged or stored by this script.
export function setupPlaidLink({ document, fetch, Plaid, htmx, DOMParser }) {
	const button = document.querySelector("[data-link-bank]");
	const errorRegion = document.querySelector("[data-link-bank-error]");
	if (!button || !errorRegion) return;

	const genericFailure = "Couldn't link the bank. Try again.";
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
		const alert = document.createElement("p");
		alert.setAttribute("role", "alert");
		alert.textContent = serverAlert?.trim() || genericFailure;
		errorRegion.replaceChildren(alert);
	};
	const responseText = (error) =>
		error && typeof error === "object" && "xhr" in error
			? error.xhr?.responseText
			: undefined;

	button.addEventListener("click", async () => {
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
					try {
						let exchangeContext;
						const finished = (event) => {
							exchangeContext = event.detail?.ctx;
						};
						button.addEventListener("htmx:finally:request", finished);
						await htmx.ajax("POST", "/plaid/exchange", {
							source: button,
							target: errorRegion,
							headers: {
								"Content-Type": "application/x-www-form-urlencoded",
							},
							values: { public_token: publicToken },
						});
						button.removeEventListener("htmx:finally:request", finished);
						if (
							!exchangeContext?.response ||
							exchangeContext.response.status >= 400
						) {
							showFailure(exchangeContext?.text);
							return;
						}
						await htmx.ajax("GET", "/accounts", {
							target: "#accounts-banks",
							select: "#accounts-banks",
							swap: "outerHTML",
						});
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
	setupPlaidLink({ document, fetch, Plaid, htmx, DOMParser });
}

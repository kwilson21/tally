// The money input's helpers (#66, decision 39), after the original app's currency input: nudge by a
// cent or a dollar, round up, use last month's amount, and stop typing at two decimals. All math is
// integer cents. Without this script the buttons stay hidden and the field is a plain text field.

// The same format the server saves (src/money.ts toCents): digits, commas in threes, one or two decimals.
const DOLLARS = /^\$?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/;

/** The field's text as integer cents: "" is 0, anything unreadable is null. */
export function fieldCents(text) {
	const trimmed = text.trim();
	if (trimmed === "") return 0;
	if (!DOLLARS.test(trimmed)) return null;
	const [whole = "", fraction = ""] = trimmed.replace(/[$,]/g, "").split(".");
	return Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
}

/** Integer cents as the field shows them: "612.40", "612", "0.05". */
export function showCents(cents) {
	const whole = Math.floor(cents / 100);
	const rest = cents % 100;
	return rest === 0
		? String(whole)
		: `${whole}.${String(rest).padStart(2, "0")}`;
}

/** The field after adding `delta` cents, never below $0. Text it can't read is left alone. */
export function nudged(text, delta) {
	const cents = fieldCents(text);
	return cents === null ? text : showCents(Math.max(0, cents + delta));
}

/** The next whole dollar, or null when there are no cents to round. */
export function roundedUp(text) {
	const cents = fieldCents(text);
	if (cents === null || cents % 100 === 0) return null;
	return showCents(Math.ceil(cents / 100) * 100);
}

/** Typing stops at two decimals. */
export function capDecimals(text) {
	const dot = text.indexOf(".");
	return dot === -1 ? text : text.slice(0, dot + 3);
}

/** Brings the buttons and chips in line with the field. */
function update(root) {
	const input = root.querySelector("[data-money-input]");
	if (!input) return;
	const cents = fieldCents(input.value);
	for (const minus of root.querySelectorAll("[data-nudge^='-']")) {
		minus.disabled = cents === null || cents === 0;
	}
	const round = root.querySelector("[data-roundup]");
	if (round) {
		const up = roundedUp(input.value);
		round.hidden = up === null;
		if (up !== null) round.textContent = `Round up to $${up}`;
	}
	for (const chip of root.querySelectorAll("[data-set]")) {
		chip.setAttribute(
			"aria-pressed",
			String(cents === Number(chip.dataset.set)),
		);
	}
}

/** Puts new text in the field and says it, since the field isn't what has focus. */
function set(root, text) {
	const input = root.querySelector("[data-money-input]");
	if (!input) return;
	input.value = text;
	update(root);
	const region = document.getElementById("announcer");
	if (region) {
		region.textContent = "";
		requestAnimationFrame(() => {
			region.textContent = `$${text}`;
		});
	}
}

if (typeof document !== "undefined") {
	// Shows the buttons and chips (CSS: html.js [data-money-js]).
	document.documentElement.classList.add("js");

	document.addEventListener("click", (event) => {
		const button = event.target.closest?.(
			"[data-nudge], [data-roundup], [data-set]",
		);
		const root = button?.closest("[data-money]");
		if (!button || !root || button.disabled) return;
		const input = root.querySelector("[data-money-input]");
		if (!input) return;
		if (button.dataset.nudge) {
			set(root, nudged(input.value, Number(button.dataset.nudge)));
		} else if (button.dataset.set) {
			set(root, showCents(Number(button.dataset.set)));
		} else {
			const up = roundedUp(input.value);
			if (up !== null) set(root, up);
		}
	});

	document.addEventListener("input", (event) => {
		const input = event.target;
		if (!input.matches?.("[data-money-input]")) return;
		const capped = capDecimals(input.value);
		if (capped !== input.value) input.value = capped;
		const root = input.closest("[data-money]");
		if (root) update(root);
	});
}

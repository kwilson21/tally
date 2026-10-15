// The money input's helpers (#66, decision 39), after the original app's currency input: nudge by a
// cent or a dollar, round up, use last month's amount, and stop typing at two decimals. All math is
// integer cents. Without this script the buttons stay hidden and the field is a plain text field.

// The same format the server saves (src/money.ts toCents): digits, commas in threes, one or two decimals.
const DOLLARS = /^\$?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/;

// The same words the server writes (src/money.ts formatCents): "$1,234.50", or "$1,235" with whole dollars.
const money = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
});
const wholeMoney = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	maximumFractionDigits: 0,
});

/** The field's text as integer cents: "" is 0, anything unreadable is null. */
export function fieldCents(text) {
	const trimmed = text.trim();
	if (trimmed === "") return 0;
	if (!DOLLARS.test(trimmed)) return null;
	const [whole = "", fraction = ""] = trimmed.replace(/[$,]/g, "").split(".");
	return Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
}

/** Integer cents as the field shows them, always with cents, as in the original: "612.40", "612.00". */
export function showCents(cents) {
	return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** Integer cents as the screen reader hears them and Round to shows them: "$1,234.50", or "$1,235" when whole. */
export function dollars(cents, whole = false) {
	return (whole ? wholeMoney : money).format(cents / 100);
}

/** The field after adding `delta` cents, never below $0. Text it can't read is left alone, and ↓ at $0 does nothing. */
export function nudged(text, delta) {
	const cents = fieldCents(text);
	if (cents === null || (cents === 0 && delta < 0)) return text;
	return showCents(Math.max(0, cents + delta));
}

/** The next whole dollar, or null when there are no cents to round. */
export function roundedUp(text) {
	const cents = fieldCents(text);
	if (cents === null || cents % 100 === 0) return null;
	return showCents(Math.ceil(cents / 100) * 100);
}

/** Typing stops at two decimals: a pasted amount is cut to them. */
export function capDecimals(text) {
	const dot = text.indexOf(".");
	return dot === -1 ? text : text.slice(0, dot + 3);
}

/** True when the text has a digit after its second decimal place. */
export function thirdDecimal(text) {
	const dot = text.indexOf(".");
	return dot !== -1 && text.length - dot - 1 > 2;
}

/** True when typing `typed` over the selection would make a third decimal, so the key is refused. */
export function refusesInsert(text, start, end, typed) {
	return thirdDecimal(text.slice(0, start) + typed + text.slice(end));
}

/**
 * Round to's state for the field's text and the offer it last made ("" for none): the offer to keep, its
 * words, whether it's ticked (the box is at the offer, after use) and whether it's hidden.
 */
export function roundState(text, offer) {
	const up = roundedUp(text);
	const cents = fieldCents(text);
	const ticked =
		up === null && cents !== null && offer !== "" && cents === Number(offer);
	const kept = up === null ? offer : String(fieldCents(up));
	return {
		offer: kept,
		label: kept === "" ? "" : `Round to ${dollars(Number(kept), true)}`,
		pressed: ticked,
		hidden: up === null && !ticked,
	};
}

/** Says a message in the announcer. Clearing it first and setting it a frame later makes each one say itself again. */
function say(message) {
	const region = document.getElementById("announcer");
	if (!region) return;
	region.textContent = "";
	requestAnimationFrame(() => {
		region.textContent = message;
	});
}

/** Brings the steps, Round to and chips in line with the field's text. */
export function update(root) {
	const input = root.querySelector("[data-money-input]");
	if (!input) return;
	const cents = fieldCents(input.value);
	for (const step of root.querySelectorAll("[data-nudge]")) {
		step.disabled =
			cents === null || (cents === 0 && Number(step.dataset.nudge) < 0);
	}
	const round = root.querySelector("[data-roundup]");
	if (round) {
		const state = roundState(input.value, round.dataset.roundup ?? "");
		round.dataset.roundup = state.offer;
		if (state.label)
			round.querySelector("[data-roundup-label]").textContent = state.label;
		round.hidden = state.hidden;
		round.setAttribute("aria-pressed", String(state.pressed));
	}
	for (const chip of root.querySelectorAll("[data-set]")) {
		chip.setAttribute(
			"aria-pressed",
			String(cents === Number(chip.dataset.set)),
		);
	}
}

/** Puts new text in the field and says the amount, so a button and the arrow keys are heard alike. */
export function set(root, text) {
	const input = root.querySelector("[data-money-input]");
	if (!input) return;
	input.value = text;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	update(root);
	const cents = fieldCents(text);
	if (cents !== null) say(dollars(cents));
}

/** Moves the amount by `delta` cents, when that changes it. */
export function nudge(root, delta) {
	const input = root.querySelector("[data-money-input]");
	if (!input) return;
	const next = nudged(input.value, delta);
	if (next !== input.value) set(root, next);
}

/**
 * A press on a step, a chip or Round to. A step that switches off while it has focus hands focus to its
 * pair (− to +$1, ▼ to ▲), so focus never drops to the body.
 */
export function press(root, button) {
	if (button.disabled || !root.querySelector("[data-money-input]")) return;
	const hadFocus = document.activeElement === button;
	if (button.dataset.nudge) {
		nudge(root, Number(button.dataset.nudge));
	} else if (button.dataset.set) {
		set(root, showCents(Number(button.dataset.set)));
	} else {
		const up = roundedUp(root.querySelector("[data-money-input]").value);
		if (up !== null) set(root, up);
	}
	if (hadFocus && button.dataset.nudge && button.disabled) {
		root
			.querySelector(`[data-nudge="${-Number(button.dataset.nudge)}"]`)
			?.focus();
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
		if (button && root) press(root, button);
	});

	// As in the original's number field: ↑ / ↓ change the amount by a cent, and by a dollar with Shift.
	document.addEventListener("keydown", (event) => {
		const input = event.target;
		if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
		if (
			!input.matches?.("[data-money-input]") ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey
		)
			return;
		const root = input.closest("[data-money]");
		if (!root) return;
		event.preventDefault();
		const step = event.shiftKey ? 100 : 1;
		nudge(root, event.key === "ArrowUp" ? step : -step);
	});

	// A typed third decimal is refused before it lands: the box and the caret stay as they were.
	document.addEventListener("beforeinput", (event) => {
		const input = event.target;
		if (
			event.inputType !== "insertText" ||
			!input.matches?.("[data-money-input]")
		)
			return;
		if (
			refusesInsert(
				input.value,
				input.selectionStart,
				input.selectionEnd,
				event.data ?? "",
			)
		)
			event.preventDefault();
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

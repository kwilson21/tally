import { afterEach, describe, expect, it, vi } from "vitest";
import {
	capDecimals,
	dollars,
	fieldCents,
	nudge,
	nudged,
	onBeforeInput,
	onInput,
	onKeydown,
	press,
	refusesInsert,
	roundedUp,
	roundState,
	set,
	showCents,
	thirdDecimal,
	update,
} from "../public/js/money.js";
// The browser script's pure parts and its DOM steps: integer cents in, the field's text out.
import { formatCents } from "../src/money";

describe("fieldCents (the field's text → cents, or null)", () => {
	it.each([
		["612.40", 61240],
		["612.4", 61240],
		["0.05", 5],
		["612", 61200],
		["$1,234.56", 123456],
		["0", 0],
		["", 0],
		["  7.05 ", 705],
	])("%j → %i", (text, cents) => {
		expect(fieldCents(text)).toBe(cents);
	});

	it("gives null for anything else, so the buttons leave it alone", () => {
		expect(fieldCents("abc")).toBeNull();
		expect(fieldCents("1.2.3")).toBeNull();
		expect(fieldCents("-5")).toBeNull();
		// The same format the server saves: digits before the point, one or two after it.
		expect(fieldCents(".5")).toBeNull();
		expect(fieldCents("12.")).toBeNull();
		expect(fieldCents("$")).toBeNull();
	});
});

describe("programmatic money controls", () => {
	it("dispatches a bubbling input event after changing the field", () => {
		const input = new EventTarget() as EventTarget & { value: string };
		input.value = "1.00";
		const events: Event[] = [];
		input.addEventListener("input", (event) => {
			events.push(event);
		});
		const root = {
			querySelector: (selector: string) =>
				selector === "[data-money-input]" ? input : null,
			querySelectorAll: () => [],
		};
		Object.defineProperty(globalThis, "document", {
			value: { getElementById: () => null },
			configurable: true,
		});
		set(root, "2.00");
		expect(input.value).toBe("2.00");
		expect(events).toHaveLength(1);
		expect(events[0]?.bubbles).toBe(true);
		Reflect.deleteProperty(globalThis, "document");
	});
});

describe("showCents (cents → the field's text, always with cents, as in the original)", () => {
	it.each([
		[61240, "612.40"],
		[61200, "612.00"],
		[5, "0.05"],
		[0, "0.00"],
	])("%i → %j", (cents, text) => {
		expect(showCents(cents)).toBe(text);
	});
});

describe("nudged", () => {
	it("adds or takes away cents and dollars exactly", () => {
		expect(nudged("612.40", 1)).toBe("612.41");
		expect(nudged("612.40", -1)).toBe("612.39");
		expect(nudged("612.40", 100)).toBe("613.40");
		expect(nudged("0.10", -1)).toBe("0.09");
		// 0.1 + 0.2 style float errors can't happen: it's all integer cents.
		expect(nudged("0.29", 1)).toBe("0.30");
	});

	it("never goes below $0", () => {
		expect(nudged("0.50", -100)).toBe("0.00");
	});

	it("does nothing when ↓ is pressed at $0: the text stays as it is", () => {
		expect(nudged("0", -1)).toBe("0");
		expect(nudged("0.00", -1)).toBe("0.00");
		expect(nudged("", -1)).toBe("");
	});

	it("starts from $0 when the field is empty", () => {
		expect(nudged("", 100)).toBe("1.00");
		expect(nudged("", 1)).toBe("0.01");
	});

	it("leaves text it can't read alone", () => {
		expect(nudged("abc", 100)).toBe("abc");
	});
});

describe("dollars (the words the server's formatCents writes)", () => {
	it.each([
		[123450, false],
		[61300, true],
		[0, false],
		[5, false],
		[100000000, false],
	])("%i (whole: %s) matches formatCents", (cents, whole) => {
		expect(dollars(cents, whole)).toBe(
			formatCents(cents, { wholeDollars: whole }),
		);
	});

	it("writes thousands with commas, and Round to's whole dollars", () => {
		expect(dollars(123450)).toBe("$1,234.50");
		expect(dollars(123500, true)).toBe("$1,235");
	});
});

describe("roundedUp", () => {
	it("goes up to the next whole dollar when there are cents", () => {
		expect(roundedUp("250.01")).toBe("251.00");
		expect(roundedUp("612.40")).toBe("613.00");
	});

	it("is null when there's nothing to round", () => {
		expect(roundedUp("250")).toBeNull();
		expect(roundedUp("0")).toBeNull();
		expect(roundedUp("abc")).toBeNull();
	});
});

describe("capDecimals (a pasted amount is cut to two decimals)", () => {
	it("stops typing at two decimals", () => {
		expect(capDecimals("12.345")).toBe("12.34");
		expect(capDecimals("12.3")).toBe("12.3");
		expect(capDecimals("1234")).toBe("1234");
	});
});

describe("thirdDecimal and refusesInsert (a typed third decimal is refused)", () => {
	it("sees a digit after the second decimal place", () => {
		expect(thirdDecimal("12.345")).toBe(true);
		expect(thirdDecimal("12.34")).toBe(false);
		expect(thirdDecimal("1234")).toBe(false);
	});

	it("refuses the key that would make it, wherever the caret is", () => {
		expect(refusesInsert("12.34", 5, 5, "5")).toBe(true);
		expect(refusesInsert("12.34", 4, 4, "5")).toBe(true);
		expect(refusesInsert("12.3", 4, 4, "5")).toBe(false);
	});

	it("allows typing that keeps two decimals or less", () => {
		// Replacing the whole text, typing before the point, and typing the point itself.
		expect(refusesInsert("12.34", 0, 5, "7")).toBe(false);
		expect(refusesInsert("12.34", 2, 2, "5")).toBe(false);
		expect(refusesInsert("12", 2, 2, ".5")).toBe(false);
	});
});

// The fake DOM money.js touches: the field, the steps and chips, Round to with its label, the announcer and focus.
type Control = {
	dataset: Record<string, string>;
	disabled: boolean;
	hidden: boolean;
	textContent: string;
	value: string;
	attrs: Record<string, string>;
	setAttribute: (name: string, value: string) => void;
	focus: () => void;
	querySelector: (selector: string) => Control | null;
	dispatchEvent: (event: Event) => boolean;
	/** The field's own parts, set by the keyboard and typing tests: a plain control matches nothing. */
	matches?: (selector: string) => boolean;
	closest?: (selector: string) => unknown;
	selectionStart?: number;
	selectionEnd?: number;
};

const browser = {
	activeElement: null as Control | null,
	region: { textContent: "" },
};

function control(dataset: Record<string, string> = {}): Control {
	const el: Control = {
		dataset,
		disabled: false,
		hidden: false,
		textContent: "",
		value: "",
		attrs: {},
		setAttribute(name, value) {
			el.attrs[name] = value;
		},
		focus() {
			if (!el.disabled) browser.activeElement = el;
		},
		querySelector: () => null,
		dispatchEvent: () => true,
	};
	return el;
}

/** A money box with its field, the four steps, Round to (offering `offer` cents) and one Last month chip. */
function widget(text: string, offer = "") {
	const input = control({ moneyInput: "" });
	input.value = text;
	const minus = control({ nudge: "-100" });
	const plus = control({ nudge: "100" });
	const up = control({ nudge: "1" });
	const down = control({ nudge: "-1" });
	const label = control();
	const round = control({ roundup: offer });
	round.querySelector = (selector) =>
		selector === "[data-roundup-label]" ? label : null;
	const lastMonth = control({ set: "57180" });
	const byId: Record<string, Control> = {
		"[data-money-input]": input,
		"[data-roundup]": round,
		'[data-nudge="100"]': plus,
		'[data-nudge="-100"]': minus,
		'[data-nudge="1"]': up,
		'[data-nudge="-1"]': down,
	};
	const root = {
		querySelector: (selector: string) => byId[selector] ?? null,
		querySelectorAll: (selector: string) =>
			selector === "[data-nudge]"
				? [minus, plus, up, down]
				: selector === "[data-set]"
					? [lastMonth]
					: [],
	};
	return { root, input, minus, plus, up, down, round, label, lastMonth };
}

describe("browser steps (the fake DOM stands in for the page)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		browser.activeElement = null;
		browser.region.textContent = "";
	});

	function browserStubs() {
		vi.stubGlobal("document", {
			get activeElement() {
				return browser.activeElement;
			},
			getElementById: (id: string) =>
				id === "announcer" ? browser.region : null,
		});
		vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
			callback(),
		);
	}

	describe("set and nudge say the amount, as formatCents writes it", () => {
		it("announces a changed amount with commas and cents", () => {
			browserStubs();
			const { root, input } = widget("612.40");
			set(root, "1234.5");
			expect(input.value).toBe("1234.5");
			expect(browser.region.textContent).toBe("$1,234.50");
		});

		it("says each step, so ↑ and ↓ are heard as the buttons are", () => {
			browserStubs();
			const { root, input } = widget("612.40");
			nudge(root, 1);
			expect(input.value).toBe("612.41");
			expect(browser.region.textContent).toBe("$612.41");
			nudge(root, -100);
			expect(browser.region.textContent).toBe("$611.41");
		});

		it("says nothing for a ↓ at $0, and changes nothing", () => {
			browserStubs();
			const { root, input } = widget("0");
			nudge(root, -1);
			expect(input.value).toBe("0");
			expect(browser.region.textContent).toBe("");
		});

		it("says nothing for text it can't read", () => {
			browserStubs();
			const { root } = widget("six hundred");
			set(root, "six hundred");
			expect(browser.region.textContent).toBe("");
		});
	});

	describe("update: the steps follow the field", () => {
		it("turns all four steps off while the text can't be read, and hides Round to", () => {
			const { root, minus, plus, up, down, round, lastMonth } =
				widget("six hundred");
			update(root);
			for (const step of [minus, plus, up, down]) {
				expect(step.disabled).toBe(true);
			}
			expect(round.hidden).toBe(true);
			expect(round.attrs["aria-pressed"]).toBe("false");
			expect(lastMonth.attrs["aria-pressed"]).toBe("false");
		});

		it("turns the minus steps off at $0, and leaves + and ▲ on", () => {
			for (const text of ["0.00", ""]) {
				const { root, minus, plus, up, down } = widget(text);
				update(root);
				expect(minus.disabled).toBe(true);
				expect(down.disabled).toBe(true);
				expect(plus.disabled).toBe(false);
				expect(up.disabled).toBe(false);
			}
		});

		it("turns every step on for a readable amount", () => {
			const { root, minus, plus, up, down } = widget("612.40");
			update(root);
			for (const step of [minus, plus, up, down]) {
				expect(step.disabled).toBe(false);
			}
		});

		it("presses the chip whose amount is in the box, and only that one", () => {
			const matched = widget("571.80");
			update(matched.root);
			expect(matched.lastMonth.attrs["aria-pressed"]).toBe("true");
			const other = widget("600.00");
			update(other.root);
			expect(other.lastMonth.attrs["aria-pressed"]).toBe("false");
		});
	});

	describe("Round to: offered with cents, and kept ticked after use", () => {
		it.each([
			[
				"612.45",
				"",
				{
					offer: "61300",
					label: "Round to $613",
					pressed: false,
					hidden: false,
				},
			],
			[
				"613.00",
				"61300",
				{
					offer: "61300",
					label: "Round to $613",
					pressed: true,
					hidden: false,
				},
			],
			[
				"600.00",
				"61300",
				{
					offer: "61300",
					label: "Round to $613",
					pressed: false,
					hidden: true,
				},
			],
			[
				"613.01",
				"61300",
				{
					offer: "61400",
					label: "Round to $614",
					pressed: false,
					hidden: false,
				},
			],
			["613.00", "", { offer: "", label: "", pressed: false, hidden: true }],
			[
				"six",
				"61300",
				{
					offer: "61300",
					label: "Round to $613",
					pressed: false,
					hidden: true,
				},
			],
		])("%j with offer %j", (text, offer, expected) => {
			expect(roundState(text, offer)).toMatchObject(expected);
		});

		it("stays ticked after use, and offers again once the amount has cents", () => {
			browserStubs();
			const { root, input, round, label, down } = widget("612.45");
			update(root);
			expect(label.textContent).toBe("Round to $613");
			press(root, round);
			expect(input.value).toBe("613.00");
			expect(round.hidden).toBe(false);
			expect(round.attrs["aria-pressed"]).toBe("true");
			// ↓ takes a cent: the chip is still there, unticked, offering the same dollar.
			press(root, down);
			expect(input.value).toBe("612.99");
			expect(round.attrs["aria-pressed"]).toBe("false");
			expect(label.textContent).toBe("Round to $613");
		});
	});

	describe("press: a step that switches off keeps focus on its pair", () => {
		it("moves focus from − to +$1 when − reaches $0", () => {
			browserStubs();
			const { root, input, minus, plus } = widget("0.50");
			browser.activeElement = minus;
			press(root, minus);
			expect(input.value).toBe("0.00");
			expect(minus.disabled).toBe(true);
			expect(browser.activeElement).toBe(plus);
		});

		it("moves focus from ▼ to ▲ when ▼ reaches $0", () => {
			browserStubs();
			const { root, input, down, up } = widget("0.01");
			browser.activeElement = down;
			press(root, down);
			expect(input.value).toBe("0.00");
			expect(down.disabled).toBe(true);
			expect(browser.activeElement).toBe(up);
		});

		it("leaves focus where it was when the step never had it", () => {
			browserStubs();
			const { root, down } = widget("0.01");
			press(root, down);
			expect(browser.activeElement).toBeNull();
		});
	});

	describe("the field's keys and typing: the document listeners, as events", () => {
		/** An event sent to the field, which matches its selector and sits in its money box. */
		function fieldEvent(
			input: Control,
			root: object,
			init: Record<string, unknown>,
		) {
			input.matches = (selector) => selector === "[data-money-input]";
			input.closest = (selector) => (selector === "[data-money]" ? root : null);
			return { target: input, preventDefault: vi.fn(), ...init };
		}

		it("↑ and ↓ move the amount by a cent, and Shift by a dollar, and say it", () => {
			browserStubs();
			const { root, input } = widget("5.00");
			const up = fieldEvent(input, root, { key: "ArrowUp" });
			onKeydown(up);
			expect(input.value).toBe("5.01");
			expect(up.preventDefault).toHaveBeenCalledOnce();
			expect(browser.region.textContent).toBe("$5.01");

			const shiftUp = fieldEvent(input, root, {
				key: "ArrowUp",
				shiftKey: true,
			});
			onKeydown(shiftUp);
			expect(input.value).toBe("6.01");
			expect(browser.region.textContent).toBe("$6.01");

			const shiftDown = fieldEvent(input, root, {
				key: "ArrowDown",
				shiftKey: true,
			});
			onKeydown(shiftDown);
			expect(input.value).toBe("5.01");
			expect(browser.region.textContent).toBe("$5.01");
		});

		it("keeps the text at $0 when ↓ is pressed, and says nothing", () => {
			browserStubs();
			const { root, input } = widget("0.00");
			const down = fieldEvent(input, root, { key: "ArrowDown" });
			onKeydown(down);
			expect(input.value).toBe("0.00");
			expect(browser.region.textContent).toBe("");
		});

		it("leaves Alt, Ctrl and Cmd arrows to the browser, and other keys alone", () => {
			browserStubs();
			const { root, input } = widget("5.00");
			for (const init of [
				{ key: "ArrowUp", altKey: true },
				{ key: "ArrowUp", ctrlKey: true },
				{ key: "ArrowDown", metaKey: true },
				{ key: "ArrowLeft" },
			]) {
				const event = fieldEvent(input, root, init);
				onKeydown(event);
				expect(event.preventDefault).not.toHaveBeenCalled();
			}
			expect(input.value).toBe("5.00");
		});

		it("ignores ↑ pressed anywhere but the field", () => {
			browserStubs();
			const { input } = widget("5.00");
			const elsewhere = {
				key: "ArrowUp",
				target: control(),
				preventDefault: vi.fn(),
			};
			onKeydown(elsewhere);
			expect(elsewhere.preventDefault).not.toHaveBeenCalled();
			expect(input.value).toBe("5.00");
		});

		it("refuses a typed third decimal: the box and the caret stay as they were", () => {
			const { input } = widget("12.34");
			input.selectionStart = 5;
			input.selectionEnd = 5;
			input.matches = (selector) => selector === "[data-money-input]";
			const typed = {
				target: input,
				inputType: "insertText",
				data: "5",
				preventDefault: vi.fn(),
			};
			onBeforeInput(typed);
			expect(typed.preventDefault).toHaveBeenCalledOnce();
			expect(input.value).toBe("12.34");
		});

		it("lets a digit through that keeps two decimals or less, and deletions", () => {
			const { input } = widget("12.3");
			input.selectionStart = 4;
			input.selectionEnd = 4;
			input.matches = (selector) => selector === "[data-money-input]";
			const digit = {
				target: input,
				inputType: "insertText",
				data: "4",
				preventDefault: vi.fn(),
			};
			onBeforeInput(digit);
			expect(digit.preventDefault).not.toHaveBeenCalled();
			const deletion = {
				target: input,
				inputType: "deleteContentBackward",
				data: null,
				preventDefault: vi.fn(),
			};
			onBeforeInput(deletion);
			expect(deletion.preventDefault).not.toHaveBeenCalled();
		});

		it("cuts a pasted amount to two decimals, and updates the steps", () => {
			browserStubs();
			const { root, input, minus } = widget("12.3");
			input.value = "12.345";
			input.matches = (selector) => selector === "[data-money-input]";
			input.closest = (selector) => (selector === "[data-money]" ? root : null);
			onInput({ target: input });
			expect(input.value).toBe("12.34");
			expect(minus.disabled).toBe(false);
		});
	});
});

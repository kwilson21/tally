import { afterEach, describe, expect, it, vi } from "vitest";

// sheet.js is a classic script with no exports, so it runs against a small stand-in for the page, as
// toast-js.test.ts does. htmx's events bubble, so the test sends them to document the way htmx does.

const load = Object.values(import.meta.glob("../public/js/sheet.js"))[0] as
	| (() => Promise<unknown>)
	| undefined;

/** The document the script is running against, so a node that is focused becomes its activeElement. */
let activeDocument: { activeElement: unknown } | null = null;

/** One simple selector: an optional tag, then [attribute] or [attribute=value] parts. */
function matchesSimple(node: FakeNode, selector: string) {
	const [, tag = "", conditions = ""] =
		selector.trim().match(/^(\w*)((?:\[[^\]]+\])*)$/) ?? [];
	if (!tag && !conditions) return false;
	if (tag && node.tag !== tag) return false;
	return [...conditions.matchAll(/\[([^=\]]+)(?:=([^\]]+))?\]/g)].every(
		([, name = "", value]) =>
			node.attrs.has(name) &&
			(value === undefined || node.attrs.get(name) === value),
	);
}

class FakeNode extends EventTarget {
	children: FakeNode[] = [];
	parentElement: FakeNode | null = null;
	attrs = new Map<string, string>();
	id = "";
	disabled = false;
	/** A node with display: none has no boxes, so it can't take focus. */
	hidden = false;
	/** A form control's type, name, checked state and form owner, which sheet.js reads as properties. */
	type = "";
	name = "";
	checked = false;
	form: FakeNode | null = null;
	tabIndex: number;
	/** How many times the node was clicked, by the script or by a test. */
	clicks = 0;
	constructor(readonly tag: string) {
		super();
		this.tabIndex = [
			"a",
			"button",
			"input",
			"select",
			"textarea",
			"summary",
		].includes(tag)
			? 0
			: -1;
	}
	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
		if (name === "id") this.id = value;
	}
	getAttribute(name: string) {
		return this.attrs.get(name) ?? null;
	}
	hasAttribute(name: string) {
		return this.attrs.has(name);
	}
	removeAttribute(name: string) {
		this.attrs.delete(name);
	}
	/** Whether the node is the given one or holds it, as a real node's contains() does. */
	contains(node: unknown): boolean {
		return node === this || this.children.some((child) => child.contains(node));
	}
	append(...nodes: FakeNode[]) {
		for (const node of nodes) {
			node.remove();
			node.parentElement = this;
			this.children.push(node);
		}
	}
	remove() {
		const parent = this.parentElement;
		if (parent) parent.children.splice(parent.children.indexOf(this), 1);
		this.parentElement = null;
	}
	/** Every node under this one, in document order. */
	descendants(): FakeNode[] {
		return this.children.flatMap((child) => [child, ...child.descendants()]);
	}
	querySelectorAll(selector: string): FakeNode[] {
		const parts = selector.split(",");
		return this.descendants().filter((node) =>
			parts.some((part) => matchesSimple(node, part)),
		);
	}
	querySelector(selector: string): FakeNode | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}
	/** As a browser does: a click on a link or button runs its handler, which a test counts. */
	click() {
		this.clicks += 1;
	}
	focus() {
		if (activeDocument) activeDocument.activeElement = this;
	}
	getClientRects() {
		return this.hidden ? [] : [{}];
	}
}

function el(tag: string, attrs: Record<string, string> = {}) {
	const node = new FakeNode(tag);
	for (const [name, value] of Object.entries(attrs))
		node.setAttribute(name, value);
	return node;
}

/** A radio button in a form, as the browser reads it: its name and form are properties, not attributes. */
function radio(form: FakeNode | null, name: string, checked = false) {
	const node = el("input");
	node.type = "radio";
	node.name = name;
	node.form = form;
	node.checked = checked;
	return node;
}

/**
 * A sheet as BottomSheet draws it: its backdrop link, then the section with a heading, a field and Save. The section
 * is labelled by its heading, as BottomSheet's labelledBy does. `autofocus` marks the field, as a form's first field does.
 */
function drawSheet(sheetSlot: FakeNode, { autofocus = false } = {}) {
	const backdrop = el("a", { href: "/transactions", "data-sheet-close": "" });
	const section = el("section", {
		"data-sheet": "",
		"aria-labelledby": "sheet-title",
	});
	const title = el("h2", { id: "sheet-title", tabindex: "-1" });
	title.tabIndex = -1;
	const field = el("input", autofocus ? { autofocus: "" } : {});
	const save = el("button");
	section.append(title, field, save);
	sheetSlot.append(backdrop, section);
	return { backdrop, section, title, field, save };
}

/** A sheet whose middle is a form of radios: the heading, the form holding the radios, then Save. */
function drawRadioSheet(
	sheetSlot: FakeNode,
	form: FakeNode,
	radios: FakeNode[],
) {
	const backdrop = el("a", { href: "/transactions", "data-sheet-close": "" });
	const section = el("section", {
		"data-sheet": "",
		"aria-labelledby": "sheet-title",
	});
	const title = el("h2", { id: "sheet-title", tabindex: "-1" });
	title.tabIndex = -1;
	const save = el("button");
	form.append(...radios);
	section.append(title, form, save);
	sheetSlot.append(backdrop, section);
	return { backdrop, section, title, save };
}

/**
 * A page as Layout draws it: body > [skip link, the frame (aside and main), the tab bar, the feedback
 * button, #toasts, #announcer]. The main holds the header, the list and #sheet, where a sheet sits.
 * The tab bar is inert before the script runs, as a page drawn that way is.
 */
function drawPage({
	sheet = true,
	autofocus = false,
}: {
	sheet?: boolean;
	autofocus?: boolean;
} = {}) {
	const documentElement = el("html");
	const body = el("body");
	documentElement.append(body);
	const skip = el("a", { href: "#main" });
	const aside = el("aside");
	const header = el("h1");
	const list = el("ul");
	const row = el("a", { href: "/transactions/1" });
	list.append(row);
	const sheetSlot = el("div", { id: "sheet" });
	const main = el("main", { id: "main" });
	main.append(header, list, sheetSlot);
	const frame = el("div");
	frame.append(aside, main);
	const tabs = el("nav");
	tabs.setAttribute("inert", "");
	const feedback = el("button");
	const toasts = el("div", { id: "toasts" });
	const undo = el("button");
	toasts.append(undo);
	const announcer = el("div", { id: "announcer" });
	body.append(skip, frame, tabs, feedback, toasts, announcer);
	const drawn = sheet ? drawSheet(sheetSlot, { autofocus }) : null;
	return {
		documentElement,
		body,
		skip,
		aside,
		header,
		list,
		row,
		main,
		sheetSlot,
		frame,
		tabs,
		feedback,
		toasts,
		undo,
		announcer,
		drawn,
	};
}

type Page = ReturnType<typeof drawPage>;

/**
 * Runs sheet.js against a page, as the page's document, and returns the page with its document.
 * `beforeScript` runs first, so a test can put another keydown handler ahead of the script's.
 */
async function sheetPage(
	options: {
		sheet?: boolean;
		/** The sheet's field is autofocus, as a form's first field can be. */
		autofocus?: boolean;
		beforeScript?: (doc: EventTarget) => void;
	} = {},
) {
	const parts = drawPage({
		sheet: options.sheet,
		autofocus: options.autofocus,
	});
	const doc = Object.assign(new EventTarget(), {
		body: parts.body,
		documentElement: parts.documentElement,
		activeElement: parts.row as unknown,
		querySelector: (selector: string) => parts.body.querySelector(selector),
		querySelectorAll: (selector: string) =>
			parts.body.querySelectorAll(selector),
		getElementById: (id: string) =>
			parts.body.descendants().find((node) => node.id === id) ?? null,
	});
	vi.stubGlobal("document", doc);
	activeDocument = doc;
	options.beforeScript?.(doc);
	vi.resetModules();
	await load?.();
	return { ...parts, document: doc };
}

/** The page after a sheet is drawn in it again: a field's error redraws the open sheet in its place. */
function redrawSheet(parts: Page, options: { autofocus?: boolean } = {}) {
	parts.drawn?.backdrop.remove();
	parts.drawn?.section.remove();
	return drawSheet(parts.sheetSlot, options);
}

/** The sheet leaves the page, as the close swap takes it out, and htmx reports the swap. */
function closeSheet(parts: Page & { document: EventTarget }) {
	for (const child of [...parts.sheetSlot.children]) child.remove();
	settle(parts.document);
}

function settle(doc: EventTarget) {
	doc.dispatchEvent(new Event("htmx:after:settle", { bubbles: true }));
}

/** htmx has put a swap's new content in place: the event sheet.js also listens for, as settle is. */
function swap(doc: EventTarget) {
	doc.dispatchEvent(new Event("htmx:after:swap", { bubbles: true }));
}

function keydown(
	doc: EventTarget,
	key: string,
	init: { shiftKey?: boolean; isComposing?: boolean } = {},
) {
	const event = Object.assign(new Event("keydown", { cancelable: true }), {
		key,
		shiftKey: init.shiftKey ?? false,
		isComposing: init.isComposing ?? false,
	});
	doc.dispatchEvent(event);
	return event;
}

afterEach(() => {
	vi.unstubAllGlobals();
	activeDocument = null;
});

describe("sheet.js: an open sheet is a modal", () => {
	it("sets aria-modal on the sheet, and inert on the page around it but not on the sheet, its backdrop, the toasts or the announcer", async () => {
		const parts = await sheetPage();
		const section = parts.drawn?.section;
		expect(section?.getAttribute("aria-modal")).toBe("true");
		for (const outside of [
			parts.skip,
			parts.aside,
			parts.header,
			parts.list,
			parts.tabs,
			parts.feedback,
		]) {
			expect(outside.hasAttribute("inert")).toBe(true);
		}
		for (const kept of [
			section,
			parts.drawn?.backdrop,
			parts.toasts,
			parts.announcer,
			parts.main,
			parts.sheetSlot,
			parts.frame,
		]) {
			expect(kept?.hasAttribute("inert")).toBe(false);
		}
	});

	it("takes inert off exactly what it set when the sheet leaves, and leaves an element that was inert before untouched", async () => {
		const parts = await sheetPage();
		closeSheet(parts);
		expect(parts.list.hasAttribute("inert")).toBe(false);
		expect(parts.header.hasAttribute("inert")).toBe(false);
		expect(parts.aside.hasAttribute("inert")).toBe(false);
		expect(parts.tabs.hasAttribute("inert")).toBe(true);
		expect(parts.tabs.hasAttribute("data-sheet-inert")).toBe(false);
	});

	it("keeps the page inert, without doubling up, when a redrawn sheet replaces the open one", async () => {
		const parts = await sheetPage();
		const redrawn = redrawSheet(parts);
		settle(parts.document);
		expect(redrawn.section.getAttribute("aria-modal")).toBe("true");
		expect(parts.list.hasAttribute("inert")).toBe(true);
		expect(parts.toasts.hasAttribute("inert")).toBe(false);
		closeSheet(parts);
		expect(parts.list.hasAttribute("inert")).toBe(false);
		expect(parts.tabs.hasAttribute("inert")).toBe(true);
	});

	it("releases marks a page snapshot carried over from a sheet that was open when it was taken", async () => {
		const parts = await sheetPage({ sheet: false });
		parts.list.setAttribute("inert", "");
		parts.list.setAttribute("data-sheet-inert", "");
		settle(parts.document);
		expect(parts.list.hasAttribute("inert")).toBe(false);
		expect(parts.list.hasAttribute("data-sheet-inert")).toBe(false);
	});

	it("does nothing to a page with no sheet", async () => {
		const parts = await sheetPage({ sheet: false });
		expect(parts.list.hasAttribute("inert")).toBe(false);
		expect(parts.body.querySelectorAll("[inert]")).toEqual([parts.tabs]);
	});
});

describe("sheet.js: focus goes into the sheet", () => {
	it("moves focus from the row the sheet covers to the sheet's title when the page loads", async () => {
		const parts = await sheetPage();
		expect(parts.document.activeElement).toBe(parts.drawn?.title);
		expect(parts.drawn?.title.getAttribute("tabindex")).toBe("-1");
	});

	it("moves focus from the body to the sheet's title when a swap or a settle runs", async () => {
		const parts = await sheetPage();
		parts.body.focus();
		settle(parts.document);
		expect(parts.document.activeElement).toBe(parts.drawn?.title);
	});

	it("gives focus to the sheet's [autofocus] field, not its title, when the page loads", async () => {
		const parts = await sheetPage({ autofocus: true });
		expect(parts.document.activeElement).toBe(parts.drawn?.field);
	});

	it("moves focus from a control the redraw removed to the redrawn sheet's [autofocus] field", async () => {
		const parts = await sheetPage();
		parts.drawn?.field.focus();
		const redrawn = redrawSheet(parts, { autofocus: true });
		settle(parts.document);
		expect(parts.document.activeElement).toBe(redrawn.field);
	});

	it("moves focus from a control the redraw removed to the redrawn sheet's title, which gets tabindex -1", async () => {
		const parts = await sheetPage();
		parts.drawn?.field.focus();
		const redrawn = redrawSheet(parts);
		redrawn.title.removeAttribute("tabindex");
		settle(parts.document);
		expect(parts.document.activeElement).toBe(redrawn.title);
		expect(redrawn.title.getAttribute("tabindex")).toBe("-1");
	});

	it("leaves focus on a sheet control where a settle finds it", async () => {
		const parts = await sheetPage();
		parts.drawn?.save.focus();
		settle(parts.document);
		expect(parts.document.activeElement).toBe(parts.drawn?.save);
	});

	it("leaves focus on an Undo toast when a swap or a settle runs, since toast.js put it there", async () => {
		const parts = await sheetPage();
		parts.undo.focus();
		swap(parts.document);
		settle(parts.document);
		expect(parts.document.activeElement).toBe(parts.undo);
	});

	it("leaves focus alone on a page with no sheet", async () => {
		const parts = await sheetPage({ sheet: false });
		expect(parts.document.activeElement).toBe(parts.row);
		parts.body.focus();
		swap(parts.document);
		settle(parts.document);
		expect(parts.document.activeElement).toBe(parts.body);
	});
});

describe("sheet.js: Escape", () => {
	it("clicks the sheet's backdrop link, so it closes the way Cancel and the backdrop do", async () => {
		const parts = await sheetPage();
		const event = keydown(parts.document, "Escape");
		expect(parts.drawn?.backdrop.clicks).toBe(1);
		expect(event.defaultPrevented).toBe(true);
	});

	it("does nothing when no sheet is open", async () => {
		const parts = await sheetPage({ sheet: false });
		const event = keydown(parts.document, "Escape");
		expect(event.defaultPrevented).toBe(false);
		expect(parts.list.clicks).toBe(0);
	});

	it("leaves a key another handler already took alone", async () => {
		const parts = await sheetPage({
			beforeScript: (doc) =>
				doc.addEventListener("keydown", (event) => event.preventDefault()),
		});
		keydown(parts.document, "Escape");
		expect(parts.drawn?.backdrop.clicks).toBe(0);
	});

	it("leaves Escape alone while an input method is composing text", async () => {
		const parts = await sheetPage();
		keydown(parts.document, "Escape", { isComposing: true });
		expect(parts.drawn?.backdrop.clicks).toBe(0);
	});

	it("leaves every other key alone", async () => {
		const parts = await sheetPage();
		const event = keydown(parts.document, "a");
		expect(event.defaultPrevented).toBe(false);
		expect(parts.drawn?.backdrop.clicks).toBe(0);
	});
});

describe("sheet.js: Tab stays inside the sheet", () => {
	it("wraps from the last control to the first, and from the first back to the last", async () => {
		const parts = await sheetPage();
		parts.undo.hidden = true;
		const field = parts.drawn?.field;
		const save = parts.drawn?.save;
		save?.focus();
		const forward = keydown(parts.document, "Tab");
		expect(forward.defaultPrevented).toBe(true);
		expect(parts.document.activeElement).toBe(field);
		const backward = keydown(parts.document, "Tab", { shiftKey: true });
		expect(backward.defaultPrevented).toBe(true);
		expect(parts.document.activeElement).toBe(save);
	});

	it("leaves Tab alone between two controls inside the sheet", async () => {
		const parts = await sheetPage();
		parts.drawn?.field.focus();
		const event = keydown(parts.document, "Tab");
		expect(event.defaultPrevented).toBe(false);
	});

	it("counts a disclosure's summary as a stop, so Shift+Tab from it is left to the browser", async () => {
		const parts = await sheetPage();
		const summary = el("summary");
		parts.drawn?.section.append(summary);
		summary.focus();
		const event = keydown(parts.document, "Tab", { shiftKey: true });
		expect(event.defaultPrevented).toBe(false);
	});

	it("takes Tab from an Undo toast on to the sheet's first control, which is the Undo toast's last stop", async () => {
		const parts = await sheetPage();
		parts.undo.focus();
		const event = keydown(parts.document, "Tab");
		expect(event.defaultPrevented).toBe(true);
		expect(parts.document.activeElement).toBe(parts.drawn?.field);
	});
});

describe("sheet.js: an Undo toast on screen is in the Tab cycle", () => {
	it("moves Tab from the sheet's last control to the Undo toast, and from the Undo toast on to the first control", async () => {
		const parts = await sheetPage();
		parts.drawn?.save.focus();
		const forward = keydown(parts.document, "Tab");
		expect(forward.defaultPrevented).toBe(true);
		expect(parts.document.activeElement).toBe(parts.undo);
		const again = keydown(parts.document, "Tab");
		expect(again.defaultPrevented).toBe(true);
		expect(parts.document.activeElement).toBe(parts.drawn?.field);
	});

	it("moves Shift+Tab from the Undo toast back to the sheet's last control, and from the first control to the Undo toast", async () => {
		const parts = await sheetPage();
		parts.undo.focus();
		const back = keydown(parts.document, "Tab", { shiftKey: true });
		expect(back.defaultPrevented).toBe(true);
		expect(parts.document.activeElement).toBe(parts.drawn?.save);
		parts.drawn?.field.focus();
		const wrapped = keydown(parts.document, "Tab", { shiftKey: true });
		expect(wrapped.defaultPrevented).toBe(true);
		expect(parts.document.activeElement).toBe(parts.undo);
	});

	it("skips an Undo toast that is hidden", async () => {
		const parts = await sheetPage();
		parts.undo.hidden = true;
		parts.drawn?.save.focus();
		const event = keydown(parts.document, "Tab");
		expect(event.defaultPrevented).toBe(true);
		expect(parts.document.activeElement).toBe(parts.drawn?.field);
	});

	it("skips an Undo toast whose button is disabled", async () => {
		const parts = await sheetPage();
		parts.undo.disabled = true;
		parts.drawn?.save.focus();
		const event = keydown(parts.document, "Tab");
		expect(event.defaultPrevented).toBe(true);
		expect(parts.document.activeElement).toBe(parts.drawn?.field);
	});

	it("sends Shift+Tab from the body or the heading to the sheet's last control, not to the Undo toast", async () => {
		const parts = await sheetPage();
		parts.body.focus();
		const fromBody = keydown(parts.document, "Tab", { shiftKey: true });
		expect(fromBody.defaultPrevented).toBe(true);
		expect(parts.document.activeElement).toBe(parts.drawn?.save);
		parts.drawn?.title.focus();
		const fromHeading = keydown(parts.document, "Tab", { shiftKey: true });
		expect(fromHeading.defaultPrevented).toBe(true);
		expect(parts.document.activeElement).toBe(parts.drawn?.save);
	});

	it("sends Tab from the body or the heading to the sheet's first control, not to the Undo toast", async () => {
		const parts = await sheetPage();
		parts.body.focus();
		const fromBody = keydown(parts.document, "Tab");
		expect(fromBody.defaultPrevented).toBe(true);
		expect(parts.document.activeElement).toBe(parts.drawn?.field);
		parts.drawn?.title.focus();
		const fromHeading = keydown(parts.document, "Tab");
		expect(fromHeading.defaultPrevented).toBe(true);
		expect(parts.document.activeElement).toBe(parts.drawn?.field);
	});
});

describe("sheet.js: a radio group is one Tab stop", () => {
	/**
	 * A sheet with three radios named "category" in one form, then Save. The Undo toast is hidden, so Save is
	 * the sheet's last stop. `checked` is the number of the radio that is checked, or null for none.
	 */
	async function radioPage(checked: number | null) {
		const parts = await sheetPage({ sheet: false });
		const form = el("form");
		const r1 = radio(form, "category", checked === 1);
		const r2 = radio(form, "category", checked === 2);
		const r3 = radio(form, "category", checked === 3);
		const { save } = drawRadioSheet(parts.sheetSlot, form, [r1, r2, r3]);
		settle(parts.document);
		parts.undo.hidden = true;
		return { ...parts, r1, r2, r3, save };
	}

	it("with the checked radio focused, Shift+Tab goes to Save, the last stop, and stays in the sheet", async () => {
		const parts = await radioPage(2);
		parts.r2.focus();
		const event = keydown(parts.document, "Tab", { shiftKey: true });
		expect(event.defaultPrevented).toBe(true);
		expect(parts.document.activeElement).toBe(parts.save);
	});

	it("Tab from Save lands on the checked radio, not on the first radio of its group", async () => {
		const parts = await radioPage(2);
		parts.save.focus();
		const event = keydown(parts.document, "Tab");
		expect(event.defaultPrevented).toBe(true);
		expect(parts.document.activeElement).toBe(parts.r2);
	});

	it("with no radio checked, the first radio is the group's stop, and Shift+Tab from the last radio of it wraps to Save", async () => {
		const parts = await radioPage(null);
		parts.save.focus();
		keydown(parts.document, "Tab");
		expect(parts.document.activeElement).toBe(parts.r1);
		parts.r3.focus();
		const event = keydown(parts.document, "Tab", { shiftKey: true });
		expect(event.defaultPrevented).toBe(true);
		expect(parts.document.activeElement).toBe(parts.save);
	});

	it("counts a radio with another name, or in another form, as a stop of its own", async () => {
		const parts = await sheetPage({ sheet: false });
		const form = el("form");
		const otherForm = el("form");
		const r1 = radio(form, "category");
		const r2 = radio(form, "other");
		const r3 = radio(otherForm, "category");
		drawRadioSheet(parts.sheetSlot, form, [r1, r2, r3]);
		settle(parts.document);
		parts.undo.hidden = true;
		// Each is its own stop, so Shift+Tab from one of them is left to the browser, which moves to the one before.
		r2.focus();
		expect(
			keydown(parts.document, "Tab", { shiftKey: true }).defaultPrevented,
		).toBe(false);
		r3.focus();
		expect(
			keydown(parts.document, "Tab", { shiftKey: true }).defaultPrevented,
		).toBe(false);
	});
});

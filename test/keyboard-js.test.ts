import { describe, expect, it, vi } from "vitest";
import { keyboard, keysHref } from "../public/js/keyboard.js";

// keyboard.js is a module with no page of its own, so it runs against a small stand-in for the page, as
// sheet-js.test.ts does: an element tree whose focus, clicks and inert ancestors the test can read.

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

const matches = (node: FakeNode, selector: string) =>
	selector.split(",").some((part) => matchesSimple(node, part));

class FakeNode {
	children: FakeNode[] = [];
	parentElement: FakeNode | null = null;
	attrs = new Map<string, string>();
	hidden = false;
	clicks = 0;
	focusCount = 0;
	scrolls: unknown[] = [];
	doc: FakePage | null = null;
	constructor(readonly tag: string) {}
	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
	}
	getAttribute(name: string) {
		return this.attrs.get(name) ?? null;
	}
	hasAttribute(name: string) {
		return this.attrs.has(name);
	}
	/** Whether the node is connected to the page: a node that was removed is not. */
	get isConnected() {
		return this.doc?.nodes.includes(this) ?? false;
	}
	append(...nodes: FakeNode[]) {
		for (const node of nodes) {
			node.parentElement = this;
			this.children.push(node);
			node.attachTo(this.doc);
		}
		return this;
	}
	attachTo(doc: FakePage | null) {
		this.doc = doc;
		doc?.nodes.push(this);
		for (const child of this.children) child.attachTo(doc);
	}
	/** The node and its ancestors, nearest first. */
	ancestry(): FakeNode[] {
		const chain: FakeNode[] = [];
		for (let node: FakeNode | null = this; node; node = node.parentElement)
			chain.push(node);
		return chain;
	}
	closest(selector: string): FakeNode | null {
		return this.ancestry().find((node) => matches(node, selector)) ?? null;
	}
	contains(node: FakeNode | null) {
		return node?.ancestry().includes(this) ?? false;
	}
	click() {
		this.clicks += 1;
	}
	focus() {
		this.focusCount += 1;
		if (this.doc) this.doc.activeElement = this;
	}
	scrollIntoView(options: unknown) {
		this.scrolls.push(options);
	}
	getClientRects() {
		return this.hidden ? [] : [{}];
	}
}

/** The page: every node attached to it, the body, and the element that has focus. */
class FakePage {
	nodes: FakeNode[] = [];
	body = new FakeNode("body");
	activeElement: FakeNode = this.body;
	constructor() {
		this.body.attachTo(this);
	}
	querySelectorAll(selector: string) {
		return this.nodes.filter((node) => matches(node, selector));
	}
	add(node: FakeNode, parent: FakeNode = this.body) {
		parent.append(node);
		return node;
	}
}

function el(
	page: FakePage,
	tag: string,
	attrs: Record<string, string> = {},
	parent?: FakeNode,
) {
	const node = new FakeNode(tag);
	for (const [name, value] of Object.entries(attrs))
		node.setAttribute(name, value);
	page.add(node, parent);
	return node;
}

/** The window: the address, a stand-in for location.assign, and htmx's ajax. */
function windowFor(search = "") {
	return {
		location: {
			pathname: "/transactions",
			search,
			assign: vi.fn(),
		},
		htmx: { ajax: vi.fn(() => Promise.resolve()) },
	};
}

/** A key press, as a keydown event: no modifiers unless the test sets them. */
function press(key: string, modifiers: Partial<Record<string, boolean>> = {}) {
	return {
		key,
		shiftKey: false,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		isComposing: false,
		defaultPrevented: false,
		preventDefault: vi.fn(),
		...modifiers,
	};
}

/** The keyboard for a page and window, with the page's own keydown and htmx settle as the browser sends them. */
function setup(page: FakePage, win = windowFor()) {
	const keys = keyboard(page, win);
	return {
		win,
		keydown: (event: ReturnType<typeof press>) => keys.keydown(event),
		settled: () => keys.settled(),
	};
}

/** A transaction list: three rows, each a link with data-row. */
function list(page: FakePage): [FakeNode, FakeNode, FakeNode] {
	return [
		el(page, "a", { href: "/transactions/1", "data-row": "" }),
		el(page, "a", { href: "/transactions/2", "data-row": "" }),
		el(page, "a", { href: "/transactions/3", "data-row": "" }),
	];
}

describe("keysHref (the address of the keys sheet)", () => {
	it("adds keys to a page with no query, and after the query it has", () => {
		expect(keysHref({ pathname: "/", search: "" })).toBe("/?keys");
		expect(
			keysHref({ pathname: "/transactions", search: "?month=2026-09" }),
		).toBe("/transactions?month=2026-09&keys");
	});
});

describe("/ (search)", () => {
	it("focuses the page's search field, and stops the browser's own quick find", () => {
		const page = new FakePage();
		const search = el(page, "input", {
			id: "q",
			"aria-keyshortcuts": "/",
		});
		const { keydown, win } = setup(page);
		const event = press("/");
		keydown(event);
		expect(page.activeElement).toBe(search);
		expect(event.preventDefault).toHaveBeenCalled();
		expect(win.location.assign).not.toHaveBeenCalled();
	});

	it("goes to Transactions with its search field focused on a page without search", () => {
		const page = new FakePage();
		const { keydown, win } = setup(page);
		keydown(press("/"));
		expect(win.location.assign).toHaveBeenCalledWith(
			"/transactions?focus=search",
		);
	});
});

describe("? (the keys sheet)", () => {
	it("asks the server for this page with keys, into #keys, and pushes that address", () => {
		const page = new FakePage();
		const win = windowFor("?month=2026-09");
		const { keydown } = setup(page, win);
		const event = press("?", { shiftKey: true });
		keydown(event);
		expect(event.preventDefault).toHaveBeenCalled();
		expect(win.htmx.ajax).toHaveBeenCalledWith(
			"GET",
			"/transactions?month=2026-09&keys",
			{
				target: "#keys",
				select: "#keys",
				swap: "outerHTML",
				push: "/transactions?month=2026-09&keys",
			},
		);
	});

	it("is not refused for the Shift it needs on most keyboards", () => {
		const page = new FakePage();
		const win = windowFor();
		setup(page, win).keydown(press("?", { shiftKey: true }));
		expect(win.htmx.ajax).toHaveBeenCalledTimes(1);
	});

	it("gives focus back to what opened it once the sheet closes", () => {
		const page = new FakePage();
		const [, second] = list(page);
		const win = windowFor();
		const { keydown, settled } = setup(page, win);
		page.activeElement = second;
		keydown(press("?", { shiftKey: true }));
		// The sheet arrives: htmx settles with the keys sheet on the page.
		const sheet = el(page, "section", { "data-sheet": "" }, page.body);
		settled();
		expect(second.focusCount).toBe(0);
		// Its close swaps the sheet away, and the next settle gives focus back.
		sheet.parentElement?.children.splice(
			sheet.parentElement.children.indexOf(sheet),
			1,
		);
		page.nodes.splice(page.nodes.indexOf(sheet), 1);
		settled();
		expect(second.focusCount).toBe(1);
		expect(page.activeElement).toBe(second);
	});

	it("does not return focus to an old opener once a later sheet closes, when the keys never opened", () => {
		const page = new FakePage();
		const [first] = list(page);
		const { keydown, settled } = setup(page);
		page.activeElement = first;
		keydown(press("?", { shiftKey: true }));
		// The sheet never arrives: a request settles with no sheet open, which ends the keys' return.
		settled();
		const sheet = el(page, "section", { "data-sheet": "" }, page.body);
		settled();
		page.nodes.splice(page.nodes.indexOf(sheet), 1);
		settled();
		expect(first.focusCount).toBe(0);
	});

	it("gives focus to nothing when the page had none to return to", () => {
		const page = new FakePage();
		const { keydown, settled } = setup(page);
		keydown(press("?", { shiftKey: true }));
		settled();
		expect(page.activeElement).toBe(page.body);
	});
});

describe("j and k (the rows of a list)", () => {
	it("move focus down and up the rows, and scroll the row into view", () => {
		const page = new FakePage();
		const [first, second, third] = list(page);
		const { keydown } = setup(page);
		keydown(press("j"));
		expect(page.activeElement).toBe(first);
		keydown(press("j"));
		expect(page.activeElement).toBe(second);
		keydown(press("k"));
		expect(page.activeElement).toBe(first);
		expect(first.scrolls).toContainEqual({ block: "nearest" });
		keydown(press("k"));
		expect(page.activeElement).toBe(first);
		keydown(press("j"));
		keydown(press("j"));
		keydown(press("j"));
		expect(page.activeElement).toBe(third);
	});

	it("starts at the first row going down and at the last going up, when focus is on nothing", () => {
		const page = new FakePage();
		const [first, , third] = list(page);
		const { keydown } = setup(page);
		keydown(press("k"));
		expect(page.activeElement).toBe(third);
		page.activeElement = page.body;
		keydown(press("j"));
		expect(page.activeElement).toBe(first);
	});

	it("does nothing on a page with no rows", () => {
		const page = new FakePage();
		const event = press("j");
		setup(page).keydown(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
	});

	it("passes over a row in a drawing htmx ignores (the catalog's Visual specimens), so its links don't navigate", () => {
		const page = new FakePage();
		const drawing = el(page, "div", { "hx-ignore": "" });
		const drawn = el(page, "a", { href: "/x", "data-row": "" }, drawing);
		const [live] = list(page);
		setup(page).keydown(press("j"));
		expect(page.activeElement).toBe(live);
		expect(drawn.focusCount).toBe(0);
	});

	it("passes over a row that is drawn inside an inert ancestor (a catalog drawing)", () => {
		const page = new FakePage();
		const inert = el(page, "div", { inert: "" });
		el(page, "a", { href: "/x", "data-row": "" }, inert);
		const [live] = list(page);
		setup(page).keydown(press("j"));
		expect(page.activeElement).toBe(live);
	});

	it("passes over a details row (Settings' category rows), which cannot take focus", () => {
		const page = new FakePage();
		const category = el(page, "details", { "data-row": "3" });
		const [first, second] = list(page);
		const { keydown } = setup(page);
		keydown(press("j"));
		expect(page.activeElement).toBe(first);
		keydown(press("j"));
		expect(page.activeElement).toBe(second);
		expect(category.focusCount).toBe(0);
	});
});

describe("e (opens the focused row)", () => {
	it("clicks the row focus is on, the way a click opens it", () => {
		const page = new FakePage();
		const [, second] = list(page);
		page.activeElement = second;
		setup(page).keydown(press("e"));
		expect(second.clicks).toBe(1);
	});

	it("does nothing when focus is on something that is not a row", () => {
		const page = new FakePage();
		const [first] = list(page);
		const button = el(page, "button", {});
		page.activeElement = button;
		setup(page).keydown(press("e"));
		expect(button.clicks).toBe(0);
		expect(first.clicks).toBe(0);
	});
});

describe("← and → (the months on Home)", () => {
	it("follow the previous and next month links", () => {
		const page = new FakePage();
		const previous = el(page, "a", {
			href: "/?month=2026-08",
			"aria-keyshortcuts": "ArrowLeft",
		});
		const next = el(page, "a", {
			href: "/?month=2026-10",
			"aria-keyshortcuts": "ArrowRight",
		});
		const { keydown } = setup(page);
		const left = press("ArrowLeft");
		keydown(left);
		expect(previous.clicks).toBe(1);
		expect(left.preventDefault).toHaveBeenCalled();
		keydown(press("ArrowRight"));
		expect(next.clicks).toBe(1);
	});

	it("leave the arrows to a sideways scroll region, which scrolls as the browser does", () => {
		const page = new FakePage();
		const previous = el(page, "a", {
			href: "/?month=2026-08",
			"aria-keyshortcuts": "ArrowLeft",
		});
		const region = el(page, "div", { "data-sideways": "" });
		const inside = el(page, "div", { tabindex: "0" }, region);
		page.activeElement = inside;
		const event = press("ArrowLeft");
		setup(page).keydown(event);
		expect(previous.clicks).toBe(0);
		expect(event.preventDefault).not.toHaveBeenCalled();
	});

	it("do nothing on a page without the month links", () => {
		const page = new FakePage();
		const event = press("ArrowRight");
		setup(page).keydown(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
	});
});

describe("u (undoes the change its toast shows)", () => {
	it("presses the Undo button of the toast that is showing", () => {
		const page = new FakePage();
		const undo = el(page, "button", { "aria-keyshortcuts": "u" });
		const event = press("u");
		setup(page).keydown(event);
		expect(undo.clicks).toBe(1);
		expect(event.preventDefault).toHaveBeenCalled();
	});

	it("presses the newest Undo when two toasts show", () => {
		const page = new FakePage();
		el(page, "button", { "aria-keyshortcuts": "u" });
		const newest = el(page, "button", { "aria-keyshortcuts": "u" });
		setup(page).keydown(press("u"));
		expect(newest.clicks).toBe(1);
	});

	it("does nothing when no toast shows an Undo", () => {
		const page = new FakePage();
		const event = press("u");
		setup(page).keydown(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
	});
});

describe("the guards", () => {
	it("never acts while focus is in a field, a select or an editable area", () => {
		for (const tag of ["input", "textarea", "select"]) {
			const page = new FakePage();
			const [first] = list(page);
			const field = el(page, tag, {});
			page.activeElement = field;
			const { keydown } = setup(page);
			keydown(press("j"));
			keydown(press("/"));
			keydown(press("?", { shiftKey: true }));
			expect(first.focusCount).toBe(0);
			expect(field.focusCount).toBe(0);
		}
		const page = new FakePage();
		const editable = el(page, "div", { contenteditable: "true" });
		const [first] = list(page);
		page.activeElement = editable;
		setup(page).keydown(press("j"));
		expect(first.focusCount).toBe(0);
	});

	it("never acts with Ctrl, Alt or Cmd held", () => {
		for (const modifier of ["ctrlKey", "altKey", "metaKey"]) {
			const page = new FakePage();
			const [first] = list(page);
			const { keydown, win } = setup(page);
			const event = press("j", { [modifier]: true });
			keydown(event);
			keydown(press("?", { shiftKey: true, [modifier]: true }));
			expect(first.focusCount).toBe(0);
			expect(win.htmx.ajax).not.toHaveBeenCalled();
			expect(event.preventDefault).not.toHaveBeenCalled();
		}
	});

	it("takes Shift only as part of ?", () => {
		const page = new FakePage();
		const [first] = list(page);
		setup(page).keydown(press("J", { shiftKey: true }));
		expect(first.focusCount).toBe(0);
		const sideways = el(page, "a", {
			href: "/?month=2026-08",
			"aria-keyshortcuts": "ArrowLeft",
		});
		setup(page).keydown(press("ArrowLeft", { shiftKey: true }));
		expect(sideways.clicks).toBe(0);
	});

	it("never acts while a sheet is open, so no key reaches the page behind it", () => {
		const page = new FakePage();
		const [first] = list(page);
		const search = el(page, "input", { "aria-keyshortcuts": "/" });
		const undo = el(page, "button", { "aria-keyshortcuts": "u" });
		el(page, "section", { "data-sheet": "" });
		const { keydown, win } = setup(page);
		keydown(press("j"));
		keydown(press("/"));
		keydown(press("u"));
		keydown(press("?", { shiftKey: true }));
		expect(first.focusCount).toBe(0);
		expect(page.activeElement).toBe(page.body);
		expect(search.focusCount).toBe(0);
		expect(undo.clicks).toBe(0);
		expect(win.htmx.ajax).not.toHaveBeenCalled();
	});

	it("passes over a sheet drawn inside an inert ancestor, so a catalog drawing opens no sheet", () => {
		const page = new FakePage();
		const [first] = list(page);
		const frame = el(page, "div", { inert: "" });
		el(page, "section", { "data-sheet": "" }, frame);
		setup(page).keydown(press("j"));
		expect(first.focusCount).toBe(1);
	});

	it("ignores a key already handled and a key composed with an IME", () => {
		const page = new FakePage();
		const [first] = list(page);
		const { keydown } = setup(page);
		keydown({ ...press("j"), defaultPrevented: true });
		keydown({ ...press("j"), isComposing: true });
		expect(first.focusCount).toBe(0);
	});
});

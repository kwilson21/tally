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
	get id() {
		return this.attrs.get("id") ?? "";
	}
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
	blur() {
		if (this.doc?.activeElement === this)
			this.doc.activeElement = this.doc.body;
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
	getElementById(id: string) {
		return this.nodes.find((node) => node.id === id) ?? null;
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

/** The window: the address, a stand-in for location.assign, htmx's ajax, and the history htmx keeps. */
function windowFor(search = "", hash = "") {
	return {
		location: {
			pathname: "/transactions",
			search,
			hash,
			assign: vi.fn(),
		},
		htmx: { ajax: vi.fn(() => Promise.resolve()) },
		history: { state: { htmx: true }, replaceState: vi.fn() },
	};
}

/**
 * Takes a node out of the page, as a swap does when it replaces the sheet. As a browser does, focus on a removed node
 * (or inside one) goes to the body.
 */
function remove(page: FakePage, node: FakeNode) {
	const parent = node.parentElement;
	if (parent) parent.children.splice(parent.children.indexOf(node), 1);
	page.nodes.splice(page.nodes.indexOf(node), 1);
	if (page.activeElement.ancestry().includes(node))
		page.activeElement = page.body;
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

/**
 * htmx's htmx:after:request for a request whose ctx.target is the node given, as the browser sends it (cancelable). `from`
 * is the address the request was made from, which htmx sends as HX-Current-URL; left out, the header is missing.
 */
function requestEvent(target: FakeNode | null, from?: string) {
	const headers = from === undefined ? {} : { "HX-Current-URL": from };
	return {
		detail: { ctx: { target, request: { headers } } },
		preventDefault: vi.fn(),
	};
}

/**
 * htmx's htmx:before:request for a request whose ctx.target is the node given, with the abort htmx gives the request's ctx.
 * It fires once the request may run, so the keys request is in flight from here until its finish.
 */
function beforeRequestEvent(target: FakeNode | null) {
	return { detail: { ctx: { target, request: { abort: vi.fn() } } } };
}

/** htmx's htmx:after:settle for a swap, which fires on the swap's target: the region the swap put in. */
function settleEvent(target: FakeNode) {
	return { target };
}

/** htmx's htmx:finally:request for a request that ended, with the target, status and swap its ctx reports. */
function finishEvent(
	target: FakeNode | null,
	status: string,
	swap = "outerHTML",
) {
	return { detail: { ctx: { target, status, swap } } };
}

/** The keyboard for a page and window, with the page's own keydown, htmx settle, finish and request events as the browser sends them. */
function setup(page: FakePage, win = windowFor()) {
	const keys = keyboard(page, win);
	return {
		win,
		keydown: (event: ReturnType<typeof press>) => keys.keydown(event),
		settled: (event: ReturnType<typeof settleEvent>) => keys.settled(event),
		ended: (event: ReturnType<typeof finishEvent>) => keys.ended(event),
		responded: (event: ReturnType<typeof requestEvent>) =>
			keys.responded(event),
		requested: (event: ReturnType<typeof beforeRequestEvent>) =>
			keys.requested(event),
		restoring: () => keys.restoring(),
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

	it("keeps the address on this site: a path that starts with // is drawn from one /", () => {
		expect(keysHref({ pathname: "//evil.example/x", search: "" })).toBe(
			"/evil.example/x?keys",
		);
	});

	it("closes to Home when the path has a backslash or a tab, which a browser reads as another host", () => {
		expect(keysHref({ pathname: "/\\evil.example/x", search: "" })).toBe(
			"/?keys",
		);
		expect(keysHref({ pathname: "/\t/evil.example", search: "" })).toBe(
			"/?keys",
		);
		expect(
			keysHref({ pathname: "/\\evil.example/x", search: "?month=2026-09" }),
		).toBe("/?month=2026-09&keys");
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

	it("takes Shift as part of / on a layout where / needs it, such as German", () => {
		const page = new FakePage();
		const search = el(page, "input", {
			id: "q",
			"aria-keyshortcuts": "/",
		});
		const { keydown, win } = setup(page);
		const event = press("/", { shiftKey: true });
		keydown(event);
		expect(page.activeElement).toBe(search);
		expect(event.preventDefault).toHaveBeenCalled();
		expect(win.location.assign).not.toHaveBeenCalled();
	});

	it("goes to Transactions for Shift with / on a page without search", () => {
		const page = new FakePage();
		const { keydown, win } = setup(page);
		keydown(press("/", { shiftKey: true }));
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
		const region = el(page, "div", { id: "keys" });
		const win = windowFor();
		const { keydown, settled } = setup(page, win);
		page.activeElement = second;
		keydown(press("?", { shiftKey: true }));
		// The sheet arrives: htmx settles the keys region with the keys sheet in it.
		const sheet = el(page, "section", { "data-sheet": "" }, region);
		settled(settleEvent(region));
		expect(second.focusCount).toBe(0);
		// Its close swaps the sheet away, and the next settle gives focus back.
		sheet.parentElement?.children.splice(
			sheet.parentElement.children.indexOf(sheet),
			1,
		);
		page.nodes.splice(page.nodes.indexOf(sheet), 1);
		settled(settleEvent(region));
		expect(second.focusCount).toBe(1);
		expect(page.activeElement).toBe(second);
	});

	it("does not return focus to an old opener once a later sheet closes, when the keys never opened", () => {
		const page = new FakePage();
		const [first] = list(page);
		const region = el(page, "div", { id: "keys" });
		const sheetRegion = el(page, "div", { id: "sheet" });
		const win = windowFor("", "#budget");
		const { keydown, ended, settled } = setup(page, win);
		page.activeElement = first;
		keydown(press("?", { shiftKey: true }));
		// The keys request fails: the sheet never arrives, and the request's end forgets the return.
		ended(finishEvent(region, "error: TypeError"));
		// A row's sheet then opens and closes in its own region, which the keys' return does not follow.
		const sheet = el(page, "section", { "data-sheet": "" }, sheetRegion);
		settled(settleEvent(sheetRegion));
		remove(page, sheet);
		settled(settleEvent(sheetRegion));
		expect(first.focusCount).toBe(0);
		expect(win.history.replaceState).not.toHaveBeenCalled();
	});

	it("gives focus to nothing when the page had none to return to", () => {
		const page = new FakePage();
		const region = el(page, "div", { id: "keys" });
		const { keydown, ended } = setup(page);
		keydown(press("?", { shiftKey: true }));
		ended(finishEvent(region, "error: TypeError"));
		expect(page.activeElement).toBe(page.body);
	});

	it("asks the server without the page's #fragment, and pushes the address with it", () => {
		const page = new FakePage();
		const win = windowFor("", "#budget");
		setup(page, win).keydown(press("?", { shiftKey: true }));
		expect(win.htmx.ajax).toHaveBeenCalledWith("GET", "/transactions?keys", {
			target: "#keys",
			select: "#keys",
			swap: "outerHTML",
			push: "/transactions?keys#budget",
		});
	});

	it("puts the fragment back on the address once the sheet closes, in place", () => {
		const page = new FakePage();
		const win = windowFor("", "#budget");
		const { keydown, settled } = setup(page, win);
		keydown(press("?", { shiftKey: true }));
		const region = el(page, "div", { id: "keys" });
		const sheet = el(page, "section", { "data-sheet": "" }, region);
		settled(settleEvent(region));
		expect(win.history.replaceState).not.toHaveBeenCalled();
		// Its close swaps the sheet away and pushes the address without a fragment.
		remove(page, sheet);
		win.location.hash = "";
		settled(settleEvent(region));
		expect(win.history.replaceState).toHaveBeenCalledWith(
			{ htmx: true },
			"",
			"/transactions#budget",
		);
	});

	it("leaves the address alone when the page had no fragment, or when the address still has it", () => {
		const plain = new FakePage();
		const plainWin = windowFor();
		const plainKeys = setup(plain, plainWin);
		const plainRegion = el(plain, "div", { id: "keys" });
		plainKeys.keydown(press("?", { shiftKey: true }));
		const plainSheet = el(plain, "section", { "data-sheet": "" }, plainRegion);
		plainKeys.settled(settleEvent(plainRegion));
		remove(plain, plainSheet);
		plainKeys.settled(settleEvent(plainRegion));
		expect(plainWin.history.replaceState).not.toHaveBeenCalled();

		const kept = new FakePage();
		const keptWin = windowFor("", "#budget");
		const keptKeys = setup(kept, keptWin);
		const keptRegion = el(kept, "div", { id: "keys" });
		keptKeys.keydown(press("?", { shiftKey: true }));
		const keptSheet = el(kept, "section", { "data-sheet": "" }, keptRegion);
		keptKeys.settled(settleEvent(keptRegion));
		remove(kept, keptSheet);
		keptWin.location.hash = "#budget";
		keptKeys.settled(settleEvent(keptRegion));
		expect(keptWin.history.replaceState).not.toHaveBeenCalled();
	});

	it("moves focus out of an Undo toast for the sheet, and back to Undo when the sheet closes", () => {
		const page = new FakePage();
		const toasts = el(page, "div", { id: "toasts" });
		const undo = el(page, "button", { "aria-keyshortcuts": "u" }, toasts);
		const region = el(page, "div", { id: "keys" });
		const win = windowFor();
		const { keydown, settled } = setup(page, win);
		page.activeElement = undo;
		keydown(press("?", { shiftKey: true }));
		expect(page.activeElement).toBe(page.body);
		expect(win.htmx.ajax).toHaveBeenCalledTimes(1);
		// The sheet arrives, then its close swaps it away, and the next settle gives focus back to Undo.
		const sheet = el(page, "section", { "data-sheet": "" }, region);
		settled(settleEvent(region));
		remove(page, sheet);
		settled(settleEvent(region));
		expect(page.activeElement).toBe(undo);
	});

	it("leaves focus on a row where it is: only an Undo toast gives focus up", () => {
		const page = new FakePage();
		const [, second] = list(page);
		el(page, "div", { id: "toasts" });
		page.activeElement = second;
		setup(page).keydown(press("?", { shiftKey: true }));
		expect(page.activeElement).toBe(second);
	});

	it("restores the fragment when a sheet that was open on load closes", () => {
		const page = new FakePage();
		const region = el(page, "div", { id: "keys" });
		const sheet = el(page, "section", { "data-sheet": "" }, region);
		const win = windowFor("", "#budget");
		const { settled } = setup(page, win);
		remove(page, sheet);
		win.location.hash = "";
		settled(settleEvent(region));
		expect(win.history.replaceState).toHaveBeenCalledWith(
			{ htmx: true },
			"",
			"/transactions#budget",
		);
	});

	it("ignores a second ? while the sheet loads, so a key repeat sends one request", () => {
		const page = new FakePage();
		const region = el(page, "div", { id: "keys" });
		const win = windowFor();
		const { keydown, settled } = setup(page, win);
		keydown(press("?", { shiftKey: true }));
		const again = press("?", { shiftKey: true });
		keydown(again);
		expect(again.preventDefault).toHaveBeenCalled();
		expect(win.htmx.ajax).toHaveBeenCalledTimes(1);
		// Once the sheet is in, a ? is the open sheet's own key, and it sends nothing either.
		el(page, "section", { "data-sheet": "" }, region);
		settled(settleEvent(region));
		keydown(press("?", { shiftKey: true }));
		expect(win.htmx.ajax).toHaveBeenCalledTimes(1);
	});

	it.each([
		["fails at the network", "error: TypeError: Failed to fetch", "outerHTML"],
		["gets a 500 that is not swapped", "swapped", "none"],
	])(
		"takes a ? again once a keys request that %s has ended",
		(_, status, swap) => {
			const page = new FakePage();
			const region = el(page, "div", { id: "keys" });
			const win = windowFor();
			const { keydown, ended } = setup(page, win);
			keydown(press("?", { shiftKey: true }));
			ended(finishEvent(region, status, swap));
			keydown(press("?", { shiftKey: true }));
			expect(win.htmx.ajax).toHaveBeenCalledTimes(2);
		},
	);

	it("takes a ? again once a keys response dropped for a moved address has ended", () => {
		const page = new FakePage();
		const region = el(page, "div", { id: "keys" });
		const win = windowFor("?month=2026-09");
		const { keydown, responded, ended } = setup(page, win);
		keydown(press("?", { shiftKey: true }));
		win.location.search = "?month=2026-10";
		const event = requestEvent(
			region,
			"http://localhost/transactions?month=2026-09",
		);
		responded(event);
		expect(event.preventDefault).toHaveBeenCalled();
		ended(finishEvent(region, "issuing"));
		keydown(press("?", { shiftKey: true }));
		expect(win.htmx.ajax).toHaveBeenCalledTimes(2);
	});

	it("takes a ? again once #keys itself settles", () => {
		const page = new FakePage();
		const region = el(page, "div", { id: "keys" });
		const win = windowFor();
		const { keydown, settled } = setup(page, win);
		keydown(press("?", { shiftKey: true }));
		settled(settleEvent(region));
		keydown(press("?", { shiftKey: true }));
		expect(win.htmx.ajax).toHaveBeenCalledTimes(2);
	});

	it("still sends nothing for a second ? when a body-targeted POST settles while the keys load", () => {
		const page = new FakePage();
		const region = el(page, "div", { id: "keys" });
		const win = windowFor();
		const { keydown, settled, ended } = setup(page, win);
		keydown(press("?", { shiftKey: true }));
		// A POST that targets the body settles while the keys load: that is not the keys request's own swap, so it waits on.
		settled(settleEvent(page.body));
		keydown(press("?", { shiftKey: true }));
		expect(win.htmx.ajax).toHaveBeenCalledTimes(1);
		// The keys request's own finish ends its wait, and a ? sends again.
		ended(finishEvent(region, "swapped"));
		keydown(press("?", { shiftKey: true }));
		expect(win.htmx.ajax).toHaveBeenCalledTimes(2);
	});
});

describe("a settle of another request leaves the keys sheet's return alone (htmx:after:settle)", () => {
	it("keeps the opener and the fragment when another request settles while the keys load", () => {
		const page = new FakePage();
		const [, second] = list(page);
		const syncRegion = el(page, "div", { id: "sync" });
		const region = el(page, "div", { id: "keys" });
		const win = windowFor("", "#budget");
		const { keydown, settled } = setup(page, win);
		page.activeElement = second;
		keydown(press("?", { shiftKey: true }));
		// Sync now settles while the keys load: it is not the keys region, so the return stays.
		settled(settleEvent(syncRegion));
		// The keys sheet arrives in #keys; its close swaps it away and pushes the address without the fragment.
		const sheet = el(page, "section", { "data-sheet": "" }, region);
		settled(settleEvent(region));
		remove(page, sheet);
		win.location.hash = "";
		settled(settleEvent(region));
		expect(second.focusCount).toBe(1);
		expect(win.history.replaceState).toHaveBeenCalledWith(
			{ htmx: true },
			"",
			"/transactions#budget",
		);
	});

	it("keeps Undo as the opener when another request settles while the keys load", () => {
		const page = new FakePage();
		const toasts = el(page, "div", { id: "toasts" });
		const undo = el(page, "button", { "aria-keyshortcuts": "u" }, toasts);
		const syncRegion = el(page, "div", { id: "sync" });
		const region = el(page, "div", { id: "keys" });
		const { keydown, settled } = setup(page);
		page.activeElement = undo;
		keydown(press("?", { shiftKey: true }));
		settled(settleEvent(syncRegion));
		const sheet = el(page, "section", { "data-sheet": "" }, region);
		settled(settleEvent(region));
		remove(page, sheet);
		settled(settleEvent(region));
		expect(page.activeElement).toBe(undo);
	});
});

describe("a keys request that ends (htmx:finally:request)", () => {
	it.each(["before", "after"])(
		"keeps the return of a successful keys swap when its finish comes %s the settle",
		(order) => {
			const page = new FakePage();
			const [, second] = list(page);
			const region = el(page, "div", { id: "keys" });
			const win = windowFor("", "#budget");
			const { keydown, settled, ended } = setup(page, win);
			page.activeElement = second;
			keydown(press("?", { shiftKey: true }));
			const sheet = el(page, "section", { "data-sheet": "" }, region);
			if (order === "before") ended(finishEvent(region, "swapped"));
			settled(settleEvent(region));
			if (order === "after") ended(finishEvent(region, "swapped"));
			remove(page, sheet);
			win.location.hash = "";
			settled(settleEvent(region));
			expect(second.focusCount).toBe(1);
			expect(win.history.replaceState).toHaveBeenCalledWith(
				{ htmx: true },
				"",
				"/transactions#budget",
			);
		},
	);

	it("leaves the return of a failed close alone, so the retried close still gives focus back", () => {
		const page = new FakePage();
		const [, second] = list(page);
		const region = el(page, "div", { id: "keys" });
		const win = windowFor("", "#budget");
		const { keydown, settled, ended } = setup(page, win);
		page.activeElement = second;
		keydown(press("?", { shiftKey: true }));
		const sheet = el(page, "section", { "data-sheet": "" }, region);
		settled(settleEvent(region));
		// The close fails and the sheet stays up, so its return stays for the retried Escape or Cancel.
		ended(finishEvent(region, "error: TypeError"));
		expect(second.focusCount).toBe(0);
		remove(page, sheet);
		win.location.hash = "";
		settled(settleEvent(region));
		expect(second.focusCount).toBe(1);
		expect(win.history.replaceState).toHaveBeenCalledWith(
			{ htmx: true },
			"",
			"/transactions#budget",
		);
	});

	it("does nothing for another request's finish", () => {
		const page = new FakePage();
		const [, second] = list(page);
		const region = el(page, "div", { id: "keys" });
		const sheetRegion = el(page, "div", { id: "sheet" });
		const { keydown, settled, ended } = setup(page);
		page.activeElement = second;
		keydown(press("?", { shiftKey: true }));
		ended(finishEvent(sheetRegion, "error: TypeError"));
		const sheet = el(page, "section", { "data-sheet": "" }, region);
		settled(settleEvent(region));
		remove(page, sheet);
		settled(settleEvent(region));
		expect(second.focusCount).toBe(1);
	});

	it("leaves focus where the person moved it during the load", () => {
		const page = new FakePage();
		const toasts = el(page, "div", { id: "toasts" });
		const undo = el(page, "button", { "aria-keyshortcuts": "u" }, toasts);
		const [, second] = list(page);
		const region = el(page, "div", { id: "keys" });
		const { keydown, ended } = setup(page);
		page.activeElement = undo;
		keydown(press("?", { shiftKey: true }));
		second.focus();
		ended(finishEvent(region, "error: TypeError"));
		expect(page.activeElement).toBe(second);
		expect(undo.focusCount).toBe(0);
	});

	// A keys request that fails at the network, or gets a 500 that toast.js keeps out of the page, ends with no sheet.
	it.each([
		["fails at the network", "error: TypeError: Failed to fetch", "outerHTML"],
		["gets a 500 that is not swapped", "swapped", "none"],
	])("gives focus back to Undo when the keys request %s", (_, status, swap) => {
		const page = new FakePage();
		const toasts = el(page, "div", { id: "toasts" });
		const undo = el(page, "button", { "aria-keyshortcuts": "u" }, toasts);
		const region = el(page, "div", { id: "keys" });
		const sheetRegion = el(page, "div", { id: "sheet" });
		const win = windowFor("", "#budget");
		const { keydown, ended, settled } = setup(page, win);
		page.activeElement = undo;
		keydown(press("?", { shiftKey: true }));
		// ? blurred Undo, so focus is on nothing. The request ends with no swap, and focus goes back to Undo.
		expect(page.activeElement).toBe(page.body);
		ended(finishEvent(region, status, swap));
		expect(page.activeElement).toBe(undo);
		const focusesAfterFailure = undo.focusCount;
		// A later, unrelated sheet opens and closes in its own region: Undo is not focused again.
		const sheet = el(page, "section", { "data-sheet": "" }, sheetRegion);
		settled(settleEvent(sheetRegion));
		remove(page, sheet);
		win.location.hash = "";
		settled(settleEvent(sheetRegion));
		expect(undo.focusCount).toBe(focusesAfterFailure);
		expect(win.history.replaceState).not.toHaveBeenCalled();
	});
});

describe("a keys response that comes after another sheet opened or the address moved (htmx:after:request)", () => {
	it("is thrown away when the address moved while it loaded, as a filter pushing first does", () => {
		const page = new FakePage();
		const region = el(page, "div", { id: "keys" });
		const win = windowFor("?month=2026-09");
		const { keydown, responded } = setup(page, win);
		keydown(press("?", { shiftKey: true }));
		// A Transactions filter that finished first pushed its own address; the keys response is for the one before it.
		win.location.search = "?month=2026-10";
		const event = requestEvent(
			region,
			"http://localhost/transactions?month=2026-09",
		);
		responded(event);
		expect(event.preventDefault).toHaveBeenCalled();
	});

	it("gives focus back to Undo when the address moved while the keys loaded and the response was dropped", () => {
		const page = new FakePage();
		const toasts = el(page, "div", { id: "toasts" });
		const undo = el(page, "button", { "aria-keyshortcuts": "u" }, toasts);
		const region = el(page, "div", { id: "keys" });
		const win = windowFor("?month=2026-09");
		const { keydown, responded, ended, settled } = setup(page, win);
		page.activeElement = undo;
		keydown(press("?", { shiftKey: true }));
		// ? blurred Undo, so focus is on nothing while the keys load.
		expect(page.activeElement).toBe(page.body);
		win.location.search = "?month=2026-10";
		const event = requestEvent(
			region,
			"http://localhost/transactions?month=2026-09",
		);
		responded(event);
		expect(event.preventDefault).toHaveBeenCalled();
		// The drop leaves the return to ended(), which gives focus back to Undo when the request finishes.
		ended(finishEvent(region, "issuing"));
		expect(page.activeElement).toBe(undo);
		const focusesAfterDrop = undo.focusCount;
		// No sheet ever opened in #keys, so this settle is not a close: it must not focus Undo a second time.
		settled(settleEvent(region));
		expect(undo.focusCount).toBe(focusesAfterDrop);
	});

	it("is kept when the address is the one the request was made from, and the sheet still closes to its opener", () => {
		const page = new FakePage();
		const [first] = list(page);
		const region = el(page, "div", { id: "keys" });
		const win = windowFor("?month=2026-09");
		const { keydown, responded, settled } = setup(page, win);
		page.activeElement = first;
		keydown(press("?", { shiftKey: true }));
		const event = requestEvent(
			region,
			"http://localhost/transactions?month=2026-09",
		);
		responded(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
		// The sheet arrives, and its close swaps it away: focus goes back to the row that opened it.
		const sheet = el(page, "section", { "data-sheet": "" }, region);
		settled(settleEvent(region));
		remove(page, sheet);
		settled(settleEvent(region));
		expect(first.focusCount).toBe(1);
	});

	it("is kept when only the #fragment changed, since the page is still the same", () => {
		const page = new FakePage();
		const region = el(page, "div", { id: "keys" });
		const win = windowFor("?month=2026-09", "#row-1");
		const { keydown, responded } = setup(page, win);
		keydown(press("?", { shiftKey: true }));
		win.location.hash = "#budget";
		const event = requestEvent(
			region,
			"http://localhost/transactions?month=2026-09#row-1",
		);
		responded(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
	});

	it("is kept when the request has no HX-Current-URL to compare the address with", () => {
		const page = new FakePage();
		const region = el(page, "div", { id: "keys" });
		const win = windowFor("?month=2026-09");
		const { keydown, responded } = setup(page, win);
		keydown(press("?", { shiftKey: true }));
		win.location.search = "?month=2026-10";
		const event = requestEvent(region);
		responded(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
	});

	it("is thrown away when a sheet outside #keys opened while it loaded", () => {
		const page = new FakePage();
		const region = el(page, "div", { id: "keys" });
		const { keydown, responded } = setup(page);
		keydown(press("?", { shiftKey: true }));
		el(page, "section", { "data-sheet": "" }, page.body);
		const event = requestEvent(region);
		responded(event);
		expect(event.preventDefault).toHaveBeenCalled();
	});

	it.each([
		["with the address unchanged", false],
		["with the address moved as well", true],
	])(
		"forgets the opener at once when a sheet outside #keys opened while the keys loaded (%s)",
		(_, moved) => {
			const page = new FakePage();
			const [first] = list(page);
			const region = el(page, "div", { id: "keys" });
			const sheetRegion = el(page, "div", { id: "sheet" });
			const win = windowFor("?month=2026-09");
			const { keydown, responded, ended } = setup(page, win);
			page.activeElement = first;
			keydown(press("?", { shiftKey: true }));
			const otherSheet = el(page, "section", { "data-sheet": "" }, sheetRegion);
			if (moved) win.location.search = "?month=2026-10";
			const event = requestEvent(
				region,
				moved ? "http://localhost/transactions?month=2026-09" : undefined,
			);
			responded(event);
			expect(event.preventDefault).toHaveBeenCalled();
			// The other sheet closes before the request ends, so ended() would give focus back to the row if the return survived.
			remove(page, otherSheet);
			page.activeElement = page.body;
			ended(finishEvent(region, "issuing"));
			expect(first.focusCount).toBe(0);
		},
	);

	it("is kept when the keys sheet itself closes, since its sheet is inside #keys", () => {
		const page = new FakePage();
		const region = el(page, "div", { id: "keys" });
		el(page, "section", { "data-sheet": "" }, region);
		const { responded } = setup(page);
		const event = requestEvent(region);
		responded(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
	});

	it("is kept with no sheet open, and for a request that does not target #keys", () => {
		const page = new FakePage();
		const region = el(page, "div", { id: "keys" });
		const elsewhere = el(page, "div", { id: "elsewhere" });
		const { responded } = setup(page);
		const none = requestEvent(region);
		responded(none);
		expect(none.preventDefault).not.toHaveBeenCalled();
		el(page, "section", { "data-sheet": "" }, page.body);
		const other = requestEvent(elsewhere);
		responded(other);
		expect(other.preventDefault).not.toHaveBeenCalled();
	});

	it("leaves focus alone when the sheet that opened meanwhile closes", () => {
		const page = new FakePage();
		const [first] = list(page);
		const region = el(page, "div", { id: "keys" });
		const sheetRegion = el(page, "div", { id: "sheet" });
		const { keydown, ended, responded, settled } = setup(page);
		page.activeElement = first;
		keydown(press("?", { shiftKey: true }));
		const other = el(page, "section", { "data-sheet": "" }, sheetRegion);
		responded(requestEvent(region));
		ended(finishEvent(region, "issuing"));
		settled(settleEvent(sheetRegion));
		remove(page, other);
		settled(settleEvent(sheetRegion));
		expect(first.focusCount).toBe(0);
	});

	it("is thrown away when #keys was redrawn while it loaded (a body POST or a Back), so no ?keys is pushed", () => {
		const page = new FakePage();
		const region = el(page, "div", { id: "keys" });
		const win = windowFor();
		const { keydown, responded, ended } = setup(page, win);
		keydown(press("?", { shiftKey: true }));
		// A body-targeted POST redrew the page: the region the request targeted is gone, and a new #keys is in its place.
		remove(page, region);
		el(page, "div", { id: "keys" });
		// The address is the same, so only the redraw drops this response.
		const event = requestEvent(region, "http://localhost/transactions");
		responded(event);
		expect(event.preventDefault).toHaveBeenCalled();
		// The drop leaves the request to finish, and its finish ends the wait, so a ? sends again.
		ended(finishEvent(region, "issuing"));
		keydown(press("?", { shiftKey: true }));
		expect(win.htmx.ajax).toHaveBeenCalledTimes(2);
	});
});

describe("a history restore that takes the keys sheet away (the browser's Back)", () => {
	// A Back to a page without the sheet redraws the body: the sheet and its opener are gone, and the page's <main> and
	// heading are drawn again. The body's settle is the sheet's close, and focus then goes to the heading.
	it("focuses the page's heading when the opener is gone, and forgets the return", () => {
		const page = new FakePage();
		const [first] = list(page);
		const region = el(page, "div", { id: "keys" });
		const win = windowFor("", "#budget");
		const { keydown, settled } = setup(page, win);
		page.activeElement = first;
		keydown(press("?", { shiftKey: true }));
		const sheet = el(page, "section", { "data-sheet": "" }, region);
		settled(settleEvent(region));
		remove(page, sheet);
		remove(page, first);
		const main = el(page, "main", { id: "main" });
		const heading = el(page, "h1", {}, main);
		settled(settleEvent(page.body));
		expect(page.activeElement).toBe(heading);
		expect(heading.getAttribute("tabindex")).toBe("-1");
		// The return is forgotten, so a later settle of #keys moves focus nowhere.
		const focuses = heading.focusCount;
		settled(settleEvent(region));
		expect(heading.focusCount).toBe(focuses);
		expect(win.history.replaceState).not.toHaveBeenCalled();
	});

	it("focuses the heading when the opener was an Undo whose toast left the page while the sheet was open", () => {
		const page = new FakePage();
		const toasts = el(page, "div", { id: "toasts" });
		const undo = el(page, "button", { "aria-keyshortcuts": "u" }, toasts);
		const region = el(page, "div", { id: "keys" });
		const { keydown, settled } = setup(page);
		page.activeElement = undo;
		keydown(press("?", { shiftKey: true }));
		const sheet = el(page, "section", { "data-sheet": "" }, region);
		settled(settleEvent(region));
		remove(page, undo);
		const main = el(page, "main", { id: "main" });
		const heading = el(page, "h1", {}, main);
		remove(page, sheet);
		settled(settleEvent(region));
		expect(page.activeElement).toBe(heading);
		expect(heading.getAttribute("tabindex")).toBe("-1");
	});

	it("leaves focus where it is when the sheet was opened from the body, and does not focus the heading", () => {
		const page = new FakePage();
		const region = el(page, "div", { id: "keys" });
		const { keydown, settled } = setup(page);
		keydown(press("?", { shiftKey: true }));
		const sheet = el(page, "section", { "data-sheet": "" }, region);
		settled(settleEvent(region));
		remove(page, sheet);
		const main = el(page, "main", { id: "main" });
		const heading = el(page, "h1", {}, main);
		settled(settleEvent(page.body));
		expect(page.activeElement).toBe(page.body);
		expect(heading.focusCount).toBe(0);
	});

	it("moves no focus on a history restore when no keys sheet was ever opened", () => {
		const page = new FakePage();
		const [first] = list(page);
		el(page, "div", { id: "keys" });
		const win = windowFor("", "#budget");
		const { settled } = setup(page, win);
		page.activeElement = first;
		remove(page, first);
		const main = el(page, "main", { id: "main" });
		const heading = el(page, "h1", {}, main);
		settled(settleEvent(page.body));
		expect(page.activeElement).toBe(page.body);
		expect(heading.focusCount).toBe(0);
		expect(win.history.replaceState).not.toHaveBeenCalled();
	});

	it("changes nothing on a body or another region's settle while the keys sheet is open, and a later close still gives focus back", () => {
		const page = new FakePage();
		const [, second] = list(page);
		const syncRegion = el(page, "div", { id: "sync" });
		const region = el(page, "div", { id: "keys" });
		const win = windowFor("", "#budget");
		const { keydown, settled } = setup(page, win);
		page.activeElement = second;
		keydown(press("?", { shiftKey: true }));
		const sheet = el(page, "section", { "data-sheet": "" }, region);
		settled(settleEvent(region));
		const main = el(page, "main", { id: "main" });
		const heading = el(page, "h1", {}, main);
		settled(settleEvent(page.body));
		settled(settleEvent(syncRegion));
		expect(page.activeElement).toBe(second);
		expect(heading.focusCount).toBe(0);
		expect(win.history.replaceState).not.toHaveBeenCalled();
		remove(page, sheet);
		win.location.hash = "";
		settled(settleEvent(region));
		expect(second.focusCount).toBe(1);
		expect(win.history.replaceState).toHaveBeenCalledWith(
			{ htmx: true },
			"",
			"/transactions#budget",
		);
	});

	it("aborts a keys request still loading when Back restores the page, and takes a ? again", () => {
		const page = new FakePage();
		const region = el(page, "div", { id: "keys" });
		const win = windowFor();
		const { keydown, requested, restoring } = setup(page, win);
		keydown(press("?", { shiftKey: true }));
		const start = beforeRequestEvent(region);
		requested(start);
		restoring();
		expect(start.detail.ctx.request.abort).toHaveBeenCalledTimes(1);
		keydown(press("?", { shiftKey: true }));
		expect(win.htmx.ajax).toHaveBeenCalledTimes(2);
	});

	it("aborts nothing on a history restore when no keys request is loading", () => {
		const page = new FakePage();
		const region = el(page, "div", { id: "keys" });
		const win = windowFor();
		const { keydown, requested, ended, restoring } = setup(page, win);
		expect(() => restoring()).not.toThrow();
		expect(win.htmx.ajax).not.toHaveBeenCalled();
		keydown(press("?", { shiftKey: true }));
		const start = beforeRequestEvent(region);
		requested(start);
		// The keys request has swapped and finished, so the restore has no request left to abort.
		ended(finishEvent(region, "swapped"));
		restoring();
		expect(start.detail.ctx.request.abort).not.toHaveBeenCalled();
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

describe("Caps Lock (a letter reads the same with it on)", () => {
	// With Caps Lock on, a letter's event key is a capital and no Shift is held: the keys still act.
	it("moves between rows, opens a row and presses Undo for a capital letter", () => {
		const page = new FakePage();
		const [first, second] = list(page);
		const undo = el(page, "button", { "aria-keyshortcuts": "u" });
		const { keydown } = setup(page);
		keydown(press("J"));
		expect(page.activeElement).toBe(first);
		keydown(press("J"));
		expect(page.activeElement).toBe(second);
		keydown(press("K"));
		expect(page.activeElement).toBe(first);
		keydown(press("E"));
		expect(first.clicks).toBe(1);
		keydown(press("U"));
		expect(undo.clicks).toBe(1);
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

	it("takes Shift only as part of ? and /", () => {
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import toastSource from "../public/js/toast.js?raw";
import appStyles from "../src/styles/app.css?raw";
import { Icon } from "../src/views/icons";

it("names u on the Undo button, the key keyboard.js presses while the toast shows (decision 118)", () => {
	expect(toastSource).toContain('setAttribute("aria-keyshortcuts", "u")');
});

it("only maps the trusted feedback confirmation and clears it", () => {
	expect(toastSource).toContain('query.get("sent")');
	expect(toastSource).toContain('"Thanks. Sent."');
	expect(toastSource).toContain("history.replaceState");
	expect(toastSource).not.toContain('query.get("toast")');
});

// ---------------------------------------------------------------------------------------------
// A failed request says so (spec §8.5, decision 72's P38 A). toast.js is a classic script with no
// exports, so it's run against a small stand-in for the page: an element tree, and a document and
// body that are real event targets, so the events travel the way htmx's do.

const COULDNT_SAVE = "Couldn't save. Check your connection and try again.";
const COULDNT_LOAD = "Couldn't load. Check your connection and try again.";
const LONG_NAME = "x".repeat(48);

/** The page's document while a test runs, so a node that is focused becomes its activeElement. */
let activeDocument: { activeElement: unknown } | null = null;

class FakeNode extends EventTarget {
	children: FakeNode[] = [];
	parent: FakeNode | null = null;
	attrs = new Map<string, string>();
	id = "";
	className = "";
	method = "";
	action = "";
	type = "";
	disabled = false;
	name = "";
	value = "";
	/** A node's own text. */
	own = "";
	constructor(readonly tag: string) {
		super();
	}
	/** As in a real page: this node's own text, then its children's, in order. */
	get textContent(): string {
		return this.own + this.children.map((child) => child.textContent).join("");
	}
	set textContent(text: string) {
		this.own = text;
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
	/** Whether the node is on the page; a test sets it false for a node that has left. */
	isConnected = true;
	append(...nodes: FakeNode[]) {
		for (const node of nodes) {
			node.parent = this;
			this.children.push(node);
		}
	}
	remove() {
		this.parent?.children.splice(this.parent.children.indexOf(this), 1);
		this.parent = null;
	}
	/** Every node under this one, this one first. */
	all(): FakeNode[] {
		return [this, ...this.children.flatMap((child) => child.all())];
	}
	/** The first node under this one that matches a simple selector: a tag, then [attribute] or [attribute=value] parts. */
	querySelector(selector: string): FakeNode | null {
		const [, tag = "", conditions = ""] =
			selector.match(/^(\w+)((?:\[[^\]]+\])*)$/) ?? [];
		const wanted = [...conditions.matchAll(/\[([^=\]]+)(?:=([^\]]+))?\]/g)].map(
			([, name = "", value]) => ({ name, value }),
		);
		const matches = (node: FakeNode) =>
			node.tag === tag &&
			wanted.every(
				({ name, value }) =>
					node.attrs.has(name) &&
					(value === undefined || node.attrs.get(name) === value),
			);
		return this.children.flatMap((child) => child.all()).find(matches) ?? null;
	}
	/** The words a reader would hear: this node's own text and its children's, in order. */
	words(): string {
		return this.textContent;
	}
	/** Whether this node is the given one or holds it, as a real node's contains() does. */
	contains(node: unknown): boolean {
		return node === this || this.children.some((child) => child.contains(node));
	}
	/** Focus is the page's activeElement, as in a browser: focusing a node makes it the one that has focus. */
	focus() {
		if (activeDocument) activeDocument.activeElement = this;
	}
	/** The inline style toast.js sets on #toasts: setProperty and removeProperty, backed by a Map. */
	style = {
		values: new Map<string, string>(),
		setProperty(name: string, value: string) {
			this.values.set(name, value);
		},
		removeProperty(name: string) {
			this.values.delete(name);
		},
	};
	/** A laid-out height, which the Select bar's measurement reads. */
	offsetHeight = 0;
	/** The class list, as far as toast.js takes a class off a row: remove. */
	classList = {
		remove: (...names: string[]) => {
			this.className = this.className
				.split(" ")
				.filter((name) => name !== "" && !names.includes(name))
				.join(" ");
		},
	};
}

/** Every ResizeObserver toast.js made on the current page, so a test can see what it asked of each. */
let resizeObservers: FakeResizeObserver[] = [];

/** A ResizeObserver that records what toast.js asks of it; a test fires its callback itself. */
class FakeResizeObserver {
	/** Each call toast.js made, in order: observe with its node, or disconnect. */
	calls: Array<["observe", FakeNode] | ["disconnect"]> = [];
	/** The nodes it watches now. */
	observed: FakeNode[] = [];
	constructor(readonly callback: () => void) {
		resizeObservers.push(this);
	}
	observe(node: FakeNode) {
		this.calls.push(["observe", node]);
		this.observed.push(node);
	}
	disconnect() {
		this.calls.push(["disconnect"]);
		this.observed = [];
	}
}

const load = Object.values(import.meta.glob("../public/js/toast.js"))[0] as
	| (() => Promise<unknown>)
	| undefined;

/**
 * Puts a page in place, then runs toast.js against it. `listed: false` is a page with no list, so no
 * result count. `bar` is the Select mode action bar, when the page is in Select mode. `resizeObserver:
 * false` is a browser with no ResizeObserver. Nothing has focus until a test sets document.activeElement,
 * as a browser starts.
 */
async function page({
	listed = true,
	bar,
	selectAll,
	resizeObserver = true,
	billPage = false,
	sheet = false,
	inertSheet = false,
}: {
	listed?: boolean;
	bar?: FakeNode;
	/** The Select all control on the page: the link, or the count's stand-in for it (both have the id select-all-link). */
	selectAll?: FakeNode;
	resizeObserver?: boolean;
	/** A bill's page: no Transactions title, but its own page-title, which takes focus instead. */
	billPage?: boolean;
	/** A sheet open over the page: its section, and the heading that section is labelled by (#87). */
	sheet?: boolean;
	/** The sheet is a catalog drawing, inside an inert frame, so it is not the open sheet. */
	inertSheet?: boolean;
} = {}) {
	let toasts = new FakeNode("div");
	const announcer = new FakeNode("div");
	const resultCount = new FakeNode("p");
	// Every Transactions state renders the page's title, listed or not.
	const heading = new FakeNode("h1");
	const inertFrame = new FakeNode("div");
	inertFrame.setAttribute("inert", "");
	// closest("[inert]") finds the frame a drawing sits in, as a browser's closest() does.
	const sheetSection = sheet
		? Object.assign(new FakeNode("section"), {
				closest: (selector: string) =>
					inertSheet && selector === "[inert]" ? inertFrame : null,
			})
		: null;
	const sheetTitle = sheet ? new FakeNode("h2") : null;
	if (sheetSection && sheetTitle) {
		sheetSection.setAttribute("data-sheet", "");
		sheetSection.setAttribute("aria-labelledby", "sheet-title");
		sheetTitle.id = "sheet-title";
	}
	// The page's own nodes, where a test draws the rows a save's reply swaps in (and the marks they carry).
	const pageRoot = new FakeNode("main");
	const documentElement = new FakeNode("html");
	const body = new EventTarget();
	const documentTarget = new EventTarget();
	// As in a page, the body sits inside the document: an event sent from the body that bubbles reaches the
	// document's listeners, as htmx's events and plaid-link.js's announce do. toast.js listens on the document.
	const sendFromBody = body.dispatchEvent.bind(body);
	body.dispatchEvent = (event: Event) => {
		if (event.bubbles)
			documentTarget.dispatchEvent(
				new CustomEvent(event.type, {
					detail: (event as CustomEvent).detail,
				}),
			);
		return sendFromBody(event);
	};
	const document = Object.assign(documentTarget, {
		body,
		documentElement,
		activeElement: body as unknown,
		querySelectorAll: (selector: string) =>
			selector === "section[data-sheet]" && sheetSection
				? [sheetSection]
				: selector === ".row-saved, .row-saved-undo"
					? pageRoot
							.all()
							.filter((node) =>
								node.className
									.split(" ")
									.some(
										(name) => name === "row-saved" || name === "row-saved-undo",
									),
							)
					: [],
		getElementById: (id: string) =>
			id === "toasts"
				? toasts
				: id === "announcer"
					? announcer
					: id === "selection-bar"
						? (bar ?? null)
						: id === "select-all-link"
							? (selectAll ?? null)
							: id === "sheet-title"
								? sheetTitle
								: id === "transactions-title"
									? billPage
										? null
										: heading
									: id === "page-title" && billPage
										? heading
										: id === "result-count" && listed
											? resultCount
											: null,
		createElement: (tag: string) => new FakeNode(tag),
		createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
		createTextNode: (text: string) =>
			Object.assign(new FakeNode("#text"), { textContent: text }),
	});
	// htmx replacing the body's children (a body swap, or a history restore) puts a new #toasts in place.
	const swapBody = () => {
		toasts = new FakeNode("div");
		return toasts;
	};
	vi.stubGlobal("document", document);
	activeDocument = document;
	vi.stubGlobal("location", { search: "", pathname: "/", hash: "" });
	vi.stubGlobal("history", { replaceState: () => {} });
	const htmx = { process: vi.fn() };
	vi.stubGlobal("window", { htmx });
	vi.stubGlobal("requestAnimationFrame", (run: () => void) => run());
	vi.stubGlobal("getComputedStyle", (node: FakeNode) => ({
		getPropertyValue: (name: string) =>
			name ===
			(node.className.includes("undo-toast")
				? "--duration-undo-toast"
				: "--duration-toast")
				? node.className.includes("undo-toast")
					? "10s"
					: "4s"
				: "",
	}));
	resizeObservers = [];
	vi.stubGlobal(
		"ResizeObserver",
		resizeObserver ? FakeResizeObserver : undefined,
	);
	vi.resetModules();
	await load?.();
	return {
		document,
		documentElement,
		body,
		toasts,
		announcer,
		htmx,
		resultCount,
		heading,
		sheetTitle,
		bar,
		resizeObservers,
		swapBody,
		pageRoot,
	};
}

/** The observer that watches a node: toast.js has one for the Select bar and one for #toasts. */
const observerOf = (observers: FakeResizeObserver[], node: FakeNode) =>
	observers.find((observer) =>
		observer.calls.some(
			([call, target]) => call === "observe" && target === node,
		),
	) as FakeResizeObserver;

const fire = (target: EventTarget, name: string, detail: unknown) =>
	target.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));

/** htmx 4's ctx for a reply: the request's method (upper case, as htmx makes it) and the status. */
const status = (code: number, method = "POST") => ({
	ctx: { request: { method }, response: { status: code } },
});
/** ...and for a request that never got an answer. */
const dropped = (method = "POST") => ({
	ctx: { request: { method } },
	error: new TypeError("Failed to fetch"),
});

describe("cash entry confirmations", () => {
	it("wraps an unbroken merchant name inside the toast", async () => {
		const { body, toasts } = await page();
		fire(body, "toast", { message: `Added ${LONG_NAME}` });
		const toast = toasts.children[0] as FakeNode;
		expect(toast.words()).toBe(`Added ${LONG_NAME}`);
		expect(toast.className).toMatch(/\bmin-w-0\b/);
		expect(toast.className).toMatch(/\bmax-w-full\b/);
		expect(toast.className).toMatch(/\bwrap-anywhere\b/);
	});
});

describe("a saved row's mark", () => {
	/** A row a save's reply swapped in, with the mark that save gave it. */
	const swapIn = (pageRoot: FakeNode, mark = "row-saved") => {
		const row = new FakeNode("div");
		row.className = mark;
		pageRoot.append(row);
		return row;
	};
	/** An Undo toast: it keeps its own mark for its ten seconds. */
	const undoToast = (target: EventTarget, undo = "token") =>
		fire(target, "toast", {
			message: "Deleted Coffee, $5.00.",
			undo,
			undoExpiresInMs: 10000,
		});

	it("ends the earlier save's mark when a later save's toast replaces its toast, even when the later save marks no row (#597)", async () => {
		const { document, pageRoot } = await page();
		// The time zone's save: its reply swaps its row in with the mark, then its toast comes.
		const zone = swapIn(pageRoot);
		fire(document, "toast", { message: "Saved time zone" });
		// The bank sign-in emails switch: its reply swaps another region in, and draws no mark.
		fire(document, "toast", { message: "Saved bank sign-in emails" });
		expect(zone.className).toBe("");
	});

	it("keeps the newest save's mark and ends the earlier one: two saves never mark two rows", async () => {
		const { document, pageRoot } = await page();
		const first = swapIn(pageRoot);
		fire(document, "toast", { message: "Saved time zone" });
		// The second save's reply swaps its own row in with the mark, beside the first row the page still has.
		const second = swapIn(pageRoot);
		fire(document, "toast", { message: "Saved Groceries" });
		expect(first.className).toBe("");
		expect(second.className).toBe("row-saved");
	});

	it("ends the earlier save's mark when a later save fails, since that failure's toast replaces the earlier one", async () => {
		const { document, pageRoot } = await page();
		const zone = swapIn(pageRoot);
		fire(document, "toast", { message: "Saved time zone" });
		fire(document, "htmx:error", dropped("POST"));
		expect(zone.className).toBe("");
	});

	it("keeps a plain save's mark while a later Undo toast is up, and ends it when the plain toast's 4 seconds are up", async () => {
		const { document, pageRoot } = await page();
		const zone = swapIn(pageRoot);
		fire(document, "toast", { message: "Saved time zone" });
		undoToast(document);
		vi.advanceTimersByTime(3999);
		expect(zone.className).toBe("row-saved");
		vi.advanceTimersByTime(1);
		expect(zone.className).toBe("");
	});

	it("keeps an Undo toast's own mark while a later plain toast is up, and ends it at the Undo toast's 10 seconds", async () => {
		const { document, pageRoot } = await page();
		const coffee = swapIn(pageRoot, "row-saved-undo");
		undoToast(document);
		vi.advanceTimersByTime(1000);
		fire(document, "toast", { message: "Saved Groceries' budget." });
		vi.advanceTimersByTime(8999);
		expect(coffee.className).toBe("row-saved-undo");
		vi.advanceTimersByTime(1);
		expect(coffee.className).toBe("");
	});

	it("ends an Undo toast's mark at once when a later toast's undoDone names its token", async () => {
		const { document, pageRoot } = await page();
		const coffee = swapIn(pageRoot, "row-saved-undo");
		undoToast(document, "token-coffee");
		fire(document, "toast", {
			message: "Restored Coffee.",
			undoDone: "token-coffee",
		});
		expect(coffee.className).toBe("");
	});

	it("does not bring back a cleared mark when the Likely sheet's close morphs the row, since its toast was replaced (#681)", async () => {
		const { document, pageRoot } = await page();
		const row = swapIn(pageRoot);
		fire(document, "toast", { message: "Saved time zone" });
		fire(document, "htmx:error", dropped("GET"));
		expect(row.className).toBe("");
		// The close's morph keeps the row's element and sets its saved mark again, then htmx's finally runs.
		row.className = "row-saved";
		fire(document, "htmx:finally:request", { ctx: {} });
		expect(row.className).toBe("");
	});

	it("keeps the mark when the close morphs the row while the save's own toast is still up, and ends it with that toast", async () => {
		const { document, pageRoot } = await page();
		const row = swapIn(pageRoot);
		fire(document, "toast", { message: "Saved time zone" });
		row.className = "row-saved";
		fire(document, "htmx:finally:request", { ctx: {} });
		expect(row.className).toBe("row-saved");
		vi.advanceTimersByTime(4000);
		expect(row.className).toBe("");
	});

	it("does not strip a row a later reply re-marked and claimed, when an earlier toast's late timer runs", async () => {
		const { document, pageRoot } = await page();
		const row = swapIn(pageRoot);
		fire(document, "toast", { message: "Saved time zone" });
		vi.advanceTimersByTime(1000);
		// A failure replaces the save's toast, so its mark ends.
		fire(document, "htmx:error", dropped("POST"));
		expect(row.className).toBe("");
		// A later save's reply marks the same row again, and its own toast claims the mark before htmx's finally.
		row.className = "row-saved";
		fire(document, "toast", { message: "Saved Rent's budget." });
		fire(document, "htmx:finally:request", { ctx: {} });
		// The time zone's toast was due at 4000 ms: its late timer must leave the newer claim alone.
		vi.advanceTimersByTime(3000);
		expect(row.className).toBe("row-saved");
		// The newer toast's own 4 seconds end it, at 5000 ms.
		vi.advanceTimersByTime(2000);
		expect(row.className).toBe("");
	});
});

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("a request that never reached Tally", () => {
	it("shows the error toast in role=alert, with the alert icon in text-over before the words", async () => {
		const { document, toasts } = await page();
		fire(document, "htmx:error", {
			ctx: {},
			error: new TypeError("Failed to fetch"),
		});
		expect(toasts.children).toHaveLength(1);
		const toast = toasts.children[0] as FakeNode;
		expect(toast.attrs.get("role")).toBe("alert");
		expect(toast.words()).toBe(COULDNT_SAVE);
		// The icon comes first, in the brick token, and is hidden from screen readers.
		const [icon] = toast.children as [FakeNode];
		expect(icon.className).toContain("text-over");
		const svg = icon.children[0] as FakeNode;
		expect(svg.tag).toBe("svg");
		expect(svg.attrs.get("aria-hidden")).toBe("true");
		// An SVG element takes its class as an attribute; assigning className would not work there.
		expect(svg.attrs.get("class")).toBe("size-5");
	});

	it("draws the same alert icon as Icon, so the two can't drift", async () => {
		const paths = [
			...String(Icon({ name: "alert" })).matchAll(/ d="([^"]+)"/g),
		];
		expect(paths.length).toBeGreaterThan(0);
		for (const [, d] of paths) expect(toastSource).toContain(`"${d}"`);
		const { document, toasts } = await page();
		fire(document, "htmx:error", {
			ctx: {},
			error: new TypeError("Failed to fetch"),
		});
		const svg = (toasts.children[0] as FakeNode)
			.all()
			.find((n) => n.tag === "svg");
		expect(svg?.attrs.get("stroke-width")).toBe("1.75");
		expect(svg?.attrs.get("stroke")).toBe("currentColor");
		const drawn = (svg?.children ?? []).map((n) => n.attrs.get("d"));
		expect(drawn).toEqual(paths.map((m) => m[1]));
	});

	it("says nothing about an htmx error that isn't a request, such as a bug in a handler", async () => {
		const { document, toasts } = await page();
		fire(document, "htmx:error", { error: new Error("handler bug") });
		expect(toasts.children).toHaveLength(0);
	});

	it("says nothing when a request was replaced or cancelled on purpose", async () => {
		const { document, toasts } = await page();
		fire(document, "htmx:error", {
			ctx: {},
			error: new DOMException("The operation was aborted.", "AbortError"),
		});
		expect(toasts.children).toHaveLength(0);
	});
});

// htmx 4 aborts a request that timed out exactly as it aborts one that was replaced (hx-sync) or
// cancelled (htmx:abort): ctx.request.abort(), an AbortError with no reason, and no timeout event.
// So Layout turns htmx's own timeout off (defaultTimeout: 0) and toast.js keeps the 60 seconds
// itself: when its timer fires it marks the request as timed out, then aborts it. Only a marked
// request's AbortError is a failure.
describe("a request that timed out", () => {
	/** A request whose abort(), like htmx's, makes the fetch reject with an AbortError. */
	const request = (document: EventTarget, method = "POST") => {
		const ctx: { request: { method: string; abort: () => void } } = {
			request: {
				method,
				abort: vi.fn(() =>
					fire(document, "htmx:error", {
						ctx,
						error: new DOMException("The operation was aborted.", "AbortError"),
					}),
				),
			},
		};
		return ctx;
	};
	const start = (document: EventTarget, ctx: object) =>
		fire(document, "htmx:before:request", { ctx });
	const end = (document: EventTarget, ctx: object) =>
		fire(document, "htmx:finally:request", { ctx });

	it("aborts the request itself at 60 seconds and says it couldn't save", async () => {
		const { document, toasts } = await page();
		const ctx = request(document);
		start(document, ctx);
		vi.advanceTimersByTime(59999);
		expect(ctx.request.abort).not.toHaveBeenCalled();
		expect(toasts.children).toHaveLength(0);
		vi.advanceTimersByTime(1);
		expect(ctx.request.abort).toHaveBeenCalledTimes(1);
		expect(toasts.children).toHaveLength(1);
		const toast = toasts.children[0] as FakeNode;
		expect(toast.words()).toBe(COULDNT_SAVE);
		expect(toast.attrs.get("role")).toBe("alert");
	});

	it("says it couldn't load when a GET times out", async () => {
		const { document, toasts } = await page();
		const ctx = request(document, "GET");
		start(document, ctx);
		vi.advanceTimersByTime(60000);
		expect((toasts.children[0] as FakeNode).words()).toBe(COULDNT_LOAD);
	});

	it("says nothing when a request is replaced or cancelled, even just before its limit", async () => {
		const { document, toasts } = await page();
		const ctx = request(document);
		start(document, ctx);
		vi.advanceTimersByTime(59900);
		// htmx aborts it (a newer request replaced it); its AbortError arrives, then it finishes.
		ctx.request.abort();
		end(document, ctx);
		expect(toasts.children).toHaveLength(0);
		// Its timer was cleared with it: nothing fires later.
		vi.advanceTimersByTime(120000);
		expect(ctx.request.abort).toHaveBeenCalledTimes(1);
		expect(toasts.children).toHaveLength(0);
	});

	it("stops its timer when the request finishes, so a quick reply is never aborted", async () => {
		const { document, toasts } = await page();
		const ctx = request(document);
		start(document, ctx);
		vi.advanceTimersByTime(1000);
		end(document, ctx);
		vi.advanceTimersByTime(120000);
		expect(ctx.request.abort).not.toHaveBeenCalled();
		expect(toasts.children).toHaveLength(0);
	});

	it("marks only the request that timed out", async () => {
		const { document, toasts } = await page();
		const slow = request(document);
		const other = request(document);
		start(document, slow);
		vi.advanceTimersByTime(30000);
		start(document, other);
		vi.advanceTimersByTime(30000);
		expect(slow.request.abort).toHaveBeenCalledTimes(1);
		expect(toasts.children).toHaveLength(1);
		vi.advanceTimersByTime(4000);
		// The other is replaced 10 seconds later: silent, though a request did time out before it.
		vi.advanceTimersByTime(6000);
		other.request.abort();
		end(document, other);
		expect(toasts.children).toHaveLength(0);
	});

	it("says nothing for an abort of a request it never saw start", async () => {
		const { document, toasts } = await page();
		fire(document, "htmx:error", {
			ctx: { request: { method: "POST" } },
			error: new DOMException("The operation was aborted.", "AbortError"),
		});
		expect(toasts.children).toHaveLength(0);
	});

	it("keeps no timer for an event that carries no request", async () => {
		const { document } = await page();
		expect(() => fire(document, "htmx:before:request", {})).not.toThrow();
		expect(() => fire(document, "htmx:finally:request", {})).not.toThrow();
	});
});

describe("a reply from Tally's server", () => {
	it("shows the toast for a 500, which an unhandled error sends", async () => {
		const { document, toasts } = await page();
		fire(document, "htmx:response:error", status(500));
		expect(toasts.children).toHaveLength(1);
		expect((toasts.children[0] as FakeNode).words()).toBe(COULDNT_SAVE);
		expect((toasts.children[0] as FakeNode).attrs.get("role")).toBe("alert");
	});

	it.each([400, 404, 422, 502])(
		"leaves a %i alone: its reply carries its own message on purpose, such as a field's error or a bank that couldn't be reached",
		async (code) => {
			const { document, toasts } = await page();
			fire(document, "htmx:response:error", status(code));
			expect(toasts.children).toHaveLength(0);
		},
	);

	it("ignores an error event with no status at all", async () => {
		const { document, toasts } = await page();
		fire(document, "htmx:response:error", {});
		expect(toasts.children).toHaveLength(0);
	});
});

describe("what the toast says depends on what was being done", () => {
	it("says it couldn't load when a GET fails: a filter, or opening a sheet", async () => {
		const { document, toasts } = await page();
		fire(document, "htmx:error", dropped("GET"));
		expect(toasts.children).toHaveLength(1);
		const toast = toasts.children[0] as FakeNode;
		expect(toast.words()).toBe(COULDNT_LOAD);
		expect(toast.attrs.get("role")).toBe("alert");
		// Still the alert icon: an error is never colour alone.
		expect(toast.all().some((n) => n.tag === "svg")).toBe(true);
	});

	it("says it couldn't load when a GET gets a 500", async () => {
		const { document, toasts } = await page();
		fire(document, "htmx:response:error", status(500, "GET"));
		expect((toasts.children[0] as FakeNode).words()).toBe(COULDNT_LOAD);
	});

	it.each(["POST", "PUT", "PATCH", "DELETE"])(
		"says it couldn't save when a %s fails, dropped or answered with a 500",
		async (method) => {
			const { document, toasts } = await page();
			fire(document, "htmx:error", dropped(method));
			vi.advanceTimersByTime(4000);
			fire(document, "htmx:response:error", status(500, method));
			expect(toasts.children).toHaveLength(1);
			expect((toasts.children[0] as FakeNode).words()).toBe(COULDNT_SAVE);
		},
	);

	it("says it couldn't save when the method isn't known", async () => {
		const { document, toasts } = await page();
		fire(document, "htmx:error", { ctx: {}, error: new TypeError("x") });
		expect((toasts.children[0] as FakeNode).words()).toBe(COULDNT_SAVE);
	});

	it("reads the method however htmx cased it", async () => {
		const { document, toasts } = await page();
		fire(document, "htmx:error", dropped("get"));
		expect((toasts.children[0] as FakeNode).words()).toBe(COULDNT_LOAD);
	});

	it("shows only the newest of a load failure and a save failure", async () => {
		const { document, toasts } = await page();
		fire(document, "htmx:error", dropped("GET"));
		fire(document, "htmx:error", dropped("POST"));
		expect(toasts.children.map((t) => t.words())).toEqual([COULDNT_SAVE]);
	});
});

describe("several failures at once", () => {
	it("show one toast, not a stack of the same words, and again once it has gone", async () => {
		const { document, toasts } = await page();
		for (let i = 0; i < 3; i++) {
			fire(document, "htmx:error", {
				ctx: {},
				error: new TypeError("Failed to fetch"),
			});
		}
		expect(toasts.children).toHaveLength(1);
		vi.advanceTimersByTime(4000);
		expect(toasts.children).toHaveLength(0);
		fire(document, "htmx:response:error", status(500));
		expect(toasts.children).toHaveLength(1);
	});

	it("says a retry that fails again a couple of seconds later, with a fresh alert and a fresh 4 seconds", async () => {
		const { document, toasts } = await page();
		fire(document, "htmx:response:error", status(500));
		const first = toasts.children[0];
		vi.advanceTimersByTime(2000);
		// Save tapped again while the first toast is still up, and it fails too.
		fire(document, "htmx:response:error", status(500));
		// Still one copy on screen, but a new element: a screen reader hears the alert again.
		expect(toasts.children).toHaveLength(1);
		expect(toasts.children[0]).not.toBe(first);
		expect((toasts.children[0] as FakeNode).attrs.get("role")).toBe("alert");
		expect((toasts.children[0] as FakeNode).words()).toBe(COULDNT_SAVE);
		// The first failure's 4 seconds end at t=4000; the retry's run to t=6000.
		vi.advanceTimersByTime(3000);
		expect(toasts.children).toHaveLength(1);
		vi.advanceTimersByTime(1000);
		expect(toasts.children).toHaveLength(0);
	});

	it("still says a later failure after the device clock moves back", async () => {
		const { document, toasts } = await page();
		fire(document, "htmx:response:error", status(500));
		const first = toasts.children[0];
		// The clock is corrected a minute back; two seconds later the retry fails too.
		vi.setSystemTime(Date.now() - 60000);
		vi.advanceTimersByTime(2000);
		fire(document, "htmx:response:error", status(500));
		expect(toasts.children).toHaveLength(1);
		expect(toasts.children[0]).not.toBe(first);
	});

	it("still shows one toast for failures in the same moment, even when an earlier one is nearly gone", async () => {
		const { document, toasts } = await page();
		fire(document, "htmx:response:error", status(500));
		vi.advanceTimersByTime(3500);
		for (let i = 0; i < 3; i++) {
			fire(document, "htmx:response:error", status(500));
		}
		expect(toasts.children).toHaveLength(1);
		// The first toast's timer fires at t=4000; the burst's one toast has its own 4 seconds.
		vi.advanceTimersByTime(500);
		expect(toasts.children).toHaveLength(1);
	});

	it("says the newest failure when a load and a save failure alternate within a second", async () => {
		const { document, toasts } = await page();
		fire(document, "htmx:error", dropped("GET"));
		fire(document, "htmx:error", dropped("POST"));
		fire(document, "htmx:error", dropped("GET"));
		expect(toasts.children.map((t) => t.words())).toEqual([COULDNT_LOAD]);
		expect((toasts.children[0] as FakeNode).attrs.get("role")).toBe("alert");
	});

	it("says a failure again when a success toast replaced its toast within a second", async () => {
		const { document, body, toasts } = await page();
		fire(document, "htmx:response:error", status(500));
		fire(body, "toast", { message: "Saved." });
		expect(toasts.children.map((t) => t.words())).toEqual(["Saved."]);
		fire(document, "htmx:response:error", status(500));
		expect(toasts.children.map((t) => t.words())).toEqual([COULDNT_SAVE]);
		expect((toasts.children[0] as FakeNode).attrs.get("role")).toBe("alert");
	});

	it("says a failure again on the new #toasts after htmx replaces the body within a second", async () => {
		const { document, toasts, swapBody } = await page();
		fire(document, "htmx:response:error", status(500));
		expect(toasts.children).toHaveLength(1);
		const next = swapBody();
		fire(document, "htmx:response:error", status(500));
		expect(next.children).toHaveLength(1);
		expect((next.children[0] as FakeNode).words()).toBe(COULDNT_SAVE);
	});
});

describe("the toasts the server sends", () => {
	it("builds the cash-delete Undo form from the toast detail", async () => {
		const { body, toasts, htmx } = await page();
		const token = '"><img src=x onerror=alert(1)>';
		fire(body, "toast", {
			message: "Deleted Coffee, $5.00.",
			undo: token,
			undoExpiresInMs: 10000,
		});
		const toast = toasts.children[0] as FakeNode;
		const form = toast.all().find((node) => node.tag === "form");
		expect(form).toBeDefined();
		expect(form?.action).toBe("/transactions/undo-cash-delete");
		expect(form?.method).toBe("post");
		const fields = form?.children.filter((node) => node.tag === "input") ?? [];
		expect(
			fields.map(({ name, type, value }) => ({ name, type, value })),
		).toEqual([
			{ name: "token", type: "hidden", value: token },
			{ name: "back", type: "hidden", value: "/" },
		]);
		expect(toast.all().some((node) => node.tag === "img")).toBe(false);
		const button = form?.children.find((node) => node.tag === "button");
		expect(button?.type).toBe("submit");
		expect(button?.textContent).toBe("Undo");
		expect(button?.className).toContain("min-h-11");
		// A native submit button is in the tab order unless explicitly removed from it.
		expect(button?.attrs.get("tabindex")).not.toBe("-1");
		form?.dispatchEvent(new Event("submit"));
		expect(button?.disabled).toBe(true);
		expect(toast.attrs.get("role")).toBe("status");
		expect(htmx.process).toHaveBeenCalledWith(toast);
		expect(appStyles).toContain("--duration-undo-toast: 10s");
		// The page's CSP (style-src 'self') refuses a style attribute, so the duration is set as a custom property.
		expect(toast.attrs.has("style")).toBe(false);
		expect(toast.style.values.get("--duration-undo-toast")).toBe("10000ms");
		expect(toastSource).toContain("undoExpiresInMs");
		expect(toastSource).not.toContain("undo ? 10_000");
	});

	it("posts a bill's Undo to the action the toast detail names", async () => {
		const { body, toasts } = await page();
		fire(body, "toast", {
			message: "Payment unlinked",
			undo: "17",
			undoExpiresInMs: 10000,
			undoAction: "/bills/1/undo-unlink",
		});
		const form = (toasts.children[0] as FakeNode)
			.all()
			.find((node) => node.tag === "form");
		expect(form?.action).toBe("/bills/1/undo-unlink");
		expect(form?.attrs.get("hx-post")).toBe("/bills/1/undo-unlink");
		expect(form?.attrs.get("hx-select")).toBe("#page");
	});

	it("keeps an Undo toast for the server's remaining 4,000 ms", async () => {
		const { body, toasts } = await page();
		fire(body, "toast", {
			message: "Deleted Coffee, $5.00.",
			undo: "token",
			undoExpiresInMs: 4000,
		});
		const toast = toasts.children[0] as FakeNode;
		expect(toast.attrs.get("role")).toBe("status");
		expect(toast.all().some((node) => node.tag === "form")).toBe(true);
		// A shorter remaining window still sets the per-toast duration, as a custom property and no style attribute.
		expect(toast.attrs.has("style")).toBe(false);
		expect(toast.style.values.get("--duration-undo-toast")).toBe("4000ms");
		vi.advanceTimersByTime(3999);
		expect(toasts.children).toContain(toast);
		vi.advanceTimersByTime(1);
		expect(toasts.children).not.toContain(toast);
	});

	it.each([0, -1])(
		"does not show Undo with %i ms remaining",
		async (undoExpiresInMs) => {
			const { body, toasts } = await page();
			fire(body, "toast", {
				message: "Deleted Coffee, $5.00.",
				undo: "token",
				undoExpiresInMs,
			});
			expect(toasts.children).toHaveLength(0);
		},
	);

	it("does not render an Undo form without undo detail", async () => {
		const { body, toasts } = await page();
		fire(body, "toast", { message: "Saved." });
		expect(toasts.children[0]?.all().some((node) => node.tag === "form")).toBe(
			false,
		);
	});

	it("draws the alert icon on any error toast too, so an error is never colour alone", async () => {
		const { body, toasts } = await page();
		fire(body, "toast", { message: "That didn't save.", type: "error" });
		const toast = toasts.children[0] as FakeNode;
		expect(toast.attrs.get("role")).toBe("alert");
		expect(toast.words()).toBe("That didn't save.");
		expect(toast.all().some((n) => n.tag === "svg")).toBe(true);
	});

	it("keeps a success toast as it was: plain text, role=status, no icon", async () => {
		const { body, toasts } = await page();
		fire(body, "toast", { message: "Saved Groceries' budget." });
		const toast = toasts.children[0] as FakeNode;
		expect(toast.attrs.get("role")).toBe("status");
		expect(toast.textContent).toBe("Saved Groceries' budget.");
		expect(toast.children).toHaveLength(0);
	});
});

// Only the newest plain or error toast shows, so a stack never covers the page. An Undo toast is
// the one exception: it stays until its own time is up, and a newer toast never removes it early.
describe("only the newest plain or error toast shows", () => {
	it("replaces a plain toast with the next one", async () => {
		const { body, toasts } = await page();
		fire(body, "toast", { message: "Saved Groceries' budget." });
		fire(body, "toast", { message: "Saved Rent's budget." });
		expect(toasts.children.map((t) => t.words())).toEqual([
			"Saved Rent's budget.",
		]);
	});

	it("lets an error and a plain toast replace each other", async () => {
		const { body, document, toasts } = await page();
		fire(body, "toast", { message: "Saved Groceries' budget." });
		fire(document, "htmx:error", dropped("POST"));
		expect(toasts.children.map((t) => t.words())).toEqual([COULDNT_SAVE]);
		fire(body, "toast", { message: "Saved Rent's budget." });
		expect(toasts.children.map((t) => t.words())).toEqual([
			"Saved Rent's budget.",
		]);
	});

	it("never removes an Undo toast early, even when a newer toast replaces the one before", async () => {
		const { body, toasts } = await page();
		fire(body, "toast", {
			message: "Deleted Coffee, $5.00.",
			undo: "token",
			undoExpiresInMs: 10000,
		});
		const undo = toasts.children[0] as FakeNode;
		// t=3s: a plain toast; t=5s: a newer plain toast replaces it. The Undo toast stays throughout.
		vi.advanceTimersByTime(3000);
		fire(body, "toast", { message: "Saved Groceries' budget." });
		vi.advanceTimersByTime(2000);
		fire(body, "toast", { message: "Saved Rent's budget." });
		expect(toasts.children).toHaveLength(2);
		expect(toasts.children[0]).toBe(undo);
		expect((toasts.children[1] as FakeNode).words()).toBe(
			"Saved Rent's budget.",
		);
		// t=9s: the newer plain toast's 4 seconds are up; the Undo toast has 1 second left.
		vi.advanceTimersByTime(4000);
		expect(toasts.children).toEqual([undo]);
		vi.advanceTimersByTime(999);
		expect(toasts.children[0]).toBe(undo);
		// t=10s: the Undo toast's own 10 seconds are up.
		vi.advanceTimersByTime(1);
		expect(toasts.children).toHaveLength(0);
	});

	it("keeps an Undo toast for its full 10 seconds, not the 4 of a plain toast", async () => {
		const { body, toasts } = await page();
		fire(body, "toast", {
			message: "Deleted Coffee, $5.00.",
			undo: "token",
			undoExpiresInMs: 10000,
		});
		vi.advanceTimersByTime(9999);
		expect(toasts.children).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(toasts.children).toHaveLength(0);
	});

	it("keeps the first bill Undo toast when a second Not this one's Undo toast comes", async () => {
		const { body, toasts } = await page();
		const notThisOne = {
			message: "Payment unlinked",
			undoExpiresInMs: 10000,
			undoAction: "/bills/1/undo-unlink",
		};
		fire(body, "toast", { ...notThisOne, undo: "1.first" });
		const first = toasts.children[0];
		fire(body, "toast", { ...notThisOne, undo: "1.second" });
		expect(toasts.children).toHaveLength(2);
		expect(toasts.children[0]).toBe(first);
	});
});

describe("focus on an Undo toast", () => {
	const undoToast = (body: EventTarget) =>
		fire(body, "toast", {
			message: "Deleted Coffee, $5.00.",
			undo: "token",
			undoExpiresInMs: 10000,
		});
	const undoButton = (toast: FakeNode) =>
		toast.all().find((node) => node.tag === "button");

	it("moves focus to the Undo button as the toast appears, after a delete", async () => {
		const { body, document, toasts } = await page();
		undoToast(body);
		expect(document.activeElement).toBe(
			undoButton(toasts.children[0] as FakeNode),
		);
	});

	it("leaves focus where it is for a plain toast", async () => {
		const { body, document } = await page();
		fire(body, "toast", { message: "Saved Groceries' budget." });
		expect(document.activeElement).toBe(body);
	});

	it("moves focus to the Transactions heading when the Undo toast ends with focus on Undo", async () => {
		const { body, document, toasts, resultCount, heading } = await page();
		const headingFocus = vi.spyOn(heading, "focus");
		const countFocus = vi.spyOn(resultCount, "focus");
		undoToast(body);
		const undo = toasts.children[0] as FakeNode;
		expect(document.activeElement).toBe(undoButton(undo));
		vi.advanceTimersByTime(9999);
		expect(headingFocus).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(toasts.children).toHaveLength(0);
		expect(headingFocus).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(heading);
		expect(heading.attrs.get("tabindex")).toBe("-1");
		// The owner's pick (#342): the heading takes focus when the toast goes, not the list's count.
		expect(countFocus).not.toHaveBeenCalled();
	});

	it("moves focus to a bill page's title when its Undo toast ends with focus on Undo", async () => {
		const { body, document, toasts, heading } = await page({ billPage: true });
		const titleFocus = vi.spyOn(heading, "focus");
		undoToast(body);
		const undo = toasts.children[0] as FakeNode;
		expect(document.activeElement).toBe(undoButton(undo));
		vi.advanceTimersByTime(10000);
		expect(toasts.children).toHaveLength(0);
		expect(titleFocus).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(heading);
	});

	it("moves focus to the same heading on the first-visit list, which has no result count", async () => {
		const { body, document, toasts, heading } = await page({ listed: false });
		const focus = vi.spyOn(heading, "focus");
		undoToast(body);
		expect(document.activeElement).toBe(
			undoButton(toasts.children[0] as FakeNode),
		);
		vi.advanceTimersByTime(10000);
		expect(focus).toHaveBeenCalledTimes(1);
		expect(heading.attrs.get("tabindex")).toBe("-1");
		expect(toasts.children).toHaveLength(0);
	});

	it("leaves focus where the user put it when the Undo toast ends without focus on Undo", async () => {
		const { body, document, heading } = await page();
		const headingFocus = vi.spyOn(heading, "focus");
		undoToast(body);
		const elsewhere = new FakeNode("input");
		document.activeElement = elsewhere;
		vi.advanceTimersByTime(10000);
		expect(headingFocus).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(elsewhere);
	});
});

// A sheet is open over the page (#87): the page behind it is inert, so focus that a toast hands back goes to the
// sheet's own heading, not to the Transactions heading behind it.
describe("focus from an Undo toast while a sheet is open", () => {
	const TOKEN = "3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c";
	const undoToast = (body: EventTarget) =>
		fire(body, "toast", {
			message: "Deleted Coffee, $5.00.",
			undo: TOKEN,
			undoExpiresInMs: 10000,
		});
	const undoButton = (toast: FakeNode) =>
		toast.all().find((node) => node.tag === "button") as FakeNode;

	it("moves focus to the sheet's title, not the Transactions heading, when the Undo toast's time runs out", async () => {
		const { body, document, toasts, heading, sheetTitle } = await page({
			sheet: true,
		});
		const title = sheetTitle as FakeNode;
		const headingFocus = vi.spyOn(heading, "focus");
		const titleFocus = vi.spyOn(title, "focus");
		undoToast(body);
		expect(document.activeElement).toBe(
			undoButton(toasts.children[0] as FakeNode),
		);
		vi.advanceTimersByTime(10000);
		expect(toasts.children).toHaveLength(0);
		expect(titleFocus).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(title);
		expect(title.attrs.get("tabindex")).toBe("-1");
		expect(headingFocus).not.toHaveBeenCalled();
	});

	it("moves focus to the sheet's title when an Undo's answer ends its toast while focus is on Undo", async () => {
		const { body, document, toasts, heading, sheetTitle } = await page({
			sheet: true,
		});
		const title = sheetTitle as FakeNode;
		const headingFocus = vi.spyOn(heading, "focus");
		undoToast(body);
		const undo = toasts.children[0] as FakeNode;
		expect(document.activeElement).toBe(undoButton(undo));
		fire(body, "toast", {
			message: "That cash entry is already back.",
			type: "success",
			undoDone: TOKEN,
		});
		expect(toasts.children).not.toContain(undo);
		expect(document.activeElement).toBe(title);
		expect(title.attrs.get("tabindex")).toBe("-1");
		expect(headingFocus).not.toHaveBeenCalled();
	});

	it("moves focus to the sheet's title when an Undo request fails after its time ran out and focus is lost", async () => {
		const { body, document, toasts, heading, sheetTitle } = await page({
			sheet: true,
		});
		const title = sheetTitle as FakeNode;
		const headingFocus = vi.spyOn(heading, "focus");
		const titleFocus = vi.spyOn(title, "focus");
		undoToast(body);
		const undo = toasts.children[0] as FakeNode;
		const form = undo.all().find((node) => node.tag === "form") as FakeNode;
		form.dispatchEvent(new Event("submit"));
		document.activeElement = body;
		vi.advanceTimersByTime(10000);
		expect(toasts.children).not.toContain(undo);
		fire(document, "htmx:error", {
			ctx: { sourceElement: form, request: { method: "POST" } },
			error: new TypeError("Failed to fetch"),
		});
		expect(titleFocus).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(title);
		expect(headingFocus).not.toHaveBeenCalled();
	});

	// A catalog drawing is a sheet inside an inert frame, so it is not the open sheet: the Transactions heading takes focus.
	it("passes over a sheet drawn inside an inert frame, so focus goes to the Transactions heading and not the drawing's title", async () => {
		const { body, document, toasts, heading, sheetTitle } = await page({
			sheet: true,
			inertSheet: true,
		});
		const title = sheetTitle as FakeNode;
		const headingFocus = vi.spyOn(heading, "focus");
		const titleFocus = vi.spyOn(title, "focus");
		undoToast(body);
		expect(document.activeElement).toBe(
			undoButton(toasts.children[0] as FakeNode),
		);
		vi.advanceTimersByTime(10000);
		expect(toasts.children).toHaveLength(0);
		expect(titleFocus).not.toHaveBeenCalled();
		expect(title.hasAttribute("tabindex")).toBe(false);
		expect(headingFocus).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(heading);
	});
});

// #340: any answer the server gives to a bill's Undo ends its toast (undoDone names the token). The disabled Undo
// drops focus to the body, so the bill's title takes it.
describe("a bill's Undo answer ends its toast", () => {
	const TOKEN = "12.9401.1791234567";
	const billUndoToast = (body: EventTarget) =>
		fire(body, "toast", {
			message: "Payment unlinked. Undo for 10 seconds.",
			undo: TOKEN,
			undoExpiresInMs: 10000,
			undoAction: "/bills/1/undo-unlink",
		});

	it.each([
		["Undo expired. The payment stays unlinked.", "error"],
		["That month already has a payment linked.", "success"],
	])(
		"ends the Undo toast with '%s', and focus goes to the bill's title",
		async (message, type) => {
			const { body, document, toasts, heading } = await page({
				billPage: true,
			});
			const titleFocus = vi.spyOn(heading, "focus");
			billUndoToast(body);
			const undo = toasts.children[0] as FakeNode;
			const form = undo.all().find((node) => node.tag === "form") as FakeNode;
			form.dispatchEvent(new Event("submit"));
			document.activeElement = body;
			fire(body, "toast", { message, type, undoDone: TOKEN });
			expect(toasts.children).not.toContain(undo);
			expect(toasts.children).toHaveLength(1);
			const answer = toasts.children[0] as FakeNode;
			expect(answer.words()).toBe(message);
			expect(answer.attrs.get("role")).toBe(
				type === "error" ? "alert" : "status",
			);
			expect(titleFocus).toHaveBeenCalledTimes(1);
			expect(document.activeElement).toBe(heading);
			expect(heading.attrs.get("tabindex")).toBe("-1");
		},
	);
});

// #444: a cash entry's refused Undo ends its Deleted toast too, as a restore does (undoDone names the token).
// Its focus goes to the Transactions heading, since the disabled Undo had dropped it to the page body.
describe("a cash entry's refused Undo ends its toast", () => {
	const TOKEN = "3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c";
	const cashUndoToast = (body: EventTarget) =>
		fire(body, "toast", {
			message: "Deleted Coffee, $5.00.",
			undo: TOKEN,
			undoExpiresInMs: 10000,
		});

	it.each([
		["Undo expired. The cash entry stays deleted.", "error"],
		["That cash entry is already back.", "success"],
	])(
		"ends the Undo toast with '%s', and focus goes to the Transactions heading",
		async (message, type) => {
			const { body, document, toasts, heading } = await page();
			const headingFocus = vi.spyOn(heading, "focus");
			cashUndoToast(body);
			const undo = toasts.children[0] as FakeNode;
			const form = undo.all().find((node) => node.tag === "form") as FakeNode;
			form.dispatchEvent(new Event("submit"));
			document.activeElement = body;
			fire(body, "toast", { message, type, undoDone: TOKEN });
			expect(toasts.children).not.toContain(undo);
			expect(toasts.children).toHaveLength(1);
			const answer = toasts.children[0] as FakeNode;
			expect(answer.words()).toBe(message);
			expect(answer.attrs.get("role")).toBe(
				type === "error" ? "alert" : "status",
			);
			expect(headingFocus).toHaveBeenCalledTimes(1);
			expect(document.activeElement).toBe(heading);
			expect(heading.attrs.get("tabindex")).toBe("-1");
		},
	);
});

// #444: an Undo whose ten seconds run out before its answer arrives. The disabled Undo had dropped focus to the
// page body, and the timer leaves focus there, so the late answer (or a failed request) moves it to the heading.
describe("an Undo answered after its toast's time ran out (#444)", () => {
	const TOKEN = "3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c";
	const BILL_TOKEN = "12.9401.1791234567";
	const cashUndoToast = (body: EventTarget) =>
		fire(body, "toast", {
			message: "Deleted Coffee, $5.00.",
			undo: TOKEN,
			undoExpiresInMs: 10000,
		});
	const billUndoToast = (body: EventTarget) =>
		fire(body, "toast", {
			message: "Payment unlinked. Undo for 10 seconds.",
			undo: BILL_TOKEN,
			undoExpiresInMs: 10000,
			undoAction: "/bills/1/undo-unlink",
		});
	const undoButton = (form: FakeNode) =>
		form.children.find((node) => node.tag === "button") as FakeNode;
	/** Presses the toast's Undo, then lets its ten seconds run out with no answer: focus is left on the body. */
	function undoTimedOut(
		body: EventTarget,
		document: { activeElement: unknown },
		toasts: FakeNode,
	) {
		const undo = toasts.children[0] as FakeNode;
		const form = undo.all().find((node) => node.tag === "form") as FakeNode;
		form.dispatchEvent(new Event("submit"));
		document.activeElement = body;
		vi.advanceTimersByTime(10000);
		expect(toasts.children).not.toContain(undo);
		return form;
	}

	it.each([
		["Undo expired. The cash entry stays deleted.", "error"],
		["That cash entry is already back.", "success"],
	])(
		"moves focus to the Transactions heading when '%s' answers an Undo whose time ran out",
		async (message, type) => {
			const { body, document, toasts, heading } = await page();
			const headingFocus = vi.spyOn(heading, "focus");
			cashUndoToast(body);
			undoTimedOut(body, document, toasts);
			expect(headingFocus).not.toHaveBeenCalled();
			fire(body, "toast", { message, type, undoDone: TOKEN });
			expect(toasts.children).toHaveLength(1);
			const answer = toasts.children[0] as FakeNode;
			expect(answer.words()).toBe(message);
			expect(answer.attrs.get("role")).toBe(
				type === "error" ? "alert" : "status",
			);
			expect(headingFocus).toHaveBeenCalledTimes(1);
			expect(document.activeElement).toBe(heading);
			expect(heading.attrs.get("tabindex")).toBe("-1");
		},
	);

	it.each([
		["Undo expired. The payment stays unlinked.", "error"],
		["That month already has a payment linked.", "success"],
	])(
		"moves focus to a bill page's title when '%s' answers an Undo whose time ran out",
		async (message, type) => {
			const { body, document, toasts, heading } = await page({
				billPage: true,
			});
			const titleFocus = vi.spyOn(heading, "focus");
			billUndoToast(body);
			undoTimedOut(body, document, toasts);
			expect(titleFocus).not.toHaveBeenCalled();
			fire(body, "toast", { message, type, undoDone: BILL_TOKEN });
			expect(toasts.children).toHaveLength(1);
			const answer = toasts.children[0] as FakeNode;
			expect(answer.words()).toBe(message);
			expect(answer.attrs.get("role")).toBe(
				type === "error" ? "alert" : "status",
			);
			expect(titleFocus).toHaveBeenCalledTimes(1);
			expect(document.activeElement).toBe(heading);
			expect(heading.attrs.get("tabindex")).toBe("-1");
		},
	);

	it("moves focus to the heading when a restore's answer comes after the time ran out", async () => {
		const { body, document, toasts, heading } = await page();
		const headingFocus = vi.spyOn(heading, "focus");
		cashUndoToast(body);
		undoTimedOut(body, document, toasts);
		fire(body, "toast", {
			message: "Restored Coffee.",
			type: "success",
			undoDone: TOKEN,
		});
		expect(toasts.children).toHaveLength(1);
		expect((toasts.children[0] as FakeNode).words()).toBe("Restored Coffee.");
		expect(headingFocus).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(heading);
	});

	it("leaves focus on the restored row when the list shows it and the answer comes after the time ran out", async () => {
		const { body, document, toasts, heading } = await page();
		const headingFocus = vi.spyOn(heading, "focus");
		cashUndoToast(body);
		undoTimedOut(body, document, toasts);
		// The swap's autofocus put focus on the restored row before the answer's toast came.
		const row = new FakeNode("a");
		document.activeElement = row;
		fire(body, "toast", {
			message: "Restored Coffee.",
			type: "success",
			undoDone: TOKEN,
		});
		expect(headingFocus).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(row);
	});

	it("moves focus to the heading when a request with no answer fails after the time ran out", async () => {
		const { body, document, toasts, heading } = await page();
		const headingFocus = vi.spyOn(heading, "focus");
		cashUndoToast(body);
		const form = undoTimedOut(body, document, toasts);
		fire(document, "htmx:error", {
			ctx: { sourceElement: form, request: { method: "POST" } },
			error: new TypeError("Failed to fetch"),
		});
		expect(headingFocus).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(heading);
		expect(undoButton(form).disabled).toBe(true);
		expect(toasts.children).toHaveLength(1);
		const error = toasts.children[0] as FakeNode;
		expect(error.attrs.get("role")).toBe("alert");
		expect(error.words()).toBe(COULDNT_SAVE);
	});

	it("moves focus to the heading when a server error reply comes after the time ran out", async () => {
		const { body, document, toasts, heading } = await page();
		const headingFocus = vi.spyOn(heading, "focus");
		cashUndoToast(body);
		const form = undoTimedOut(body, document, toasts);
		fire(document, "htmx:response:error", {
			ctx: {
				sourceElement: form,
				request: { method: "POST" },
				response: { status: 500 },
			},
		});
		expect(headingFocus).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(heading);
		expect(undoButton(form).disabled).toBe(true);
		expect(toasts.children).toHaveLength(1);
		expect((toasts.children[0] as FakeNode).words()).toBe(COULDNT_SAVE);
	});

	it("leaves focus where the person put it when the late answer comes", async () => {
		const { body, document, toasts, heading } = await page();
		const headingFocus = vi.spyOn(heading, "focus");
		cashUndoToast(body);
		undoTimedOut(body, document, toasts);
		const elsewhere = new FakeNode("input");
		document.activeElement = elsewhere;
		fire(body, "toast", {
			message: "Restored Coffee.",
			type: "success",
			undoDone: TOKEN,
		});
		expect(headingFocus).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(elsewhere);
	});

	it("leaves focus where the person put it when a late failure comes", async () => {
		const { body, document, toasts, heading } = await page();
		const headingFocus = vi.spyOn(heading, "focus");
		cashUndoToast(body);
		const form = undoTimedOut(body, document, toasts);
		const elsewhere = new FakeNode("input");
		document.activeElement = elsewhere;
		fire(document, "htmx:error", {
			ctx: { sourceElement: form, request: { method: "POST" } },
			error: new TypeError("Failed to fetch"),
		});
		expect(headingFocus).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(elsewhere);
	});
});

describe("an Undo request that fails", () => {
	const undoToast = (body: EventTarget) =>
		fire(body, "toast", {
			message: "Deleted Coffee, $5.00.",
			undo: "token",
			undoExpiresInMs: 10000,
		});
	const undoForm = (toasts: FakeNode) =>
		(toasts.children[0] as FakeNode)
			.all()
			.find((node) => node.tag === "form") as FakeNode;
	const undoButton = (form: FakeNode) =>
		form.children.find((node) => node.tag === "button") as FakeNode;

	it("turns Undo back on when its request fails while the toast is still up, and the error toast says to try again", async () => {
		const { body, document, toasts } = await page();
		undoToast(body);
		const form = undoForm(toasts);
		const button = undoButton(form);
		form.dispatchEvent(new Event("submit"));
		expect(button.disabled).toBe(true);
		fire(document, "htmx:error", {
			ctx: { sourceElement: form, request: { method: "POST" } },
			error: new TypeError("Failed to fetch"),
		});
		expect(button.disabled).toBe(false);
		const error = toasts.children.at(-1) as FakeNode;
		expect(error.attrs.get("role")).toBe("alert");
		expect(error.words()).toBe(COULDNT_SAVE);
		expect(toasts.children).toHaveLength(2);
	});

	it("turns Undo back on for a server error reply too", async () => {
		const { body, document, toasts } = await page();
		undoToast(body);
		const form = undoForm(toasts);
		const button = undoButton(form);
		form.dispatchEvent(new Event("submit"));
		fire(document, "htmx:response:error", {
			ctx: {
				sourceElement: form,
				request: { method: "POST" },
				response: { status: 500 },
			},
		});
		expect(button.disabled).toBe(false);
	});

	it("leaves Undo disabled when a different request fails", async () => {
		const { body, document, toasts } = await page();
		undoToast(body);
		const form = undoForm(toasts);
		const button = undoButton(form);
		form.dispatchEvent(new Event("submit"));
		fire(document, "htmx:error", {
			ctx: {
				sourceElement: new FakeNode("form"),
				request: { method: "POST" },
			},
			error: new TypeError("Failed to fetch"),
		});
		expect(button.disabled).toBe(true);
	});

	it("keeps the Undo button off once the Undo toast has gone", async () => {
		const { body, document, toasts } = await page();
		undoToast(body);
		const form = undoForm(toasts);
		const button = undoButton(form);
		form.dispatchEvent(new Event("submit"));
		vi.advanceTimersByTime(10000);
		fire(document, "htmx:error", {
			ctx: { sourceElement: form, request: { method: "POST" } },
			error: new TypeError("Failed to fetch"),
		});
		expect(button.disabled).toBe(true);
	});
});

// #397: a failed Undo gives focus back to its button, unless the person has moved it somewhere else.
describe("focus on an Undo button that a failed request turned back on", () => {
	const undoToast = (body: EventTarget) =>
		fire(body, "toast", {
			message: "Deleted Coffee, $5.00.",
			undo: "token",
			undoExpiresInMs: 10000,
		});
	const undoForm = (toasts: FakeNode) =>
		(toasts.children[0] as FakeNode)
			.all()
			.find((node) => node.tag === "form") as FakeNode;
	const undoButton = (form: FakeNode) =>
		form.children.find((node) => node.tag === "button") as FakeNode;
	const failure = (document: EventTarget, form: FakeNode) =>
		fire(document, "htmx:error", {
			ctx: { sourceElement: form, request: { method: "POST" } },
			error: new TypeError("Failed to fetch"),
		});

	it("moves focus back to Undo when focus had dropped to the page body while the request ran", async () => {
		const { body, document, toasts } = await page();
		undoToast(body);
		const form = undoForm(toasts);
		const button = undoButton(form);
		form.dispatchEvent(new Event("submit"));
		// A disabled button drops focus to the body in browsers.
		document.activeElement = body;
		failure(document, form);
		expect(button.disabled).toBe(false);
		expect(document.activeElement).toBe(button);
	});

	it("leaves focus alone when the person moved it somewhere else during the request", async () => {
		const { body, document, toasts } = await page();
		undoToast(body);
		const form = undoForm(toasts);
		const button = undoButton(form);
		form.dispatchEvent(new Event("submit"));
		const elsewhere = new FakeNode("input");
		document.activeElement = elsewhere;
		failure(document, form);
		expect(button.disabled).toBe(false);
		expect(document.activeElement).toBe(elsewhere);
	});

	it("does not move focus when no Undo button turned back on", async () => {
		const { body, document, toasts } = await page();
		undoToast(body);
		const form = undoForm(toasts);
		form.dispatchEvent(new Event("submit"));
		document.activeElement = body;
		fire(document, "htmx:error", {
			ctx: {
				sourceElement: new FakeNode("form"),
				request: { method: "POST" },
			},
			error: new TypeError("Failed to fetch"),
		});
		expect(document.activeElement).toBe(body);
	});
});

// A switch whose auto-save fails goes back to how the page drew it (#606). Its form opts in with
// data-switches-revert, and toast.js resets it: a browser's reset() puts each control back to its drawn
// (default) state. The stand-in below does the same for checked. Other forms keep what was typed (decision 72).
describe("a switch whose auto-save fails goes back to how the page drew it", () => {
	/** A form holding one switch, drawn On or Off. `revert` is whether the form opts in. */
	const switchForm = ({ revert = true, drawn = true } = {}) => {
		const input = Object.assign(new FakeNode("input"), {
			type: "checkbox",
			name: "enabled",
			checked: drawn,
			defaultChecked: drawn,
		});
		const form = Object.assign(new FakeNode("form"), {
			reset() {
				input.checked = input.defaultChecked;
			},
		});
		if (revert) form.setAttribute("data-switches-revert", "");
		form.append(input);
		return { form, input };
	};
	/** htmx 4's ctx for a switch that was flipped and posted; #handleTriggerEvent sets request.form. */
	const flipped = (input: FakeNode, form: FakeNode, method = "POST") => ({
		sourceElement: input,
		request: { method, form },
	});

	it("puts a switch back to how the page drew it after a 500, and says it couldn't save", async () => {
		const { document, toasts } = await page();
		const { form, input } = switchForm({ drawn: true });
		input.checked = false;
		fire(document, "htmx:response:error", {
			ctx: { ...flipped(input, form), response: { status: 500 } },
		});
		expect(input.checked).toBe(true);
		expect((toasts.children[0] as FakeNode).words()).toBe(COULDNT_SAVE);
	});

	it("puts a switch back to how the page drew it after a dropped connection", async () => {
		const { document } = await page();
		const { form, input } = switchForm({ drawn: false });
		input.checked = true;
		fire(document, "htmx:error", {
			ctx: flipped(input, form),
			error: new TypeError("Failed to fetch"),
		});
		expect(input.checked).toBe(false);
	});

	it("puts a switch back to how the page drew it after a request times out", async () => {
		const { document } = await page();
		const { form, input } = switchForm({ drawn: true });
		const ctx: {
			sourceElement: FakeNode;
			request: { method: string; form: FakeNode; abort: () => void };
		} = {
			sourceElement: input,
			request: {
				method: "POST",
				form,
				abort: vi.fn(() =>
					fire(document, "htmx:error", {
						ctx,
						error: new DOMException("The operation was aborted.", "AbortError"),
					}),
				),
			},
		};
		input.checked = false;
		fire(document, "htmx:before:request", { ctx });
		vi.advanceTimersByTime(60000);
		expect(ctx.request.abort).toHaveBeenCalledTimes(1);
		expect(input.checked).toBe(true);
	});

	it("does not reset a switch whose request was replaced by a newer one, since that flip is the one answered", async () => {
		const { document, toasts } = await page();
		const { form, input } = switchForm({ drawn: true });
		input.checked = false;
		fire(document, "htmx:error", {
			ctx: flipped(input, form),
			error: new DOMException("The operation was aborted.", "AbortError"),
		});
		expect(input.checked).toBe(false);
		expect(toasts.children).toHaveLength(0);
	});

	it("finds the switch's form from the switch when the request carries none", async () => {
		const { document } = await page();
		const { form, input } = switchForm({ drawn: true });
		Object.assign(input, {
			closest: (selector: string) => (selector === "form" ? form : null),
		});
		input.checked = false;
		fire(document, "htmx:response:error", {
			ctx: {
				sourceElement: input,
				request: { method: "POST" },
				response: { status: 500 },
			},
		});
		expect(input.checked).toBe(true);
	});

	it("leaves a form without data-switches-revert alone, so what was typed stays", async () => {
		const { document } = await page();
		const { form, input } = switchForm({ revert: false, drawn: true });
		const reset = vi.spyOn(form, "reset");
		input.checked = false;
		fire(document, "htmx:response:error", {
			ctx: { ...flipped(input, form), response: { status: 500 } },
		});
		expect(reset).not.toHaveBeenCalled();
		expect(input.checked).toBe(false);
	});
});

// #460: a form with an hx-disable guard turns its buttons off while its request runs, and htmx turns them
// back on only after the request's finally event. So a failed request gives focus back to the button that
// was pressed, once it is on again, unless the person has moved focus or the button has left the page.
describe("focus on a guarded button that a failed request turned back on", () => {
	const GUARD = "#suggestions-page button[type=submit]";
	/** A form whose buttons are guarded, and the button pressed in it, disabled while the request runs. */
	const guarded = (guard: string | null = GUARD) => {
		const form = new FakeNode("form");
		if (guard) form.setAttribute("hx-disable", guard);
		const button = new FakeNode("button");
		button.type = "submit";
		button.disabled = true;
		form.append(button);
		return { form, button };
	};
	/** htmx 4's ctx for the request the button sent, failed with a dropped connection or a 500. */
	const dropped = (form: FakeNode, button: FakeNode) => ({
		sourceElement: form,
		request: { method: "POST", submitter: button },
	});
	/** htmx's finally event, which comes before it turns the guarded buttons back on. */
	const finish = (document: EventTarget, ctx: unknown) =>
		fire(document, "htmx:finally:request", { ctx });

	it("gives focus back to the pressed button after a dropped connection", async () => {
		const { body, document } = await page();
		const { form, button } = guarded();
		const ctx = dropped(form, button);
		fire(document, "htmx:error", {
			ctx,
			error: new TypeError("Failed to fetch"),
		});
		// A disabled button drops focus to the body in browsers.
		document.activeElement = body;
		finish(document, ctx);
		button.disabled = false;
		await Promise.resolve();
		expect(document.activeElement).toBe(button);
	});

	it("gives focus back to the pressed button after a 500 reply", async () => {
		const { body, document } = await page();
		const { form, button } = guarded();
		const ctx = {
			...dropped(form, button),
			response: { status: 500 },
		};
		fire(document, "htmx:response:error", { ctx });
		document.activeElement = body;
		finish(document, ctx);
		button.disabled = false;
		await Promise.resolve();
		expect(document.activeElement).toBe(button);
	});

	it("leaves focus alone when the person moved it somewhere else during the request", async () => {
		const { document } = await page();
		const { form, button } = guarded();
		const ctx = dropped(form, button);
		fire(document, "htmx:error", {
			ctx,
			error: new TypeError("Failed to fetch"),
		});
		const elsewhere = new FakeNode("input");
		document.activeElement = elsewhere;
		finish(document, ctx);
		button.disabled = false;
		await Promise.resolve();
		expect(document.activeElement).toBe(elsewhere);
	});

	it("does not focus a button that another request still holds disabled", async () => {
		const { body, document } = await page();
		const { form, button } = guarded();
		const ctx = dropped(form, button);
		fire(document, "htmx:error", {
			ctx,
			error: new TypeError("Failed to fetch"),
		});
		document.activeElement = body;
		finish(document, ctx);
		// htmx leaves it disabled: another request that disabled it has not finished.
		await Promise.resolve();
		expect(button.disabled).toBe(true);
		expect(document.activeElement).toBe(body);
	});

	it("does not focus a button that has left the page", async () => {
		const { body, document } = await page();
		const { form, button } = guarded();
		const ctx = dropped(form, button);
		fire(document, "htmx:error", {
			ctx,
			error: new TypeError("Failed to fetch"),
		});
		document.activeElement = body;
		button.isConnected = false;
		finish(document, ctx);
		button.disabled = false;
		await Promise.resolve();
		expect(document.activeElement).toBe(body);
	});

	it("does not focus a button in a form without an hx-disable guard", async () => {
		const { body, document } = await page();
		const { form, button } = guarded(null);
		const ctx = dropped(form, button);
		fire(document, "htmx:error", {
			ctx,
			error: new TypeError("Failed to fetch"),
		});
		document.activeElement = body;
		finish(document, ctx);
		button.disabled = false;
		await Promise.resolve();
		expect(document.activeElement).toBe(body);
	});

	it("leaves focus alone after a successful request", async () => {
		const { body, document } = await page();
		const { form, button } = guarded();
		const ctx = dropped(form, button);
		document.activeElement = body;
		finish(document, ctx);
		button.disabled = false;
		await Promise.resolve();
		expect(document.activeElement).toBe(body);
	});
});

// #397: a successful Undo's "is back" toast ends the Deleted toast it answers (undoDone names its token),
// and focus leaves that toast on the restored row or the Transactions heading.
describe("the restored entry's toast ends its own Undo toast", () => {
	const undoToast = (body: EventTarget, token: string, message: string) =>
		fire(body, "toast", { message, undo: token, undoExpiresInMs: 10000 });
	const restored = (body: EventTarget, undoDone: string) =>
		fire(body, "toast", {
			message: "Restored Coffee.",
			type: "success",
			undoDone,
		});
	const undoButton = (toast: FakeNode) =>
		toast.all().find((node) => node.tag === "button") as FakeNode;

	it("takes its Deleted toast away as the 'is back' toast appears, and keeps the other Undo toasts", async () => {
		const { body, toasts } = await page();
		undoToast(body, "token-coffee", "Deleted Coffee, $5.00.");
		undoToast(body, "token-tea", "Deleted Tea, $3.00.");
		const [coffee, tea] = toasts.children as [FakeNode, FakeNode];
		restored(body, "token-coffee");
		expect(toasts.children).not.toContain(coffee);
		expect(toasts.children[0]).toBe(tea);
		expect((toasts.children[1] as FakeNode).words()).toBe("Restored Coffee.");
		// The restored entry's toast is a plain one, on its own 4 seconds; the other Undo toast runs its 10.
		vi.advanceTimersByTime(4000);
		expect(toasts.children).toEqual([tea]);
		vi.advanceTimersByTime(6000);
		expect(toasts.children).toEqual([]);
	});

	it("moves focus from its Undo button to the Transactions heading when the entry's row isn't listed", async () => {
		const { body, document, toasts, heading } = await page();
		const focus = vi.spyOn(heading, "focus");
		undoToast(body, "token-coffee", "Deleted Coffee, $5.00.");
		const toast = toasts.children[0] as FakeNode;
		expect(document.activeElement).toBe(undoButton(toast));
		restored(body, "token-coffee");
		expect(toasts.children).not.toContain(toast);
		expect(focus).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(heading);
		expect(heading.attrs.get("tabindex")).toBe("-1");
	});

	it("moves focus to the heading when a disabled Undo had dropped focus to the page body", async () => {
		const { body, document, toasts, heading } = await page();
		undoToast(body, "token-coffee", "Deleted Coffee, $5.00.");
		const toast = toasts.children[0] as FakeNode;
		const form = toast.all().find((node) => node.tag === "form") as FakeNode;
		// The Undo request was posted: its button is off, and focus is on nothing.
		form.dispatchEvent(new Event("submit"));
		document.activeElement = body;
		restored(body, "token-coffee");
		expect(toasts.children).not.toContain(toast);
		expect(document.activeElement).toBe(heading);
	});

	it("leaves focus on the restored row's link when the list shows the row", async () => {
		const { body, document, toasts, heading } = await page();
		const focus = vi.spyOn(heading, "focus");
		undoToast(body, "token-coffee", "Deleted Coffee, $5.00.");
		const toast = toasts.children[0] as FakeNode;
		// The swap ran before this toast arrived, and its autofocus put focus on the row.
		const row = new FakeNode("a");
		document.activeElement = row;
		restored(body, "token-coffee");
		expect(toasts.children).not.toContain(toast);
		expect(document.activeElement).toBe(row);
		expect(focus).not.toHaveBeenCalled();
	});

	it("does not move focus to the heading when the Undo toast's time ends with focus on the page body", async () => {
		const { body, document, heading } = await page();
		const focus = vi.spyOn(heading, "focus");
		undoToast(body, "token-coffee", "Deleted Coffee, $5.00.");
		document.activeElement = body;
		vi.advanceTimersByTime(10000);
		expect(focus).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(body);
	});

	it("still says 'is back' when htmx sends it from document, since the Undo form has left the page", async () => {
		const { body, document, toasts, announcer } = await page();
		undoToast(body, "token-coffee", "Deleted Coffee, $5.00.");
		const deleted = toasts.children[0] as FakeNode;
		// The restore's toast goes first, from the Undo form, and it ends the Deleted toast that holds the form.
		restored(body, "token-coffee");
		expect(toasts.children).not.toContain(deleted);
		// htmx sends the next HX-Trigger key from document once its source element is off the page.
		fire(document, "announce", { value: "Coffee is back." });
		expect(announcer.words()).toBe("Coffee is back.");
	});
});

describe("the announcer and the toasts, however they are sent", () => {
	it("says an announce that plaid-link.js sends from the body, which bubbles up to the document", async () => {
		const { body, announcer } = await page();
		body.dispatchEvent(
			new CustomEvent("announce", {
				bubbles: true,
				detail: { value: "Bank linked." },
			}),
		);
		expect(announcer.words()).toBe("Bank linked.");
	});

	it("says an announce htmx sends from document", async () => {
		const { document, announcer } = await page();
		fire(document, "announce", { value: "Saved." });
		expect(announcer.words()).toBe("Saved.");
	});

	it("shows a toast htmx sends from document", async () => {
		const { document, toasts } = await page();
		fire(document, "toast", { message: "Saved Groceries' budget." });
		expect(toasts.children).toHaveLength(1);
		expect((toasts.children[0] as FakeNode).words()).toBe(
			"Saved Groceries' budget.",
		);
	});
});

describe("Select mode's action bar", () => {
	const SELECTION_BAR = "--selection-bar-height";
	const barAt = (height: number) => {
		const bar = new FakeNode("div");
		bar.offsetHeight = height;
		return bar;
	};

	it("sets the bar's measured height on #toasts, so a bar of two rows is cleared", async () => {
		const { body, toasts } = await page({ bar: barAt(113) });
		fire(body, "toast", { message: "Saved" });
		expect(toasts.style.values.get(SELECTION_BAR)).toBe("113px");
	});

	it("follows the bar when its height changes", async () => {
		const bar = barAt(113);
		const { body, toasts, resizeObservers } = await page({ bar });
		fire(body, "toast", { message: "Saved" });
		bar.offsetHeight = 69;
		const observer = observerOf(resizeObservers, bar);
		observer.callback();
		expect(toasts.style.values.get(SELECTION_BAR)).toBe("69px");
	});

	it("removes the height when there is no bar", async () => {
		const { body, toasts } = await page();
		toasts.style.setProperty(SELECTION_BAR, "113px");
		fire(body, "toast", { message: "Saved" });
		expect(toasts.style.values.has(SELECTION_BAR)).toBe(false);
	});

	it("observes the current bar on each toast, and the callback never calls observe", async () => {
		const bar = barAt(113);
		const { body, resizeObservers } = await page({ bar });
		fire(body, "toast", { message: "Saved" });
		fire(body, "toast", { message: "Saved again" });
		// Two observers: the bar's, and #toasts' (made once, when the script loads; each toast then
		// observes the #toasts on the page).
		expect(resizeObservers).toHaveLength(2);
		const observer = observerOf(resizeObservers, bar);
		// Each toast disconnects, then observes the bar it just found.
		expect(observer.calls.slice(-2)).toEqual([
			["disconnect"],
			["observe", bar],
		]);
		expect(observer.observed).toEqual([bar]);
		const calls = observer.calls.length;
		observer.callback();
		expect(observer.calls).toHaveLength(calls);
	});

	it("still measures the bar in a browser with no ResizeObserver", async () => {
		const { body, toasts } = await page({
			bar: barAt(113),
			resizeObserver: false,
		});
		fire(body, "toast", { message: "Saved" });
		expect(toasts.style.values.get(SELECTION_BAR)).toBe("113px");
	});
});

// A phone sheet leaves room above it for the toasts on screen (app.css's --toast-top-room reads
// --toasts-height from the root element), so an Undo toast and an error toast together are never
// covered by the sheet's heading.
describe("a phone sheet's room follows the toasts on screen", () => {
	const TOASTS_HEIGHT = "--toasts-height";
	const undoToast = (body: EventTarget) =>
		fire(body, "toast", {
			message: "Deleted Coffee, $5.00.",
			undo: "token",
			undoExpiresInMs: 10000,
		});

	it("measures both toasts on screen, the Undo toast first and the error second, on the root element", async () => {
		const { body, document, toasts, documentElement } = await page();
		undoToast(body);
		toasts.offsetHeight = 146;
		fire(document, "htmx:error", dropped("POST"));
		const [undo, error] = toasts.children as FakeNode[];
		expect(toasts.children).toHaveLength(2);
		expect(undo?.className).toMatch(/\bundo-toast\b/);
		expect(error?.words()).toBe(COULDNT_SAVE);
		expect(error?.attrs.get("role")).toBe("alert");
		expect(documentElement.style.values.get(TOASTS_HEIGHT)).toBe("146px");
		expect(toasts.style.values.has(TOASTS_HEIGHT)).toBe(false);
	});

	it("takes the height away once no toast is on screen: the error's 4 seconds, then the Undo toast's 10", async () => {
		const { body, document, toasts, documentElement } = await page();
		undoToast(body);
		toasts.offsetHeight = 146;
		fire(document, "htmx:error", dropped("POST"));
		vi.advanceTimersByTime(4000);
		expect(toasts.children).toHaveLength(1);
		expect(documentElement.style.values.get(TOASTS_HEIGHT)).toBe("146px");
		vi.advanceTimersByTime(6000);
		expect(toasts.children).toHaveLength(0);
		expect(documentElement.style.values.has(TOASTS_HEIGHT)).toBe(false);
	});

	it("follows the toasts when they change height, and the observer's callback never calls observe", async () => {
		const { body, document, toasts, documentElement, resizeObservers } =
			await page();
		undoToast(body);
		toasts.offsetHeight = 146;
		fire(document, "htmx:error", dropped("POST"));
		expect(documentElement.style.values.get(TOASTS_HEIGHT)).toBe("146px");
		// The toasts wrap or the phone turns: the observer on #toasts measures again.
		const observer = observerOf(resizeObservers, toasts);
		toasts.offsetHeight = 78;
		const calls = observer.calls.length;
		observer.callback();
		expect(documentElement.style.values.get(TOASTS_HEIGHT)).toBe("78px");
		expect(observer.calls).toHaveLength(calls);
	});

	it("follows the new #toasts after htmx replaces the body's children", async () => {
		const { body, documentElement, swapBody, resizeObservers } = await page();
		fire(body, "toast", { message: "Saved" });
		const fresh = swapBody();
		fresh.offsetHeight = 66;
		fire(body, "toast", { message: "Saved again" });
		expect(documentElement.style.values.get(TOASTS_HEIGHT)).toBe("66px");
		// The observer now watches the new node, and the old detached one is no longer observed.
		const observer = observerOf(resizeObservers, fresh);
		expect(observer).toBeDefined();
		expect(observer.observed).toEqual([fresh]);
		// Its callback measures the #toasts on the page now, and never calls observe().
		fresh.offsetHeight = 120;
		const calls = observer.calls.length;
		observer.callback();
		expect(documentElement.style.values.get(TOASTS_HEIGHT)).toBe("120px");
		expect(observer.calls).toHaveLength(calls);
	});

	it("still measures the toasts in a browser with no ResizeObserver", async () => {
		const { body, toasts, documentElement } = await page({
			resizeObserver: false,
		});
		toasts.offsetHeight = 66;
		fire(body, "toast", { message: "Saved" });
		expect(documentElement.style.values.get(TOASTS_HEIGHT)).toBe("66px");
	});
});

// #456: Older and Newer in Select mode. The reply's first tick is autofocus, but htmx hides a list load's rows until
// the load ends, so htmx's own focus during the swap does nothing. htmx takes the load's class off the form after its
// htmx:finally:request event, so toast.js focuses the tick on the next frame, once it can take focus.
describe("the first tick after Older or Newer in Select mode (#456)", () => {
	/** A list reply's results, as the reply to Older or Newer draws them: the first row's tick is autofocus. */
	const listReply = () => {
		const results = new FakeNode("section");
		results.id = "results";
		const tick = new FakeNode("input");
		tick.setAttribute("name", "ids");
		tick.setAttribute("autofocus", "");
		const row = new FakeNode("li");
		row.append(tick);
		results.append(row);
		return { results, tick };
	};
	/** Stubs requestAnimationFrame to queue its frames; the returned function runs the queued ones, as the next frame would. */
	const stubFrames = () => {
		const frames: Array<() => void> = [];
		vi.stubGlobal("requestAnimationFrame", (run: () => void) => {
			frames.push(run);
			return frames.length;
		});
		return () => {
			for (const run of frames.splice(0)) run();
		};
	};
	/**
	 * htmx's event once a request has ended: its ctx has the status it ended with, the element it swapped, and the
	 * swap and response htmx gave it. A list htmx swapped in is "innerHTML show:top" (the page links' hx-swap). A 500
	 * is swap "none" (Layout's noSwap), and its status is still "swapped".
	 */
	const requestEnded = (
		document: EventTarget,
		target: FakeNode,
		{
			status = "swapped",
			swap = "innerHTML show:top",
			code = 200,
		}: { status?: string; swap?: string; code?: number } = {},
	) =>
		fire(document, "htmx:finally:request", {
			ctx: { status, target, swap, response: { status: code } },
		});

	it("focuses the first tick on the next frame, after the load's class is off the form", async () => {
		const { document } = await page();
		const runFrames = stubFrames();
		const { results, tick } = listReply();
		requestEnded(document, results);
		// htmx takes the load's class off the form after this event, so the tick is still hidden now.
		expect(document.activeElement).not.toBe(tick);
		runFrames();
		expect(document.activeElement).toBe(tick);
	});

	it("leaves focus where the person put it when a count ends, even with a tick still autofocus", async () => {
		const { document } = await page();
		const { results } = listReply();
		const count = new FakeNode("p");
		count.id = "selected-count";
		const elsewhere = new FakeNode("input");
		document.activeElement = elsewhere;
		requestEnded(document, count);
		expect(document.activeElement).toBe(elsewhere);
		// The tick belongs to the list, which this request did not swap.
		expect(results.querySelector("input[name=ids][autofocus]")).not.toBeNull();
	});

	it("does not move focus when the list request was replaced, cancelled or failed", async () => {
		const { document } = await page();
		const { results } = listReply();
		const elsewhere = new FakeNode("input");
		document.activeElement = elsewhere;
		requestEnded(document, results, { status: "error: AbortError" });
		expect(document.activeElement).toBe(elsewhere);
	});

	it("leaves focus on a filter the person moved to while the list loaded", async () => {
		const { document } = await page();
		const runFrames = stubFrames();
		const { results } = listReply();
		const filter = new FakeNode("select");
		document.activeElement = filter;
		requestEnded(document, results);
		runFrames();
		expect(document.activeElement).toBe(filter);
	});

	it("a failed Older or Newer (500, not swapped) leaves focus on the pressed link", async () => {
		const { document } = await page();
		const runFrames = stubFrames();
		// The page's list is still the previous page's, and it still holds its autofocus tick.
		const { results } = listReply();
		const older = new FakeNode("a");
		document.activeElement = older;
		requestEnded(document, results, { swap: "none", code: 500 });
		runFrames();
		expect(document.activeElement).toBe(older);
	});

	it("a failed Older or Newer does not focus the stale tick when focus is on nothing", async () => {
		const { document } = await page();
		const runFrames = stubFrames();
		const { results, tick } = listReply();
		// Safari leaves focus on the body after a mouse click on a link it doesn't focus.
		document.activeElement = document.body;
		requestEnded(document, results, { swap: "none", code: 500 });
		runFrames();
		expect(document.activeElement).not.toBe(tick);
		expect(document.activeElement).toBe(document.body);
	});
});

// #475: Select all's focus across a count reply. The link and the count's stand-in for it (drawn when no link is) share
// the id select-all-link. htmx restores focus by that id as each task of a swap lands, and the count's own swap lands
// before the link's wrapper does, so a count that draws the link again finds nothing to carry focus and leaves it on the
// body. toast.js moves focus to the Select all control once the swap ends, when the swap began with focus on it.
describe("Select all's focus when a count reply swaps it (#475)", () => {
	const control = (tag: string) => {
		const node = new FakeNode(tag);
		node.id = "select-all-link";
		return node;
	};
	/** The events htmx sends around one swap: before it swaps (focus as it was), then once every task has landed. */
	const swapEvents = (document: EventTarget) => {
		const ctx = { target: new FakeNode("p") };
		return {
			before: () => fire(document, "htmx:before:swap", { ctx, tasks: [] }),
			after: () => fire(document, "htmx:after:swap", { ctx }),
		};
	};

	it("moves focus to the link when a count draws it again while focus was on the count's stand-in", async () => {
		const link = control("a");
		const { document } = await page({ selectAll: link });
		document.activeElement = control("span");
		const swap = swapEvents(document);
		swap.before();
		// The swap's first task removes the stand-in, and htmx has no link yet to put focus on: focus is on the body.
		document.activeElement = document.body;
		swap.after();
		expect(document.activeElement).toBe(link);
	});

	it("moves focus to the control the reply draws when focus was on the link and htmx's restore missed it", async () => {
		const stand = control("span");
		const { document } = await page({ selectAll: stand });
		document.activeElement = control("a");
		const swap = swapEvents(document);
		swap.before();
		document.activeElement = document.body;
		swap.after();
		expect(document.activeElement).toBe(stand);
	});

	it("leaves focus alone when the swap began with focus on the body, as after a mouse click on a checkbox", async () => {
		const link = control("a");
		const { document } = await page({ selectAll: link });
		document.activeElement = document.body;
		const swap = swapEvents(document);
		swap.before();
		swap.after();
		expect(document.activeElement).toBe(document.body);
	});

	it("leaves focus where the person moved it during the reply", async () => {
		const link = control("a");
		const { document } = await page({ selectAll: link });
		document.activeElement = control("span");
		const swap = swapEvents(document);
		swap.before();
		const filter = new FakeNode("select");
		document.activeElement = filter;
		swap.after();
		expect(document.activeElement).toBe(filter);
	});
});

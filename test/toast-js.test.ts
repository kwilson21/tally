import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import toastSource from "../public/js/toast.js?raw";
import appStyles from "../src/styles/app.css?raw";
import { Icon } from "../src/views/icons";

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

class FakeNode extends EventTarget {
	children: FakeNode[] = [];
	parent: FakeNode | null = null;
	attrs = new Map<string, string>();
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
	/** The words a reader would hear: this node's own text and its children's, in order. */
	words(): string {
		return this.textContent;
	}
	/** Whether this node is the given one or holds it, as a real node's contains() does. */
	contains(node: unknown): boolean {
		return node === this || this.children.some((child) => child.contains(node));
	}
	/** Focus is tracked by the page's activeElement; a test spies on this to see it moved. */
	focus() {}
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
	resizeObserver = true,
}: {
	listed?: boolean;
	bar?: FakeNode;
	resizeObserver?: boolean;
} = {}) {
	let toasts = new FakeNode("div");
	const announcer = new FakeNode("div");
	const resultCount = new FakeNode("p");
	const documentElement = new FakeNode("html");
	const body = new EventTarget();
	const document = Object.assign(new EventTarget(), {
		body,
		documentElement,
		activeElement: body as unknown,
		getElementById: (id: string) =>
			id === "toasts"
				? toasts
				: id === "announcer"
					? announcer
					: id === "selection-bar"
						? (bar ?? null)
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
		htmx,
		resultCount,
		bar,
		resizeObservers,
		swapBody,
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
		expect(toast.attrs.get("style")).toBe("--duration-undo-toast: 10000ms");
		expect(toastSource).toContain("undoExpiresInMs");
		expect(toastSource).not.toContain("undo ? 10_000");
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
});

describe("focus when an Undo toast ends", () => {
	const undoToast = (body: EventTarget) =>
		fire(body, "toast", {
			message: "Deleted Coffee, $5.00.",
			undo: "token",
			undoExpiresInMs: 10000,
		});

	it("moves focus to the list's result count when the Undo toast ends with focus on Undo", async () => {
		const { body, document, toasts, resultCount } = await page();
		const focus = vi.spyOn(resultCount, "focus");
		undoToast(body);
		const undo = toasts.children[0] as FakeNode;
		document.activeElement = undo.all().find((n) => n.tag === "button");
		vi.advanceTimersByTime(9999);
		expect(focus).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(toasts.children).toHaveLength(0);
		expect(focus).toHaveBeenCalledTimes(1);
		// A count that isn't focusable yet takes focus only once it says so.
		expect(resultCount.attrs.get("tabindex")).toBe("-1");
	});

	it("leaves focus where it is when the Undo toast ends without focus", async () => {
		const { body, document, resultCount } = await page();
		const focus = vi.spyOn(resultCount, "focus");
		undoToast(body);
		vi.advanceTimersByTime(10000);
		expect(focus).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(body);
	});

	it("does nothing with focus on a page with no list to count", async () => {
		const { body, document, toasts } = await page({ listed: false });
		undoToast(body);
		const undo = toasts.children[0] as FakeNode;
		document.activeElement = undo.all().find((n) => n.tag === "button");
		expect(() => vi.advanceTimersByTime(10000)).not.toThrow();
		expect(toasts.children).toHaveLength(0);
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

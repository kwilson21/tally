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

class FakeNode {
	children: FakeNode[] = [];
	parent: FakeNode | null = null;
	attrs = new Map<string, string>();
	className = "";
	method = "";
	action = "";
	type = "";
	name = "";
	value = "";
	/** A node's own text. */
	own = "";
	constructor(readonly tag: string) {}
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
}

const load = Object.values(import.meta.glob("../public/js/toast.js"))[0] as
	| (() => Promise<unknown>)
	| undefined;

/** Puts a page in place, then runs toast.js against it. */
async function page() {
	const toasts = new FakeNode("div");
	const announcer = new FakeNode("div");
	const body = new EventTarget();
	const document = Object.assign(new EventTarget(), {
		body,
		getElementById: (id: string) =>
			id === "toasts" ? toasts : id === "announcer" ? announcer : null,
		createElement: (tag: string) => new FakeNode(tag),
		createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
		createTextNode: (text: string) =>
			Object.assign(new FakeNode("#text"), { textContent: text }),
	});
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
	vi.resetModules();
	await load?.();
	return { document, body, toasts, htmx };
}

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

	it("shows a load failure and a save failure together, each once", async () => {
		const { document, toasts } = await page();
		for (const method of ["GET", "POST", "GET", "POST"]) {
			fire(document, "htmx:error", dropped(method));
		}
		expect(toasts.children.map((t) => t.words())).toEqual([
			COULDNT_LOAD,
			COULDNT_SAVE,
		]);
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
		fire(body, "toast", { message: "Deleted Coffee, $5.00.", undo: token });
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
		expect(toast.attrs.get("role")).toBe("status");
		expect(htmx.process).toHaveBeenCalledWith(toast);
		expect(appStyles).toContain("--duration-undo-toast: 10s");
		expect(toastSource).toContain('"--duration-undo-toast"');
		expect(toastSource).not.toContain("undo ? 10_000");
	});

	it("keeps an Undo toast through 9,999 ms and removes it at 10,000 ms", async () => {
		const { body, toasts } = await page();
		fire(body, "toast", { message: "Deleted Coffee, $5.00.", undo: "token" });
		const toast = toasts.children[0] as FakeNode;
		expect(toast.attrs.get("role")).toBe("status");
		expect(toast.all().some((node) => node.tag === "form")).toBe(true);
		vi.advanceTimersByTime(9999);
		expect(toasts.children).toContain(toast);
		vi.advanceTimersByTime(1);
		expect(toasts.children).not.toContain(toast);
	});

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

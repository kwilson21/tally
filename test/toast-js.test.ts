import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import toastSource from "../public/js/toast.js?raw";
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

class FakeNode {
	children: FakeNode[] = [];
	parent: FakeNode | null = null;
	attrs = new Map<string, string>();
	className = "";
	textContent = "";
	constructor(readonly tag: string) {}
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
		return (
			this.textContent + this.children.map((child) => child.words()).join("")
		);
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
	vi.stubGlobal("requestAnimationFrame", (run: () => void) => run());
	vi.resetModules();
	await load?.();
	return { document, body, toasts };
}

const fire = (target: EventTarget, name: string, detail: unknown) =>
	target.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));

const status = (code: number) => ({ ctx: { response: { status: code } } });

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
});

describe("the toasts the server sends", () => {
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

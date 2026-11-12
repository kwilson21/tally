import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { present } from "../test/helpers/present";

const source = await readFile(
	new URL("../public/js/feedback-diagnostics.js", import.meta.url),
	"utf8",
);

/** A preview the module stored earlier: its image and when it was taken. */
type StoredPreview = { image: string; at: number };

type ClientOptions = { preview?: boolean; previewValue?: StoredPreview | null };

/** A form field as the module reads it: a text value, or a checkbox state. */
type FieldState = { value?: string; checked?: boolean };

/** The event a handler receives; a window error event carries the thrown error. */
type BrowserEvent = { error?: { name: string } };

type Handler = (event?: BrowserEvent) => void;

/** The part of a created element the module touches: its children, the href it sets, and the methods it calls. */
type ElementStub = {
	tag: string;
	children: ElementStub[];
	href?: string;
	style: { cssText: string };
	setAttribute(): void;
	append(...children: ElementStub[]): void;
	addEventListener(): void;
	remove(): void;
};

/** The feedback form as the module reads it, plus the preview it prepends. */
type FormStub = {
	querySelector(selector: string): FieldState | null | undefined;
	addEventListener(name: string, handler: Handler): void;
	prepend(node: ElementStub): void;
	preview?: ElementStub;
};

function runClient({
	preview = false,
	previewValue = null,
}: ClientOptions = {}) {
	const moduleSource = source
		.replace(/^import[\s\S]*?;\s*/, "")
		.replace(
			"const screenshotEnabled = false;",
			`const screenshotEnabled = ${preview};`,
		);

	const fields = {
		from: { value: "/source" },
		return_to: { value: "/source?adjust=1" },
		client_context: { value: "stale technical details" },
		include_diagnostics: { checked: false },
	} satisfies Record<string, FieldState>;

	const fieldNamed = (name: string): FieldState | undefined =>
		Object.entries(fields).find(([key]) => key === name)?.[1];

	const formHandlers: Record<string, Handler> = {};
	const windowHandlers: Record<string, Handler> = {};

	const form: FormStub = {
		querySelector(selector: string) {
			const name = selector.match(/name="([^"]+)"/)?.[1];

			return name ? fieldNamed(name) : null;
		},
		addEventListener(name: string, handler: Handler) {
			formHandlers[name] = handler;
		},
		prepend(node: ElementStub) {
			this.preview = node;
		},
	};

	function element(tag: string): ElementStub {
		return {
			tag,
			children: [],
			style: { cssText: "" },
			setAttribute() {},
			append(...children: ElementStub[]) {
				this.children.push(...children);
			},
			addEventListener() {},
			remove() {},
		};
	}

	const values = new Map<string, string>();

	if (previewValue)
		values.set("tally-feedback-layout-preview", JSON.stringify(previewValue));

	const document = {
		currentScript: { dataset: { screenshotPreview: String(preview) } },
		addEventListener() {},
		querySelector: () => form,
		createElement: element,
		body: { append() {} },
	};

	const sessionStorage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
	};

	const window = {
		addEventListener(name: string, handler: Handler) {
			windowHandlers[name] = handler;
		},
		html2canvas: async () => ({
			toDataURL: () => "data:image/jpeg;base64,AA==",
		}),
	};

	runInNewContext(moduleSource, {
		document,
		window,
		sessionStorage,
		Date,
		JSON,
		SAFE_COPY: { "nav-home": "Home" },
		safeFeedbackReturnPath: (value: string) =>
			value.startsWith("/") && !value.startsWith("//")
				? value.split("#")[0]
				: "/",
		sanitizeFeedbackRoute: (value: string) => value,
		buildSafeScreenshotTree: () => [{ tagName: "BODY", children: [] }],
	});

	return { fields, form, formHandlers, values, windowHandlers };
}

describe("feedback diagnostics browser behavior", () => {
	it("retains ordinary Error events for the optional error category", () => {
		const f = runClient();
		f.windowHandlers.error?.({ error: { name: "Error" } });
		expect(f.values.get("tally-last-client-error")).toBe(
			JSON.stringify({ name: "Error" }),
		);
	});
	it("does not display a stored preview while the gate is disabled", () => {
		const f = runClient({
			previewValue: { image: "data:image/jpeg;base64,AA==", at: Date.now() },
		});

		expect(f.form.preview).toBeUndefined();
	});
	it("shows a stored preview only when its feature gate is enabled", () => {
		const f = runClient({
			preview: true,
			previewValue: {
				image: "data:image/jpeg;base64,AA==",
				at: Date.now(),
			},
		});

		const preview = present(f.form.preview);

		const retake = preview.children.find((child) => child.tag === "a");
		expect(retake?.href).toBe("/source?adjust=1");
	});

	it("clears stale optional values when a later submission is unchecked", () => {
		const f = runClient();
		f.formHandlers.submit?.();
		expect(f.fields.client_context.value).toBe("");
		expect(f.fields.client_context.value).toBe("");
	});
});

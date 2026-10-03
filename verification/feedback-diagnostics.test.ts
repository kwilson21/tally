import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = await readFile(
	new URL("../public/js/feedback-diagnostics.js", import.meta.url),
	"utf8",
);
const moduleSource = source
	.replace(/^import[\s\S]*?;\s*/, "")
	.replace(
		"const screenshotEnabled = false;",
		"const screenshotEnabled = true;",
	);

function runClient({ preview = false, previewValue = null } = {}) {
	const fields: Record<string, { value?: string; checked?: boolean }> = {
		from: { value: "/source" },
		return_to: { value: "/source?adjust=1" },
		client_context: { value: "stale technical details" },
		include_diagnostics: { checked: false },
	};
	const formHandlers: Record<string, (event?: unknown) => void> = {};
	const form: Record<string, unknown> = {
		querySelector(selector: string) {
			const name = selector.match(/name="([^"]+)"/)?.[1];
			return name ? fields[name] : null;
		},
		addEventListener(name: string, handler: (event?: unknown) => void) {
			formHandlers[name] = handler;
		},
		prepend(node: Record<string, unknown>) {
			this.preview = node;
		},
	};
	function element(tag: string) {
		return {
			tag,
			children: [] as Record<string, unknown>[],
			style: { cssText: "" },
			setAttribute() {},
			append(...children: Record<string, unknown>[]) {
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
		addEventListener() {},
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
	return { fields, form, formHandlers, values };
}

describe("feedback diagnostics browser behavior", () => {
	it("shows a stored preview only when its feature gate is enabled", () => {
		const f = runClient({
			previewValue: {
				image: "data:image/jpeg;base64,AA==",
				at: Date.now(),
			},
		});
		const preview = f.form.preview as {
			children: { tag: string; href?: string }[];
		};
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

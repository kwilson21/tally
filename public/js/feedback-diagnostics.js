import {
	buildSafeScreenshotTree,
	SAFE_COPY,
	safeFeedbackReturnPath,
	sanitizeFeedbackRoute,
} from "./feedback-privacy.js";

(() => {
	const allowedErrors = new Set([
		"AbortError",
		"NetworkError",
		"NotAllowedError",
		"ReferenceError",
		"SecurityError",
		"SyntaxError",
		"TimeoutError",
		"TypeError",
		"UnknownError",
	]);
	const errorKey = "tally-last-client-error";
	const screenshotKey = "tally-feedback-layout-preview";
	// Pixel/OCR acceptance has not run. A markup attribute or Wrangler flag cannot bypass this gate.
	const screenshotEnabled = false;
	let lastError = "";

	function rememberError(name) {
		if (!allowedErrors.has(name)) return;
		try {
			sessionStorage.setItem(errorKey, JSON.stringify({ name }));
		} catch {
			// Optional and local only.
		}
	}
	window.addEventListener("error", (event) =>
		rememberError(event.error?.name ?? ""),
	);
	window.addEventListener("unhandledrejection", (event) =>
		rememberError(event.reason?.name ?? ""),
	);

	function captureInput(node) {
		const attrs = {};
		for (const key of [
			"data-feedback-capture-layout",
			"data-feedback-capture-copy",
			"data-feedback-private",
			"data-private",
		]) {
			if (node.hasAttribute(key)) attrs[key] = node.getAttribute(key) ?? "";
		}
		// Class is inspected only for the block marker and is never serialized.
		attrs.class = typeof node.className === "string" ? node.className : "";
		const input = { tagName: node.tagName, attributes: attrs };
		const copyId = attrs["data-feedback-capture-copy"];
		if (copyId !== undefined) {
			input.textContent = SAFE_COPY[copyId] ?? "";
			input.children = Array.from(node.children, (child) => ({
				tagName: child.tagName,
			}));
		} else if (attrs["data-feedback-capture-layout"] !== undefined) {
			input.children = Array.from(node.children)
				.filter(
					(child) =>
						child.hasAttribute("data-feedback-capture-layout") ||
						child.hasAttribute("data-feedback-capture-copy"),
				)
				.map(captureInput);
		}
		if (
			attrs["data-feedback-capture-copy"] !== undefined ||
			attrs["data-feedback-capture-layout"] !== undefined
		) {
			const style = getComputedStyle(node);
			input.styles = {};
			for (const name of [
				"display",
				"position",
				"color",
				"background-color",
				"font-family",
				"font-size",
				"font-weight",
				"font-style",
				"line-height",
				"text-align",
				"white-space",
				"border-color",
				"border-width",
				"border-style",
				"border-radius",
				"gap",
				"flex-direction",
				"align-items",
				"justify-content",
				"grid-template-columns",
				"padding-top",
				"padding-right",
				"padding-bottom",
				"padding-left",
				"margin-top",
				"margin-right",
				"margin-bottom",
				"margin-left",
			])
				input.styles[name] = style.getPropertyValue(name);
			const rect = node.getBoundingClientRect();
			input.rect = {
				x: rect.x,
				y: rect.y,
				width: rect.width,
				height: rect.height,
			};
		}
		return input;
	}

	async function captureReviewedShell(attempt, generation, interrupted) {
		if (!screenshotEnabled || !window.html2canvas)
			throw new Error("Preview capture is disabled");
		const width = Math.min(innerWidth, 4096);
		const height = Math.min(innerHeight, 4096);
		const safeTree = buildSafeScreenshotTree(captureInput(document.body));
		if (safeTree.length !== 1 || safeTree[0].tagName !== "BODY")
			throw new Error("Safe screenshot root unavailable");
		if (interrupted.value || attempt !== generation.value) return;
		const frame = document.createElement("iframe");
		frame.title = "Sanitized static interface preview";
		frame.setAttribute("aria-hidden", "true");
		frame.setAttribute("sandbox", "allow-same-origin");
		frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;border:0;`;
		document.body.append(frame);
		try {
			const doc = frame.contentDocument;
			if (!doc?.body) throw new Error("Isolated renderer unavailable");
			doc.body.style.cssText = `position:relative;margin:0;overflow:hidden;background:#fff;width:${width}px;height:${height}px;`;
			function render(node, parent) {
				if (node.tagName === "BODY") {
					for (const child of node.children) render(child, parent);
					return;
				}
				const element = doc.createElement(node.tagName.toLowerCase());
				for (const [name, value] of Object.entries(node.styles))
					element.style.setProperty(name, value);
				if (node.rect) {
					element.style.position = "absolute";
					element.style.left = `${node.rect.x}px`;
					element.style.top = `${node.rect.y}px`;
					element.style.width = `${node.rect.width}px`;
					element.style.height = `${node.rect.height}px`;
				}
				if (node.text) element.textContent = node.text;
				parent.append(element);
				for (const child of node.children) render(child, element);
			}
			for (const node of safeTree) render(node, doc.body);
			const canvas = await window.html2canvas(doc.body, {
				width,
				height,
				scale: 1,
				logging: false,
				useCORS: false,
				allowTaint: false,
				backgroundColor: "#fff",
			});
			const image = canvas.toDataURL("image/jpeg", 0.7);
			if (
				!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image) ||
				image.length > 680000
			)
				throw new Error("Unsafe preview image");
			if (interrupted.value || attempt !== generation.value) return;
			sessionStorage.setItem(
				screenshotKey,
				JSON.stringify({ image, at: Date.now() }),
			);
		} finally {
			frame.remove();
		}
	}

	const interrupted = { value: false };
	const generation = { value: 0 };
	window.addEventListener("pagehide", () => {
		interrupted.value = true;
		generation.value++;
	});
	window.addEventListener("pageshow", () => {
		interrupted.value = false;
	});
	// Reference the fail-closed path so lint keeps the reviewed implementation visible.
	void captureReviewedShell;
	if (
		screenshotEnabled &&
		document.currentScript?.dataset.screenshotPreview === "true"
	) {
		// Kept unreachable until synthetic pixel/OCR acceptance is reviewed.
		document.addEventListener("htmx:beforeSwap", () => {
			generation.value++;
		});
	}

	const form = document.querySelector('form[action="/feedback"]');
	if (!form) return;
	try {
		const candidate = JSON.parse(
			sessionStorage.getItem(screenshotKey) ?? "null",
		);
		sessionStorage.removeItem(screenshotKey);
		if (screenshotEnabled && candidate && typeof candidate.image === "string") {
			const preview = document.createElement("fieldset");
			const caption = document.createElement("legend");
			caption.textContent = "Sanitized static interface preview — browser only";
			const image = document.createElement("img");
			image.src = candidate.image;
			image.alt =
				"Approved static Tally interface labels; financial content omitted";
			const remove = document.createElement("button");
			remove.type = "button";
			remove.textContent = "Remove preview";
			remove.addEventListener("click", () => preview.remove());
			preview.append(caption, image, remove);
			const returnTo = safeFeedbackReturnPath(
				form.querySelector('[name="return_to"]')?.value,
			);
			const retake = document.createElement("a");
			retake.href = returnTo;
			retake.textContent = "Retake from original page";
			preview.append(retake);
			form.prepend(preview);
		}
	} catch {
		// An invalid preview is discarded; never fall back to the source DOM.
		sessionStorage.removeItem(screenshotKey);
	}
	try {
		const candidate = JSON.parse(sessionStorage.getItem(errorKey) ?? "null");
		lastError = allowedErrors.has(candidate?.name) ? candidate.name : "";
	} catch {
		lastError = "";
	} finally {
		sessionStorage.removeItem(errorKey);
	}
	const details = form.querySelector('[name="client_context"]');
	const include = form.querySelector('[name="include_diagnostics"]');
	const from = form.querySelector('[name="from"]');
	const deviceCategory = form.querySelector('[name="device_category"]');
	form.addEventListener("submit", () => {
		if (details) details.value = "";
		if (details && include?.checked) {
			details.value = JSON.stringify({
				route: sanitizeFeedbackRoute(from?.value),
				deviceCategory: deviceCategory?.value,
				errorName: lastError,
			});
		}
	});
})();

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

	function rememberError(name) {
		if (!allowedErrors.has(name)) return;
		try {
			sessionStorage.setItem(
				errorKey,
				JSON.stringify({ name, at: Date.now() }),
			);
		} catch {
			// Storage can be unavailable in private browsing; diagnostics remain optional.
		}
	}

	window.addEventListener("error", (event) => {
		rememberError(event.error?.name ?? "");
	});
	window.addEventListener("unhandledrejection", (event) => {
		rememberError(event.reason?.name ?? "");
	});

	const screenshotKey = "tally-feedback-layout-preview";
	const previewEnabled =
		document.currentScript?.dataset.screenshotPreview === "true";

	let capturing = false;
	let interrupted = false;
	window.addEventListener("pagehide", () => {
		interrupted = true;
	});

	window.addEventListener("pageshow", () => {
		interrupted = false;
		capturing = false;
	});

	// Only geometry crosses this boundary. Never clone the application DOM into
	// html2canvas: text, values, CSS, images and attributes may contain finances.
	async function captureLayout() {
		const width = Math.min(innerWidth, 4096);
		const height = Math.min(innerHeight, 4096);
		const boxes = [];
		for (const node of document.body.querySelectorAll("*")) {
			if (boxes.length >= 3000) break;
			const style = getComputedStyle(node);
			if (style.display === "none" || style.visibility === "hidden") continue;
			const rect = node.getBoundingClientRect();
			const left = Math.max(0, rect.left);
			const top = Math.max(0, rect.top);
			const right = Math.min(width, rect.right);
			const bottom = Math.min(height, rect.bottom);
			if (right > left && bottom > top)
				boxes.push({ left, top, width: right - left, height: bottom - top });
		}
		if (!window.html2canvas) {
			await new Promise((resolve, reject) => {
				const script = document.createElement("script");
				script.src = "/vendor/html2canvas.min.js";
				const timer = setTimeout(
					() => reject(new Error("Renderer timeout")),
					10000,
				);
				script.onload = () => {
					clearTimeout(timer);
					resolve();
				};
				script.onerror = () => {
					clearTimeout(timer);
					reject(new Error("Renderer unavailable"));
				};
				document.head.append(script);
			});
		}
		const frame = document.createElement("iframe");
		frame.title = "Redacted layout renderer";
		frame.setAttribute("aria-hidden", "true");
		frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;border:0;`;
		document.body.append(frame);
		try {
			const doc = frame.contentDocument;
			if (!doc) throw new Error("Renderer unavailable");
			doc.body.style.cssText = `margin:0;background:#fff;width:${width}px;height:${height}px;`;
			for (const box of boxes) {
				const block = doc.createElement("div");
				block.style.cssText = `position:absolute;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;box-sizing:border-box;border:1px solid #bbb;background:#eee;`;
				doc.body.append(block);
			}
			let renderTimer;
			const canvas = await Promise.race([
				window.html2canvas(doc.body, {
					width,
					height,
					scale: 1,
					logging: false,
					useCORS: false,
					allowTaint: false,
					backgroundColor: "#fff",
				}),
				new Promise((_, reject) => {
					renderTimer = setTimeout(
						() => reject(new Error("Renderer timeout")),
						10000,
					);
				}),
			]).finally(() => clearTimeout(renderTimer));
			const image = canvas.toDataURL("image/jpeg", 0.7);
			if (image.length > 680000) throw new Error("Preview too large");
			if (interrupted) return;
			sessionStorage.setItem(
				screenshotKey,
				JSON.stringify({ image, at: Date.now() }),
			);
		} finally {
			frame.remove();
		}
	}

	if (previewEnabled) {
		document.addEventListener("click", async (event) => {
			const link = event.target.closest?.(
				'a[href="/feedback"], a[href^="/feedback?"]',
			);
			if (
				!link ||
				event.defaultPrevented ||
				event.button !== 0 ||
				event.metaKey ||
				event.ctrlKey ||
				event.shiftKey ||
				event.altKey
			)
				return;
			event.preventDefault();
			if (capturing) return;
			capturing = true;
			try {
				sessionStorage.removeItem(screenshotKey);
			} catch {
				/* Optional. */
			}
			if (
				window.confirm(
					"Create a redacted layout preview? It hides all text and images, stays in this browser, and is not sent with feedback.",
				)
			) {
				try {
					await captureLayout();
				} catch {
					window.alert(
						"The layout preview could not be created. You can still send feedback.",
					);
				}
			}
			if (!interrupted) window.location.assign(link.href);
			capturing = false;
		});
	}

	const form = document.querySelector('form[action="/feedback"]');
	if (!form) return;
	// Browser-only draft preview. No form field or upload path is created.
	try {
		const candidate = JSON.parse(
			sessionStorage.getItem(screenshotKey) ?? "null",
		);
		sessionStorage.removeItem(screenshotKey);
		if (
			previewEnabled &&
			candidate &&
			Date.now() >= candidate.at &&
			Date.now() - candidate.at <= 600000 &&
			typeof candidate.image === "string" &&
			candidate.image.length <= 680000 &&
			/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(candidate.image)
		) {
			const preview = document.createElement("fieldset");
			const caption = document.createElement("legend");
			caption.textContent = "Redacted layout preview — browser only, not sent";
			const image = document.createElement("img");
			image.src = candidate.image;
			image.alt = "Layout with all content replaced by neutral rectangles";
			image.style.cssText =
				"max-width:100%;max-height:400px;border:1px solid #bbb";
			const remove = document.createElement("button");
			remove.type = "button";
			remove.textContent = "Remove preview";
			remove.addEventListener("click", () => preview.remove());
			preview.append(caption, image, remove);
			const from = form.querySelector('[name="from"]')?.value;
			if (from?.startsWith("/") && !from.startsWith("//")) {
				const retake = document.createElement("a");
				retake.href = from;
				retake.textContent = "Retake from original page";
				preview.append(retake);
			}
			form.prepend(preview);
		}
	} catch {
		/* Storage is optional; feedback remains usable. */
	}
	const details = form.querySelector('[name="client_context"]');
	const include = form.querySelector('[name="include_diagnostics"]');
	const replay = form.querySelector('[name="posthog_session_id"]');
	let lastError = "";
	try {
		const candidate = JSON.parse(sessionStorage.getItem(errorKey) ?? "null");
		if (
			candidate &&
			allowedErrors.has(candidate.name) &&
			Date.now() - candidate.at <= 10 * 60 * 1000 &&
			Date.now() >= candidate.at
		)
			lastError = candidate.name;
		sessionStorage.removeItem(errorKey);
	} catch {
		lastError = "";
	}

	form.addEventListener("submit", () => {
		if (details && include?.checked) {
			details.value = JSON.stringify({
				userAgent: navigator.userAgent,
				viewport: { width: innerWidth, height: innerHeight },
				screen: { width: screen.width, height: screen.height },
				pixelRatio: devicePixelRatio || 1,
				errorName: lastError,
			});
		}
		if (
			replay &&
			include?.checked &&
			typeof window.posthog?.get_session_id === "function"
		) {
			const sessionId = window.posthog.get_session_id();
			if (
				typeof sessionId === "string" &&
				/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
			)
				replay.value = sessionId;
		}
	});
})();

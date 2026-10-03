const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>]+/gi;
const RELATIVE_URL = /(?:^|\s)\/[A-Za-z0-9._~/-]*[?#][^\s<>]*/g;
const CREDENTIAL =
	/\b(?:password|passcode|token|api[-_ ]?key|authorization|authentication|auth|secret)\s*[:=]\s*(?:bearer\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
const PHONE =
	/(?<!\d)(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}(?!\d)/g;
const STREET_ADDRESS =
	/\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){1,5}(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way)\b\.?/gi;
const ACCOUNT_VALUE =
	/\b(?:account|acct|routing|iban|card(?:\s+number)?|account\s+number)\s*(?:no\.?|number|#|:)?\s*(?:(?=[A-Z0-9-]{6,30}\b)(?=[A-Z0-9-]*\d)[A-Z0-9-]{6,30}|(?:\d[ -]?){7,19}\d)\b/gi;
const LONG_NUMBER = /(?<!\d)(?:\d[ -]?){7,19}(?!\d)/g;
const CURRENCY_AMOUNT =
	/(?:[$€£]\s?\d[\d,]*(?:\.\d{2})?|\b\d[\d,]*\.\d{2}\s?(?:USD|EUR|GBP)\b)/gi;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/** Pattern-based only: arbitrary names and sensitive prose cannot be inferred reliably. */
export function sanitizeFeedbackMessage(value) {
	if (typeof value !== "string") return "";
	return value
		.replace(/\r\n?/g, "\n")
		.replace(URL_PATTERN, "[link removed]")
		.replace(RELATIVE_URL, " [link removed]")
		.replace(CREDENTIAL, "[credential removed]")
		.replace(EMAIL, "[email removed]")
		.replace(SSN, "[identifier removed]")
		.replace(PHONE, "[phone removed]")
		.replace(STREET_ADDRESS, "[address removed]")
		.replace(ACCOUNT_VALUE, "[account detail removed]")
		.replace(CURRENCY_AMOUNT, "[amount removed]")
		.replace(LONG_NUMBER, "[number removed]")
		.replace(IPV4, "[address removed]")
		.replace(
			/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})+\b/g,
			"[possible name removed]",
		)
		.slice(0, 2000);
}

const ROUTES = new Set([
	"/",
	"/accounts",
	"/transactions",
	"/bills",
	"/trends",
	"/documents",
	"/settings",
	"/more",
	"/feedback",
	"/how-it-works",
	"/categories",
]);

export function sanitizeFeedbackRoute(value) {
	if (typeof value !== "string") return "/other";
	try {
		const pathname = new URL(value, "https://tally.invalid").pathname;
		if (ROUTES.has(pathname)) return pathname;
		if (/^\/transactions\/[^/]+\/?$/.test(pathname)) return "/transactions";
		if (/^\/accounts\/[^/]+\/?$/.test(pathname)) return "/accounts";
		return "/other";
	} catch {
		return "/other";
	}
}

/** Keep same-origin return navigation, preserving its query while dropping fragments. */
export function safeFeedbackReturnPath(value) {
	if (typeof value !== "string") return "/";
	try {
		const url = new URL(value, "https://tally.invalid");
		if (
			url.origin !== "https://tally.invalid" ||
			!value.startsWith("/") ||
			value.startsWith("//")
		)
			return "/";
		return `${url.pathname}${url.search}`;
	} catch {
		return "/";
	}
}

export function coarseDeviceCategory(userAgent) {
	if (typeof userAgent !== "string") return "Unknown";
	if (/iPad|Tablet/i.test(userAgent)) return "Tablet browser";
	if (/iPhone|Android|Mobile/i.test(userAgent)) return "Mobile browser";
	return "Desktop browser";
}

export const SAFE_COPY = Object.freeze({
	brand: "Tally",
	feedback: "Feedback",
	"nav-home": "Home",
	"nav-transactions": "Transactions",
	"nav-bills": "Bills",
	"nav-trends": "Trends",
	"nav-accounts": "Accounts",
	"nav-documents": "Documents",
	"nav-settings": "Settings",
	"nav-more": "More",
});

const LAYOUT_TAGS = Object.freeze({
	viewport: "BODY",
	"app-frame": "DIV",
	sidebar: "ASIDE",
	"brand-wrap": "DIV",
	"brand-link": "A",
	"brand-text": "SPAN",
	"sidebar-nav": "NAV",
	"sidebar-list": "UL",
	"sidebar-item": "LI",
	"sidebar-link": "A",
	"bottom-nav": "NAV",
	"bottom-list": "UL",
	"bottom-item": "LI",
	"bottom-link": "A",
	"feedback-link": "A",
});

const BLOCKED_TAGS = new Set([
	"INPUT",
	"TEXTAREA",
	"SELECT",
	"OPTION",
	"IMG",
	"SVG",
	"CANVAS",
	"VIDEO",
	"AUDIO",
	"IFRAME",
	"OBJECT",
	"EMBED",
	"PICTURE",
	"SOURCE",
	"SCRIPT",
	"STYLE",
]);
const SAFE_STYLE_PROPERTIES = new Set([
	"display",
	"position",
	"top",
	"right",
	"bottom",
	"left",
	"width",
	"height",
	"margin-top",
	"margin-right",
	"margin-bottom",
	"margin-left",
	"padding-top",
	"padding-right",
	"padding-bottom",
	"padding-left",
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
]);

function safeStyles(styles = {}) {
	const result = {};
	for (const [name, raw] of Object.entries(styles)) {
		if (!SAFE_STYLE_PROPERTIES.has(name) || typeof raw !== "string") continue;
		const value = raw.trim();
		if (
			value.length > 128 ||
			/\b(?:url|var|attr|expression|image-set)\s*\(/i.test(value) ||
			/[;{}<>"'\\]/.test(value) ||
			!/^[\w#.,%()\-\s]+$/.test(value)
		)
			continue;
		result[name] = value;
	}
	return result;
}

function safeRect(rect) {
	if (!rect) return undefined;
	const { x, y, width, height } = rect;
	if (
		![x, y, width, height].every(Number.isFinite) ||
		Math.abs(x) > 8192 ||
		Math.abs(y) > 8192 ||
		width < 0 ||
		height < 0 ||
		width > 8192 ||
		height > 8192
	)
		throw new Error("Unsafe screenshot geometry");
	return {
		x: Math.round(x),
		y: Math.round(y),
		width: Math.round(width),
		height: Math.round(height),
	};
}

function sanitizeCaptureNode(node) {
	const tag = String(node.tagName ?? "").toUpperCase();
	const attrs = node.attributes ?? {};
	const classNames = (attrs.class ?? "").split(/\s+/);
	if (
		BLOCKED_TAGS.has(tag) ||
		"data-feedback-private" in attrs ||
		"data-private" in attrs ||
		classNames.includes("ph-no-capture")
	)
		return null;

	const copyId = attrs["data-feedback-capture-copy"];
	if (copyId !== undefined) {
		const safeText = SAFE_COPY[copyId];
		if (!safeText || !["SPAN", "P", "A"].includes(tag))
			throw new Error("Unknown screenshot copy marker");
		if ((node.children?.length ?? 0) > 0 || node.textContent !== safeText)
			throw new Error("Screenshot static-copy marker does not match source");
		return {
			tagName: tag,
			text: safeText,
			styles: safeStyles(node.styles),
			rect: safeRect(node.rect),
			children: [],
		};
	}

	const layoutId = attrs["data-feedback-capture-layout"];
	if (layoutId === undefined) return null;
	if (LAYOUT_TAGS[layoutId] !== tag)
		throw new Error("Unknown screenshot layout marker");
	return {
		tagName: tag,
		styles: safeStyles(node.styles),
		rect: safeRect(node.rect),
		children: (node.children ?? [])
			.map(sanitizeCaptureNode)
			.filter((child) => child !== null),
	};
}

/** Only reviewed markers survive; dynamic descendants and all non-allowlisted attrs are dropped. */
export function buildSafeScreenshotTree(root) {
	const safe = sanitizeCaptureNode(root);
	return safe ? [safe] : [];
}

const REPLAY_KINDS = new Set(["snapshot", "click", "scroll"]);

/** Projection fixture only; no PostHog SDK or recorder calls this helper. */
export function sanitizeReplayFixture(input) {
	const route = sanitizeFeedbackRoute(input.url);
	const kind =
		typeof input.kind === "string" && REPLAY_KINDS.has(input.kind)
			? input.kind
			: "snapshot";
	const target =
		typeof input.target === "string" && input.target in SAFE_COPY
			? input.target
			: undefined;
	const nodes = (Array.isArray(input.nodes) ? input.nodes : [])
		.map((raw) => {
			if (!raw || typeof raw !== "object") return null;
			const item = raw;
			if (typeof item.copyId !== "string") return null;
			return sanitizeCaptureNode({
				tagName: typeof item.tagName === "string" ? item.tagName : "",
				textContent: typeof item.text === "string" ? item.text : "",
				attributes: { "data-feedback-capture-copy": item.copyId },
			});
		})
		.filter((node) => node !== null);
	return { route, kind, ...(target ? { target } : {}), nodes };
}

export function installFeedbackMessageReview(doc = document) {
	const form = doc.querySelector('form[action="/feedback"]');
	if (!form) return;
	const message = form.querySelector('[name="message"]');
	const category = form.querySelector('[name="device_category"]');
	const categoryMarker = form.querySelector("[data-feedback-device-category]");
	const review = doc.querySelector("#feedback-redaction-review");
	if (category && categoryMarker && typeof navigator !== "undefined")
		category.value = coarseDeviceCategory(navigator.userAgent);
	if (!message || !review) return;
	let reviewed = false;
	message.addEventListener("input", () => {
		reviewed = false;
	});
	form.addEventListener("submit", (event) => {
		const cleaned = sanitizeFeedbackMessage(message.value);
		if (!reviewed || message.value !== cleaned) {
			event.preventDefault();
			message.value = cleaned;
			review.replaceChildren();
			const heading = doc.createElement("strong");
			heading.textContent = "Review the cleaned message before sending";
			const copy = doc.createElement("pre");
			copy.textContent = cleaned || "[No message remains after redaction]";
			review.append(heading, copy);
			review.hidden = false;
			reviewed = true;
			message.focus();
		}
	});
}

if (typeof document !== "undefined") installFeedbackMessageReview(document);

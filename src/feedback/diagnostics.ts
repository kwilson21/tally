import { sanitizeFeedbackRoute } from "./privacy";

const DEVICE_CATEGORIES = new Set([
	"Desktop browser",
	"Mobile browser",
	"Tablet browser",
	"Unknown",
]);
const ERROR_NAMES = new Set([
	"AbortError",
	"Error",
	"NetworkError",
	"NotAllowedError",
	"ReferenceError",
	"SecurityError",
	"SyntaxError",
	"TimeoutError",
	"TypeError",
	"UnknownError",
]);

/** Accept only client-side coarse fields. Raw user agents, dimensions and versions are ignored. */
export function normalizeFeedbackContext(value: unknown, from: string) {
	if (!value || typeof value !== "object") return null;
	const input = value as Record<string, unknown>;
	return {
		route: sanitizeFeedbackRoute(from),
		deviceCategory:
			typeof input.deviceCategory === "string" &&
			DEVICE_CATEGORIES.has(input.deviceCategory)
				? input.deviceCategory
				: "Unknown",
		errorName:
			typeof input.errorName === "string" && ERROR_NAMES.has(input.errorName)
				? input.errorName
				: null,
	};
}

export function diagnosticsEnabled(env: {
	DEMO?: string;
	FEEDBACK_DIAGNOSTICS_ENABLED?: string;
}) {
	return env.DEMO !== "true" && env.FEEDBACK_DIAGNOSTICS_ENABLED === "true";
}

// Pixel/OCR and outbound-envelope acceptance is still blocked; operator flags cannot bypass it.
export function screenshotPreviewEnabled(env: {
	FEEDBACK_SCREENSHOT_PREVIEW_ENABLED?: string;
}) {
	const PIXEL_CANARY_ACCEPTANCE_COMPLETE = false;
	return (
		PIXEL_CANARY_ACCEPTANCE_COMPLETE &&
		env.FEEDBACK_SCREENSHOT_PREVIEW_ENABLED === "true"
	);
}

// There is no PostHog SDK pinned in this project; session IDs and replay links stay off.
export function replayLinksEnabled() {
	return false;
}

export function injectDiagnosticsScript(html: string, enabled: boolean) {
	if (!enabled || !html.includes("</body>")) return html;
	return html.replace(
		"</body>",
		'<script type="module" src="/js/feedback-diagnostics.js"></script></body>',
	);
}

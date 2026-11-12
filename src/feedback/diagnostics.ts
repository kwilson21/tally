import type { Json } from "../json";
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

function isObjectValue(value: Json): value is { [key: string]: Json } {
	return Boolean(value) && typeof value === "object";
}

function isText(value: Json | undefined): value is string {
	return typeof value === "string";
}

/** Accept only client-side coarse fields. Raw user agents, dimensions and versions are ignored. */
export function normalizeFeedbackContext(value: Json, from: string) {
	if (!isObjectValue(value)) return null;
	const input = value;

	return {
		route: sanitizeFeedbackRoute(from),
		deviceCategory:
			isText(input.deviceCategory) &&
			DEVICE_CATEGORIES.has(input.deviceCategory)
				? input.deviceCategory
				: "Unknown",
		errorName:
			isText(input.errorName) && ERROR_NAMES.has(input.errorName)
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

import * as Schema from "effect/Schema";
import { readStoredWith } from "../db/stored-shape";
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

/** True for a parsed JSON object or array (not null), the values the normaliser reads; any other value has no context. */
const isParsedObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null;

/**
 * The client context text, normalised: null when it is not JSON, is null or another non-object, or is refused by
 * normalizeFeedbackContext. The text is read as any JSON value, so a deep or Infinity-holding context reads as it always did;
 * the normaliser's allowlist is the check (a recursive schema threw on deep text).
 */
export function normalizeContextText(text: string, from: string) {
	const value = readStoredWith(Schema.Unknown, text);

	return isParsedObject(value) ? normalizeFeedbackContext(value, from) : null;
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

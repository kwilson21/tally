const ERROR_NAMES = new Set([
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

type Dimensions = { width: number; height: number };

function dimensions(value: unknown): Dimensions | null {
	if (!value || typeof value !== "object") return null;
	const input = value as Record<string, unknown>;
	const width = input.width;
	const height = input.height;
	if (
		typeof width !== "number" ||
		typeof height !== "number" ||
		!Number.isInteger(width) ||
		!Number.isInteger(height) ||
		width < 1 ||
		height < 1 ||
		width > 8192 ||
		height > 8192
	)
		return null;
	return { width, height };
}

function parseBrowser(userAgent: string) {
	const candidates = [
		{ name: "Edge", version: /EdgA?\/([\d.]+)/ },
		{ name: "Chrome", version: /(?:CriOS|Chrome)\/([\d.]+)/ },
		{ name: "Firefox", version: /(?:FxiOS|Firefox)\/([\d.]+)/ },
		{ name: "Safari", version: /Version\/([\d.]+)/ },
	];
	for (const candidate of candidates) {
		const match = candidate.version.exec(userAgent);
		if (match)
			return { browser: candidate.name, browserVersion: match[1] ?? null };
	}
	return { browser: "Unknown", browserVersion: null };
}

function parseOs(userAgent: string) {
	const ios = /(?:iPhone|iPad|iPod).*?OS ([\d_]+)/.exec(userAgent);
	if (ios) return { os: "iOS", osVersion: ios[1]?.replace(/_/g, ".") ?? null };
	const android = /Android ([\d.]+)/.exec(userAgent);
	if (android) return { os: "Android", osVersion: android[1] ?? null };
	return { os: "Unknown", osVersion: null };
}

/** Keep only low-risk, allowlisted context. Never persist raw UA, error message, or stack. */
export function normalizeFeedbackContext(
	value: unknown,
	from: string,
	appVersion?: string,
) {
	if (!value || typeof value !== "object") return null;
	const input = value as Record<string, unknown>;
	const userAgent =
		typeof input.userAgent === "string" ? input.userAgent.slice(0, 512) : "";
	if (!userAgent) return null;
	const viewport = dimensions(input.viewport);
	const screen = dimensions(input.screen);
	const pixelRatio = input.pixelRatio;
	const pixelRatioValue =
		typeof pixelRatio === "number" && Number.isFinite(pixelRatio)
			? Math.max(1, Math.min(4, Math.round(pixelRatio * 100) / 100))
			: null;
	const route = safeRoute(from);
	const errorName =
		typeof input.errorName === "string" && ERROR_NAMES.has(input.errorName)
			? input.errorName
			: null;
	const { browser, browserVersion } = parseBrowser(userAgent);
	const { os, osVersion } = parseOs(userAgent);
	return {
		route,
		browser,
		browserVersion,
		os,
		osVersion,
		viewport,
		screen,
		pixelRatio: pixelRatioValue,
		build:
			typeof appVersion === "string" &&
			/^[a-zA-Z0-9._-]{1,80}$/.test(appVersion)
				? appVersion
				: null,
		error: errorName,
	};
}

function safeRoute(path: string) {
	try {
		return new URL(path, "https://tally.invalid").pathname.slice(0, 160) || "/";
	} catch {
		return "/";
	}
}

export function diagnosticsEnabled(env: {
	DEMO?: string;
	FEEDBACK_DIAGNOSTICS_ENABLED?: string;
}) {
	return env.DEMO !== "true" && env.FEEDBACK_DIAGNOSTICS_ENABLED === "true";
}

export function injectDiagnosticsScript(
	html: string,
	enabled: boolean,
	screenshotPreview = false,
) {
	if (!enabled || !html.includes("</body>")) return html;
	return html.replace(
		"</body>",
		`<script src="/js/feedback-diagnostics.js"${screenshotPreview ? ' data-screenshot-preview="true"' : ""} defer></script></body>`,
	);
}

export function replayLinksEnabled(env: {
	FEEDBACK_REPLAY_LINKS_ENABLED?: string;
	POSTHOG_HOST?: string;
	FEEDBACK_APPROVED_REPLAY_ORIGIN?: string;
}) {
	if (
		env.FEEDBACK_REPLAY_LINKS_ENABLED !== "true" ||
		!env.POSTHOG_HOST ||
		!env.FEEDBACK_APPROVED_REPLAY_ORIGIN
	)
		return false;
	try {
		const host = new URL(env.POSTHOG_HOST);
		return (
			host.protocol === "https:" &&
			!host.username &&
			!host.password &&
			!host.search &&
			!host.hash &&
			host.pathname === "/" &&
			host.origin === env.FEEDBACK_APPROVED_REPLAY_ORIGIN
		);
	} catch {
		return false;
	}
}

export function safeReplayUrl(sessionId: unknown, host: string | undefined) {
	if (
		typeof sessionId !== "string" ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
	)
		return null;
	if (!host) return null;
	try {
		const parsed = new URL(host);
		if (
			parsed.protocol !== "https:" ||
			parsed.username ||
			parsed.password ||
			parsed.search ||
			parsed.hash ||
			parsed.pathname !== "/"
		)
			return null;
		return `${parsed.origin}/replay/${encodeURIComponent(sessionId)}`;
	} catch {
		return null;
	}
}

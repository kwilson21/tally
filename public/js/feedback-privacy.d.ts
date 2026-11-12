export type SafeCaptureNode = {
	tagName: string;
	text?: string;
	styles: Record<string, string>;
	rect?: { x: number; y: number; width: number; height: number };
	children: SafeCaptureNode[];
};

export function sanitizeFeedbackMessage(value: unknown): string;
export function sanitizeFeedbackRoute(value: unknown): string;
export function safeFeedbackReturnPath(value: unknown): string;
export function coarseDeviceCategory(userAgent: unknown): string;
export function installFeedbackMessageReview(doc?: Document): void;

export const SAFE_COPY: Readonly<Record<string, string>>;

export function buildSafeScreenshotTree(root: unknown): SafeCaptureNode[];

/** A parsed JSON value. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export function sanitizeReplayFixture(input: { [key: string]: Json }): {
	route: string;
	kind: "snapshot" | "click" | "scroll";
	target?: string;
	nodes: SafeCaptureNode[];
};

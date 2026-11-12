// The feedback form at the edge (decision 206): the posted fields in, a typed request out. Nothing here can fail: a
// field Tally does not know falls back to its plain value, and whether the message may be sent is for the rule
// (src/rules/feedback.ts).
import * as Schema from "effect/Schema";
import { readAtEdge } from "../edge";
import { normalizeFeedbackContext } from "./diagnostics";
import { sanitizeFeedbackMessage, sanitizeFeedbackRoute } from "./privacy";

export const FEEDBACK_TYPES = ["Bug", "Idea", "Question", "Other"] as const;

export const FEEDBACK_FEELINGS = [
	"Frustrated",
	"Confused",
	"Okay",
	"Happy",
	"Delighted",
] as const;

const DEVICES = [
	"Mobile browser",
	"Tablet browser",
	"Desktop browser",
	"Unknown",
] as const;

/** One of a fixed list of words, or the word to fall back on for anything else. */
const oneOf = <const Words extends readonly [string, ...string[]]>(
	words: Words,
	text: string,
	otherwise: Words[number],
): Words[number] => {
	const read = readAtEdge(Schema.Literals(words), text);

	return read.ok ? read.value : otherwise;
};

/** A path on this site, or "/" for anything else. `navigation` keeps the query, for the page to go back to. */
export function safePath(value: string | null, navigation = false) {
	try {
		const url = new URL(value ?? "/", "http://tally.invalid");
		const normalized = url.pathname;

		return url.origin === "http://tally.invalid" &&
			(normalized === "/" || /^\/[^/\\]/.test(normalized))
			? navigation
				? `${normalized}${url.search}`
				: normalized.slice(0, 160)
			: "/";
	} catch {
		return "/";
	}
}

/** The opted-in technical context, kept to its allowlisted fields, or null for anything that is not a JSON object. */
function contextOf(text: string, from: string) {
	try {
		return normalizeFeedbackContext(JSON.parse(text), from);
	} catch {
		return null;
	}
}

/** What the feedback form sent, typed. `message` is cleaned of private details; `typedLength` is of what was typed. */
export function readFeedbackForm(form: FormData) {
	const field = (name: string) => form.get(name);
	const text = (name: string) => String(field(name) ?? "");
	const typed = text("message").replace(/\r\n/g, "\n");
	const message = sanitizeFeedbackMessage(typed).trim();
	const from = sanitizeFeedbackRoute(String(field("from") ?? "/"));

	return {
		type: oneOf(FEEDBACK_TYPES, text("type"), "Other"),
		feeling: oneOf(FEEDBACK_FEELINGS, text("feeling"), "Okay"),
		message,
		typedLength: typed.trim() === "" ? 0 : typed.length,
		// The person saw this cleaned text and ticked the box under it.
		reviewed:
			text("message_reviewed") === message && field("confirm_review") === "yes",
		from,
		returnTo: safePath(
			String(field("return_to") ?? field("from") ?? "/"),
			true,
		),
		device: oneOf(DEVICES, String(field("device_category")), "Unknown"),
		clientContext:
			field("include_diagnostics") === "yes"
				? contextOf(text("client_context"), from)
				: null,
	};
}

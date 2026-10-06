// The only place Tally talks to Workers AI (CLAUDE.md, spec §7): it suggests up to three plain names for
// a merchant from the bank's text, and decides nothing. Code checks every name it gets back
// (`cleanSuggestedNames`), a person chooses one or none, and nothing is renamed until they do.
import { MAX_SUGGESTED_NAMES } from "../transactions/name-suggestions";
import { tidyName } from "../transactions/tidy-name";

/**
 * The model that tidies a bank's text. A small, cheap text model is enough for one short line, and it
 * is asked for plain lines rather than JSON so any text model works if this one changes. Spec §10
 * item 8 still asks for it to be checked against the current Workers AI catalog and pricing.
 */
export const NAME_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8" as const;

const TIMEOUT_MS = 15_000;
const MIN_LENGTH = 2;
const MAX_LENGTH = 40;
const MAX_WORDS = 5;

const INSTRUCTIONS = [
	"You turn the text a bank prints for a purchase into the plain name a person would call the place.",
	`Reply with up to ${MAX_SUGGESTED_NAMES} different names, one per line, best first, and nothing else.`,
	"Use normal spelling and capitals. Leave out store numbers, codes, cities, amounts and dates.",
	"If you are not sure, reply with fewer names. Never explain.",
].join(" ");

export type SuggestResult =
	| { ok: true; names: string[] }
	/** The call failed (or answered with nothing to read), so the merchant is asked about again later. */
	| { ok: false };

/**
 * Asks Workers AI for names for one bank text. Only that text is sent: no amount, date, account or
 * note. A failure is logged by the error's name alone, never the text or the model's words.
 */
export async function suggestNames(
	ai: Ai,
	rawName: string,
): Promise<SuggestResult> {
	let answer: unknown;
	try {
		answer = await ai.run(
			NAME_MODEL,
			{
				messages: [
					{ role: "system", content: INSTRUCTIONS },
					{ role: "user", content: `Bank text: ${rawName}` },
				],
				max_tokens: 60,
				temperature: 0.2,
			},
			{ signal: AbortSignal.timeout(TIMEOUT_MS) },
		);
	} catch (error) {
		console.error(
			`workers-ai: ${error instanceof Error ? error.name : "failed"}`,
		);
		return { ok: false };
	}
	const text =
		typeof answer === "string"
			? answer
			: (answer as { response?: unknown } | null)?.response;
	if (typeof text !== "string") return { ok: false };
	return { ok: true, names: cleanSuggestedNames(text, rawName) };
}

export function cleanCategoryName(
	answer: unknown,
	avoid: string[],
): string | null {
	if (typeof answer !== "string") return null;
	for (const raw of answer.split(/\r?\n/)) {
		const name = raw
			.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, "")
			.trim()
			.replace(/[.]+$/, "")
			.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
			.replace(/\s+/g, " ");
		if (
			name.length < 2 ||
			name.length > 30 ||
			name.split(" ").length > 3 ||
			/[$#*<>:]|\d{3,}|\d+[.,]\d{2}\b|https?:|www\./i.test(name)
		)
			continue;
		if (
			!/^[\p{L}][\p{L} &'-]*$/u.test(name) ||
			/\b(?:here is|category|suggest|because|would be)\b/i.test(name)
		)
			continue;
		if (
			/^(?:none(?: of these fit)?|nothing|n\/?a)\.?$/i.test(name) ||
			avoid.some((n) => n.toLowerCase() === name.toLowerCase())
		)
			continue;
		if (name === name.toUpperCase() || name === name.toLowerCase())
			return name
				.toLowerCase()
				.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
		return name;
	}
	return null;
}

export async function suggestCategoryName(
	ai: Ai,
	merchants: string[],
	avoid: string[],
): Promise<{ ok: true; name: string | null } | { ok: false }> {
	try {
		const answer = await ai.run(
			NAME_MODEL,
			{
				messages: [
					{
						role: "system",
						content:
							"Suggest one short, plain category name for this group of purchases. Reply with only the name.",
					},
					{
						role: "user",
						content: `Places: ${merchants.join("; ")}\nCategories to avoid: ${avoid.join("; ")}`,
					},
				],
				max_tokens: 40,
				temperature: 0.2,
			},
			{ signal: AbortSignal.timeout(TIMEOUT_MS) },
		);
		const text =
			typeof answer === "string"
				? answer
				: (answer as { response?: unknown } | null)?.response;
		if (typeof text !== "string") return { ok: false };
		return { ok: true, name: cleanCategoryName(text, avoid) };
	} catch (error) {
		console.error(
			`workers-ai: category name ${error instanceof Error ? error.name : "failed"}`,
		);
		return { ok: false };
	}
}

/** Marks a model puts before a list item ("1.", "-", "•") and quotes it wraps a name in. */
const LIST_MARK = /^\s*(?:[-•·]|\*(?=\s)|\d+[.)])\s*/;
const QUOTES = /^["'“”‘’`]+|["'“”‘’`]+$/g;

/**
 * True when `name` says nothing the bank's tidied text doesn't: the same words, whatever the capitals. A
 * guess like "Blue Bottle Cof" beside the tidied "Blue bottle cof" would only be a second, odd-looking
 * copy of what the list already shows.
 */
const sameAsTidied = (name: string, tidied: string) =>
	name.toLowerCase() === tidied.toLowerCase();

/**
 * The names worth offering from a model's answer (spec §7): one per line, trimmed, with list marks and
 * quotes taken off, 2 to 40 characters and at most five words, with no amount, store number, code,
 * link or markup in them, and none that only repeats the bank's text or its tidied form, in any capitals. Repeats
 * (ignoring capitals) are dropped and at most three are kept, in the order given. Anything that
 * isn't text gives none.
 */
export function cleanSuggestedNames(
	answer: unknown,
	rawName: string,
): string[] {
	if (typeof answer !== "string") return [];
	const raw = rawName.trim().toLowerCase();
	const tidied = tidyName(rawName);
	const names: string[] = [];
	for (const line of answer.split(/\r?\n/)) {
		const name = line
			.replace(LIST_MARK, "")
			.trim()
			.replace(QUOTES, "")
			.replace(/[.]+$/, "")
			.replace(/\s+/g, " ")
			.trim();
		if (name.length < MIN_LENGTH || name.length > MAX_LENGTH) continue;
		if (name.split(" ").length > MAX_WORDS) continue;
		// An amount, a store number or a code, a link, markup, or a sentence.
		if (/[$#*<>:]|\d{3,}|\d+[.,]\d{2}\b|https?:|www\./i.test(name)) continue;
		if (name.toLowerCase() === raw || sameAsTidied(name, tidied)) continue;
		if (names.some((kept) => kept.toLowerCase() === name.toLowerCase()))
			continue;
		names.push(name);
		if (names.length === MAX_SUGGESTED_NAMES) break;
	}
	return names;
}

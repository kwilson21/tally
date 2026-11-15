// What each held stored-JSON case answers, as one string: the site's reader run on the case, JSON-encoded so a -0 or a
// non-finite number is kept apart from 0 and a string. A reader that throws answers its error's class and nothing else,
// since a message can hold stored data. An answer longer than 300 characters is its length and a 32-bit FNV-1a digest, so
// the baseline stays small. Shared by the characterise test and the baseline recorder (#1120).

import type { Json } from "../src/json";
import { type LookupTextFacts, lookupFactsOf } from "../src/lookup/texts";
import { accountsOf } from "../src/reconnect/reminders";
import { snapshotOf } from "../src/transactions/cash-undo";
import type { HeldCase } from "./held-json-corpus";

const isNumberValue = (value: Json): value is number =>
	typeof value === "number";

const isContainer = (value: Json): value is Json[] | { [key: string]: Json } =>
	typeof value === "object" && value !== null;

/** Numbers JSON cannot tell apart from 0, or from a string, are written as a tagged string. */
const replacer = (_key: string, value: Json) =>
	isNumberValue(value) && (Object.is(value, -0) || !Number.isFinite(value))
		? { "#number": Object.is(value, -0) ? "-0" : String(value) }
		: value;

/** A 32-bit FNV-1a hash of the text, as hex. */
function digest(text: string): string {
	let hash = 0x811c9dc5;

	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}

	return hash.toString(16).padStart(8, "0");
}

/** The deepest nesting of arrays and objects in a value, counted without recursion. */
function depthOf(value: Json): number {
	let deepest = 0;
	const pending: [Json, number][] = [[value, 0]];

	for (let item = pending.pop(); item; item = pending.pop()) {
		const [node, depth] = item;

		if (!isContainer(node)) continue;

		deepest = Math.max(deepest, depth + 1);

		for (const child of Object.values(node)) pending.push([child, depth + 1]);
	}

	return deepest;
}

/**
 * A value as the text the baseline holds it. A value too deep for JSON.stringify is its depth: the reader gave it, and the
 * encoder cannot write it out.
 */
export function encodeAnswer(value: Json): string {
	let text: string;

	try {
		text = JSON.stringify(value, replacer) ?? "undefined";
	} catch (error) {
		if (error instanceof RangeError) return `deep ${depthOf(value)}`;

		throw error;
	}

	return text.length <= 300 ? text : `long ${text.length} ${digest(text)}`;
}

/** What the three readers return. */
type Answer =
	| LookupTextFacts
	| ReturnType<typeof accountsOf>
	| ReturnType<typeof snapshotOf>;

/** The reader's answer for one case: the value it returns, or the class of the error it throws. */
function run(c: HeldCase): Answer {
	switch (c.site) {
		case "texts":
			return lookupFactsOf({
				rawTexts: c.rawTexts,
				categories: c.categories,
				flagged: 0,
				maybe: 0,
				transfer: 0,
				excluded: 0,
			});
		case "reminders":
			return accountsOf(c.accounts);
		case "cash":
			return snapshotOf(c.texts);
	}
}

/** The answer for one case, as the text the baseline holds. */
export function answerOf(c: HeldCase): string {
	try {
		return encodeAnswer(run(c));
	} catch (error) {
		return `throws ${error instanceof Error ? error.name : "non-error"}`;
	}
}

// What each first-week record case answers, as one string: parseFirstTally run on the text, JSON-encoded so a -0 is kept
// apart from 0 and so an own key named __proto__ is shown, then whether the record's parts still have the ordinary
// prototype. A text it throws on answers the error's class and its fixed sentence. Shared by the characterise test and the
// baseline recorder (#1181).

import { parseFirstTally } from "../src/db/first-tally";
import type { Json } from "../src/json";
import type { FirstTallyStoredCase } from "./first-tally-stored-corpus";

/** A -0 is written as text, since JSON.stringify writes it as 0. */
const replacer = (_key: string, value: Json) =>
	Object.is(value, -0) ? "-0" : value;

async function digest(text: string) {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);

	return Array.from(new Uint8Array(bytes).slice(0, 6), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export async function answerOf(item: FirstTallyStoredCase): Promise<string> {
	let text: string;
	let clean = "";
	let keys = "";

	try {
		const record = parseFirstTally(item.text);

		text = JSON.stringify(record, replacer) ?? "undefined";

		// The record's own keys in order, so a part set to undefined shows apart from a part left out.
		keys = Object.keys(record).join(",");

		clean = [
			record,
			record.strokes,
			record.budgets,
			record.pay,
			record.readyPushedAt,
			record.readyClaimedAt,
			record.heldReadyEmail,
		]
			.map((part) =>
				part === undefined
					? "-"
					: Object.getPrototypeOf(part) === Object.prototype
						? "o"
						: "x",
			)
			.join("");
	} catch (thrown) {
		text =
			thrown instanceof Error
				? `throws ${thrown.name}: ${thrown.message}`
				: "throws non-error";
	}

	const shown =
		text.length <= 300 ? text : `long ${text.length} ${await digest(text)}`;

	return `${shown} | keys ${keys} | prototypes ${clean}`;
}

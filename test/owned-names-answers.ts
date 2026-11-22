// What each owned-names case answers, as one string: ownedNamesOf run on the text, JSON-encoded with a missing value shown as
// the word undefined, or the class of what it throws (a message can hold the stored text, so it is not part of the answer).
// Shared by the characterise test and the baseline recorder (#1180).

import { ownedNamesOf } from "../src/db/transactions";
import type { OwnedNamesCase } from "./owned-names-corpus";

async function digest(text: string) {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);

	return Array.from(new Uint8Array(bytes).slice(0, 6), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export async function answerOf(item: OwnedNamesCase): Promise<string> {
	let text: string;

	try {
		const rows = ownedNamesOf(item.text);

		text = JSON.stringify(rows, (_key, value) =>
			value === undefined ? "undefined" : value,
		);
	} catch (thrown) {
		text = `throws ${thrown instanceof Error ? thrown.name : "non-error"}`;
	}

	return text.length <= 300
		? text
		: `long ${text.length} ${await digest(text)}`;
}

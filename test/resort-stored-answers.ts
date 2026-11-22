// What each stored re-sort record case answers, as one string: the real readRun or readMoved run on the stored text, JSON-
// encoded so a -0 is kept apart from 0, and whether the fixed line for an unusable record was logged. A record the read
// cannot use answers null. Shared by the characterise test and the baseline recorder (#1150).

import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { movedKey, RUN_KEY, readMoved, readRun } from "../src/db/resort-run";
import type { Json } from "../src/json";
import type { ResortStoredCase } from "./resort-stored-corpus";

const RUN_ID = "run-1";

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

export async function answerOf(item: ResortStoredCase): Promise<string> {
	await env.DB.prepare(
		"DELETE FROM household_settings WHERE key = ? OR key = ?",
	)
		.bind(RUN_KEY, movedKey(RUN_ID))
		.run();

	await env.DB.prepare(
		"INSERT INTO household_settings (key, value) VALUES (?, ?)",
	)
		.bind(item.site === "run" ? RUN_KEY : movedKey(RUN_ID), item.text)
		.run();

	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	let text: string;

	try {
		const read =
			item.site === "run"
				? await readRun(env.DB)
				: await readMoved(env.DB, RUN_ID);

		text = JSON.stringify(read, replacer) ?? "undefined";
	} catch (thrown) {
		text = `throws ${thrown instanceof Error ? thrown.name : "non-error"}`;
	}

	const logged = error.mock.calls.length;
	error.mockRestore();

	const shown =
		text.length <= 300 ? text : `long ${text.length} ${await digest(text)}`;

	return `${shown} | logged ${logged}`;
}

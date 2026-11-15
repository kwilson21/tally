import { afterEach, describe, expect, it, vi } from "vitest";
import { cases, runCase } from "./category-id-corpus";
import baseline from "./fixtures/category-id-baseline.json";

// Every route that reads a category id with CategoryId (#1111). Each case below posts or gets one input a browser can
// send and records what comes back. The lines in fixtures/category-id-baseline.json were recorded on the code before the
// change. The one intended difference: a category id written with a leading zero, a sign, a space, a decimal point, an
// exponent or hex, or with 16+ digits, is now refused as any non-id is. Such a row must equal that route's answer for a
// refused id (the "words" row for a query or a form; the "missing-row" row for an address that reaches the handler, and
// nothing written). Every other row must stay as it was recorded.

const recorded: Record<string, string> = baseline;

/** The value names that CategoryId now refuses but Number accepted (a space is still trimmed on the suggestion routes). */
const REFUSED_NOW = [
	"zero-led",
	"space",
	"plus",
	"point-zero",
	"exponent",
	"hex",
	"sixteen",
	"big",
];

/** The address values that reach the route's handler (their pattern is digits only), so their answer is the handler's. */
const DIGITS_ONLY = ["zero-led", "sixteen", "big"];

/** A recorded line; every label a case or a reference names is recorded, so a missing one is a broken corpus. */
function recordedLine(label: string): string {
	const line = recorded[label];

	if (line === undefined) throw new Error(`no recorded line for ${label}`);

	return line;
}

/** The line a case must now give: its recorded line, or the refused id's line for the same route when the value is refused now. */
function expectedLine(label: string): string {
	const name = label.match(/(?:category|open|focus|id)=([a-z-]+)/)?.[1];

	if (name === undefined || !REFUSED_NOW.includes(name))
		return recordedLine(label);

	// The suggestion routes trim the category before they read it, so a space is still an id there.
	if (label.startsWith("suggestion") && name === "space")
		return recordedLine(label);

	// An address that the route's pattern does not match is answered by the router, as it always was.
	if (label.includes(` id=${name}`)) {
		if (!DIGITS_ONLY.includes(name)) return recordedLine(label);

		return recordedLine(label.replace(`id=${name}`, "id=missing-row"));
	}

	return recordedLine(label.replace(`=${name}`, "=words"));
}

afterEach(() => {
	vi.useRealTimers();
});

describe("the routes that read a category id (#1111)", () => {
	it("answers every recorded case the same as before, but a refused id as a refused id", async () => {
		const problems: string[] = [];

		for (const req of await cases()) {
			const line = await runCase(req);
			const want = expectedLine(req.label);

			console.log(`@@CORPUS@@ ${JSON.stringify([req.label, line])}`);

			if (want !== line)
				problems.push(`${req.label}\n  want ${want}\n  got  ${line}`);
		}

		expect(problems).toEqual([]);
	}, 1_800_000);
});

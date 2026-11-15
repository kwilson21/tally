import { describe, expect, it } from "vitest";
import baseline from "./fixtures/held-json-baseline.json";
import { answerOf } from "./held-json-answers";
import { cases } from "./held-json-corpus";

// Every case in held-json-corpus.ts, run through the reader it names. fixtures/held-json-baseline.json holds each answer,
// recorded on the code before the lookup texts, the reminders' accounts and the cash delete hold moved to Effect Schema
// (#1120). A conversion must not move any answer: the same values, the same thrown classes and the same deep values.

const recorded: Record<string, string> = baseline;

// The answers the conversions moved on purpose (decision 233). Each is named here and nowhere else; every other case keeps
// its recorded answer. A list the Schema refuses now throws a fixed Error, as a list of the wrong shape (lookupFactsOf).
const TEXTS_REFUSED_IN_RAW = [
	"10k element array",
	"2MB string",
	"Infinity element",
	"JSON null",
	"JSON number",
	"JSON string",
	"JSON true",
	"__proto__ key",
	"array of null",
	"array of number",
	"array of object",
	"depth 1000 array",
	"depth 200 array",
	"depth 2000 array",
	"depth 2000 object",
	"depth 5000 array",
	"duplicate keys",
	"empty object",
	"minus Infinity element",
	"nested array",
	"string and null",
];

const TEXTS_REFUSED_IN_CATEGORIES = [
	"10k element array",
	"2MB string",
	"Infinity element",
	"JSON null",
	"JSON number",
	"JSON string",
	"JSON true",
	"__proto__ key",
	"array of number",
	"array of object",
	"depth 1000 array",
	"depth 200 array",
	"depth 2000 array",
	"depth 2000 object",
	"depth 5000 array",
	"duplicate keys",
	"empty object",
	"minus Infinity element",
	"nested array",
];

// A bank's stored accounts the Schema refuses answer null (accountsOf), and the run skips that bank before its claim. The
// last three are shapes SQL cannot write (json_object always writes the mask key, and name and mask are TEXT columns), so
// the Schema refuses what the renderer used to draw without error; they are named here, not left to chance.
const REMINDERS_REFUSED = [
	"10k element array",
	"2MB string",
	"BOM before JSON",
	"Infinity element",
	"JSON number",
	"JSON string",
	"JSON true",
	"__proto__ key",
	"array of null",
	"array of number",
	"array of object",
	"depth 1000 array",
	"depth 200 array",
	"depth 2000 array",
	"depth 2000 object",
	"depth 5000 array",
	"duplicate keys",
	"empty object",
	"good then number",
	"lone surrogate",
	"minus Infinity element",
	"missing mask key",
	"name missing",
	"nested array",
	"not JSON",
	"numeric mask",
	"numeric name",
	"object not array",
	"string and null",
	"truncated",
];

/** The answer the code gives now for a case: the recorded one, unless the conversion moved it on purpose. */
function expectedAnswer(label: string): string {
	const [site = "", ...rest] = label.split(" | ");
	const name = rest.at(-1) ?? "";
	const column = rest.length === 2 ? (rest[0] ?? "") : "";

	if (
		site === "texts" &&
		column === "rawTexts" &&
		TEXTS_REFUSED_IN_RAW.includes(name)
	)
		return "throws Error";

	if (
		site === "texts" &&
		column === "categories" &&
		TEXTS_REFUSED_IN_CATEGORIES.includes(name)
	)
		return "throws Error";

	if (site === "reminders" && REMINDERS_REFUSED.includes(name)) return "null";

	return recorded[label] ?? "";
}

describe("the held stored JSON reads answer as they did before (#1120)", () => {
	it("gives every corpus case the answer recorded for it", () => {
		const list = cases();
		const labels = list.map((item) => item.label);

		expect(new Set(labels).size).toBe(labels.length);
		expect(Object.keys(recorded).sort()).toEqual([...labels].sort());

		const problems: string[] = [];

		for (const item of list) {
			const got = answerOf(item);
			const want = expectedAnswer(item.label);

			if (got !== want)
				problems.push(`${item.label}\n  want ${want}\n  got  ${got}`);
		}

		expect(problems).toEqual([]);
	});
});

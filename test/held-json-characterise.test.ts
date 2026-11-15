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

/** The answer the code gives now for a case: the recorded one, unless the conversion moved it on purpose. */
function expectedAnswer(label: string): string {
	const [site = "", column = "", name = ""] = label.split(" | ");

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

import { describe, expect, it } from "vitest";
import baseline from "./fixtures/owned-names-baseline.json";
import { answerOf } from "./owned-names-answers";
import { ownedNamesCases } from "./owned-names-corpus";

// Every case in owned-names-corpus.ts, read by ownedNamesOf. fixtures/owned-names-baseline.json holds each answer, recorded on
// the code before the read moved from a cast to Effect Schema (#1180). The SQL always writes a list of {name, date, part}
// rows, so the cases here are texts it never writes; the move may refuse some of them, and each one it moves is named below.

const recorded: Record<string, string> = baseline;

// What the move moves on purpose (#1180), named here and nowhere else. The SQL always writes a list of {name, date, part} rows,
// so each case below is a text it never writes: a list that is not a list, an element that is not a row, or a row whose name,
// date or part is the wrong type. The cast let them through (a TypeError for some, rows of undefined or of the wrong type for
// the rest); the Schema read refuses them all with a plain Error and a fixed sentence. Every case the SQL can write, and
// text that is not JSON (still a SyntaxError), answers as it did.
const REFUSED_NOW: string[] = [
	"text | JSON string",
	"text | JSON number",
	"text | JSON true",
	"text | JSON null",
	"text | empty object",
	"text | array of number",
	"text | array of null",
	"text | nested array",
	"text | array of object",
	"text | string and null",
	"text | Infinity element",
	"text | minus Infinity element",
	"text | duplicate keys",
	"text | __proto__ key",
	"text | lone surrogate",
	"text | depth 200 array",
	"text | depth 1000 array",
	"text | depth 2000 array",
	"text | depth 5000 array",
	"text | depth 2000 object",
	"text | 10k element array",
	"text | 2MB string",
	"row.name | missing",
	"row.name | null",
	"row.name | number",
	"row.name | zero",
	"row.name | one",
	"row.name | two",
	"row.name | negative",
	"row.name | fraction",
	"row.name | true",
	"row.name | false",
	"row.name | empty array",
	"row.name | array of text",
	"row.name | empty object",
	"row.name | object of text",
	"row.date | missing",
	"row.date | null",
	"row.date | number",
	"row.date | zero",
	"row.date | one",
	"row.date | two",
	"row.date | negative",
	"row.date | fraction",
	"row.date | true",
	"row.date | false",
	"row.date | empty array",
	"row.date | array of text",
	"row.date | empty object",
	"row.date | object of text",
	"row.part | missing",
	"row.part | null",
	"row.part | text",
	"row.part | empty text",
	"row.part | true",
	"row.part | false",
	"row.part | empty array",
	"row.part | array of text",
	"row.part | empty object",
	"row.part | object of text",
	"element | missing",
	"element | null",
	"element | number",
	"element | zero",
	"element | one",
	"element | two",
	"element | negative",
	"element | fraction",
	"element | text",
	"element | empty text",
	"element | true",
	"element | false",
	"element | empty array",
	"element | array of text",
	"element | empty object",
	"element | object of text",
	"row of only extra keys",
	"dates of numbers",
	"dates of mixed types",
	"deep list",
];

/** What the case answers now: as recorded, except where the move refuses it. */
const wanted = (label: string) =>
	REFUSED_NOW.includes(label) ? "throws Error" : (recorded[label] ?? "");

describe("the owned names are read as they were before (#1180)", () => {
	it("gives every corpus case the answer recorded for it", async () => {
		const list = ownedNamesCases();
		const labels = list.map((item) => item.label);

		expect(new Set(labels).size).toBe(labels.length);
		expect(Object.keys(recorded).sort()).toEqual([...labels].sort());

		const problems: string[] = [];

		for (const item of list) {
			const got = await answerOf(item);

			if (got !== wanted(item.label))
				problems.push(
					`${item.label}\n  want ${wanted(item.label)}\n  got  ${got}`,
				);
		}

		expect(problems).toEqual([]);
	}, 600_000);

	it("names only cases that were taken before or threw a TypeError, never a SyntaxError", () => {
		expect(new Set(REFUSED_NOW).size).toBe(REFUSED_NOW.length);

		for (const label of REFUSED_NOW)
			expect(recorded[label], label).not.toMatch(/^throws (SyntaxError|Error)/);
	});
});

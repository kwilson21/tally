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

// A cash delete hold with a column the Schema refuses answers null (snapshotOf), and the restore writes nothing. Each label
// here is a column that is not JSON of the shape the restore reads, or a plan missing its transaction (decision 233).
const CASH_REFUSED: string[] = [
	"cash | payment_rows | 10k element array",
	"cash | payment_rows | 2MB string",
	"cash | payment_rows | Infinity element",
	"cash | payment_rows | JSON null",
	"cash | payment_rows | JSON number",
	"cash | payment_rows | JSON string",
	"cash | payment_rows | JSON true",
	"cash | payment_rows | __proto__ key",
	"cash | payment_rows | array of null",
	"cash | payment_rows | array of number",
	"cash | payment_rows | depth 1000 array",
	"cash | payment_rows | depth 200 array",
	"cash | payment_rows | depth 2000 array",
	"cash | payment_rows | depth 2000 object",
	"cash | payment_rows | depth 5000 array",
	"cash | payment_rows | duplicate keys",
	"cash | payment_rows | empty object",
	"cash | payment_rows | lone surrogate",
	"cash | payment_rows | minus Infinity element",
	"cash | payment_rows | nested array",
	"cash | payment_rows | string and null",
	"cash | plan missing transaction_id",
	"cash | plan_rows | 10k element array",
	"cash | plan_rows | 2MB string",
	"cash | plan_rows | Infinity element",
	"cash | plan_rows | JSON null",
	"cash | plan_rows | JSON number",
	"cash | plan_rows | JSON string",
	"cash | plan_rows | JSON true",
	"cash | plan_rows | __proto__ key",
	"cash | plan_rows | array of null",
	"cash | plan_rows | array of number",
	"cash | plan_rows | array of object",
	"cash | plan_rows | depth 1000 array",
	"cash | plan_rows | depth 200 array",
	"cash | plan_rows | depth 2000 array",
	"cash | plan_rows | depth 2000 object",
	"cash | plan_rows | depth 5000 array",
	"cash | plan_rows | duplicate keys",
	"cash | plan_rows | empty object",
	"cash | plan_rows | lone surrogate",
	"cash | plan_rows | minus Infinity element",
	"cash | plan_rows | nested array",
	"cash | plan_rows | string and null",
	"cash | refund_rows | 10k element array",
	"cash | refund_rows | 2MB string",
	"cash | refund_rows | Infinity element",
	"cash | refund_rows | JSON null",
	"cash | refund_rows | JSON number",
	"cash | refund_rows | JSON string",
	"cash | refund_rows | JSON true",
	"cash | refund_rows | __proto__ key",
	"cash | refund_rows | array of null",
	"cash | refund_rows | array of number",
	"cash | refund_rows | depth 1000 array",
	"cash | refund_rows | depth 200 array",
	"cash | refund_rows | depth 2000 array",
	"cash | refund_rows | depth 2000 object",
	"cash | refund_rows | depth 5000 array",
	"cash | refund_rows | duplicate keys",
	"cash | refund_rows | empty object",
	"cash | refund_rows | lone surrogate",
	"cash | refund_rows | minus Infinity element",
	"cash | refund_rows | nested array",
	"cash | refund_rows | string and null",
	"cash | split_rows | 10k element array",
	"cash | split_rows | 2MB string",
	"cash | split_rows | Infinity element",
	"cash | split_rows | JSON null",
	"cash | split_rows | JSON number",
	"cash | split_rows | JSON string",
	"cash | split_rows | JSON true",
	"cash | split_rows | __proto__ key",
	"cash | split_rows | array of null",
	"cash | split_rows | array of number",
	"cash | split_rows | depth 1000 array",
	"cash | split_rows | depth 200 array",
	"cash | split_rows | depth 2000 array",
	"cash | split_rows | depth 2000 object",
	"cash | split_rows | depth 5000 array",
	"cash | split_rows | duplicate keys",
	"cash | split_rows | empty object",
	"cash | split_rows | lone surrogate",
	"cash | split_rows | minus Infinity element",
	"cash | split_rows | nested array",
	"cash | split_rows | string and null",
	"cash | transaction_row | 10k element array",
	"cash | transaction_row | 2MB string",
	"cash | transaction_row | Infinity element",
	"cash | transaction_row | JSON null",
	"cash | transaction_row | JSON number",
	"cash | transaction_row | JSON string",
	"cash | transaction_row | JSON true",
	"cash | transaction_row | array of null",
	"cash | transaction_row | array of number",
	"cash | transaction_row | array of object",
	"cash | transaction_row | depth 1000 array",
	"cash | transaction_row | depth 200 array",
	"cash | transaction_row | depth 2000 array",
	"cash | transaction_row | depth 5000 array",
	"cash | transaction_row | empty array",
	"cash | transaction_row | lone surrogate",
	"cash | transaction_row | minus Infinity element",
	"cash | transaction_row | nested array",
	"cash | transaction_row | string and null",
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

	if (CASH_REFUSED.includes(label)) return "null";

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

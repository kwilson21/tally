import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { readStoredWith } from "../src/db/stored-shape";
import baseline from "./fixtures/stored-json-baseline.json";
import { encodeAnswer } from "./stored-json-answers";
import { cases } from "./stored-json-corpus";

// The Schema read beside the stored-shape guards (#1120). For every stored-shape case, readStoredWith with the Schema
// that matches each guard must answer what readStored answered with that guard (fixtures/stored-json-baseline.json).

const recorded: Record<string, string> = baseline;

const SCHEMAS = {
	number: Schema.Finite,
	strings: Schema.mutable(Schema.Array(Schema.String)),
	pair: Schema.Struct({ a: Schema.Finite, b: Schema.String }),
	flags: Schema.Record(Schema.String, Schema.Boolean),
};

describe("readStoredWith reads stored text with a Schema (#1120)", () => {
	it("gives the stored value, keeping the keys the Schema does not name", () => {
		const pair = readStoredWith(
			Schema.Struct({ a: Schema.Finite }),
			'{"a":1,"c":[2]}',
		);

		expect(pair).toEqual({ a: 1, c: [2] });
	});

	it("gives null for text that is not JSON, or JSON of the wrong shape", () => {
		expect(readStoredWith(Schema.Finite, "not json")).toBeNull();
		expect(readStoredWith(Schema.Finite, "")).toBeNull();
		expect(readStoredWith(Schema.Finite, '"5"')).toBeNull();
		expect(readStoredWith(Schema.Finite, "1e999")).toBeNull();
	});

	it("gives every stored-shape case the answer readStored gave, for the matching guard", () => {
		const problems: string[] = [];

		for (const item of cases()) {
			if (item.site !== "stored") continue;

			const got = encodeAnswer(readStoredWith(SCHEMAS[item.guard], item.text));

			if (got !== recorded[item.label])
				problems.push(
					`${item.label}\n  want ${recorded[item.label]}\n  got  ${got}`,
				);
		}

		expect(problems).toEqual([]);
	});
});

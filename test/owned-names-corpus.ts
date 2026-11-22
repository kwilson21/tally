// Inputs for the other own-named transactions from a merchant, the JSON the transaction SELECT builds with json_group_array
// and ownedNamesOf reads (src/db/transactions.ts, #1180). The SQL always writes a list of {name, date, part} rows, so these
// are odd texts and odd elements the SQL never writes, plus the orderings it does. Pure data: the characterise test reads
// each text and compares the answer with fixtures/owned-names-baseline.json, recorded on the code before the read moved
// from a cast to Effect Schema. Every name is made up.

import type { Json } from "../src/json";
import { ODD as ODD_TEXTS } from "./held-json-corpus";

export type OwnedNamesCase = { label: string; text: string };

type Field = Json | undefined;

const GOOD_ROW = { name: "Corner Cafe", date: "2026-10-01", part: 0 };

const row = (over: { [key: string]: Field }) => ({ ...GOOD_ROW, ...over });

const ODD: [string, Field][] = [
	["missing", undefined],
	["null", null],
	["number", 5],
	["zero", 0],
	["one", 1],
	["two", 2],
	["negative", -1],
	["fraction", 1.5],
	["text", "x"],
	["empty text", ""],
	["true", true],
	["false", false],
	["empty array", []],
	["array of text", ["a"]],
	["empty object", {}],
	["object of text", { a: "x" }],
];

const encode = (value: Json) => JSON.stringify(value);

export const ownedNamesCases = (): OwnedNamesCase[] => {
	const out: OwnedNamesCase[] = [
		{ label: "good, one row", text: encode([GOOD_ROW]) },
		{ label: "good, none", text: "[]" },
		{ label: "good, a part", text: encode([row({ part: 1 })]) },
	];

	for (const [name, text] of ODD_TEXTS)
		out.push({ label: `text | ${name}`, text });

	for (const key of ["name", "date", "part"])
		for (const [name, value] of ODD)
			out.push({
				label: `row.${key} | ${name}`,
				text: `[${JSON.stringify(row({ [key]: value }))}]`,
			});

	for (const [name, value] of ODD)
		out.push({
			label: `element | ${name}`,
			text: `[${JSON.stringify(GOOD_ROW)},${value === undefined ? "null" : JSON.stringify(value)}]`,
		});

	out.push(
		{
			label: "row of only extra keys",
			text: encode([{ other: 1 }]),
		},
		{
			label: "row with extra keys",
			text: encode([row({ extra: { a: [1] } })]),
		},
		{
			label: "row with __proto__ key",
			text: `[{"__proto__":{"name":"x"},"name":"A","date":"2026-10-01","part":0}]`,
		},
		{
			label: "newest first",
			text: encode([
				row({ name: "Old", date: "2026-01-01" }),
				row({ name: "New", date: "2026-10-01" }),
				row({ name: "Mid", date: "2026-05-01" }),
			]),
		},
		{
			label: "equal dates keep their order",
			text: encode([
				row({ name: "A" }),
				row({ name: "B" }),
				row({ name: "C" }),
			]),
		},
		{
			label: "dates of numbers",
			text: encode([
				row({ name: "A", date: 20260101 }),
				row({ name: "B", date: 20261001 }),
			]),
		},
		{
			label: "dates of mixed types",
			text: encode([
				row({ name: "A", date: "2026-01-01" }),
				row({ name: "B", date: 5 }),
				row({ name: "C", date: null }),
			]),
		},
		{
			label: "parts and wholes",
			text: encode([
				row({ name: "A", part: 1, date: "2026-02-01" }),
				row({ name: "B", part: 0, date: "2026-03-01" }),
			]),
		},
		{
			label: "unicode names",
			text: encode([row({ name: "Café ☕ \u0000 🍕" })]),
		},
		{
			label: "10k rows",
			text: encode(
				Array.from({ length: 10_000 }, (_, i) =>
					row({
						name: `N${i}`,
						date: `2026-${String((i % 12) + 1).padStart(2, "0")}-01`,
					}),
				),
			),
		},
		{
			label: "row with a huge number in part",
			text: `[{"name":"A","date":"2026-10-01","part":1e999}]`,
		},
		{
			label: "row with 1.0 in part",
			text: `[{"name":"A","date":"2026-10-01","part":1.0}]`,
		},
		{
			label: "deep list",
			text: `${"[".repeat(5000)}${"]".repeat(5000)}`,
		},
		{
			label: "a 2MB name",
			text: encode([row({ name: "a".repeat(2_000_000) })]),
		},
	);

	return out;
};

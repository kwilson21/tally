// Inputs for the first week's record, the JSON in `household_settings.first_tally`, read by parseFirstTally (#1150, #1181).
// Each case gives it an odd text, or one key or nested key an odd value on top of a good record. Pure data: the characterise
// test reads each text and compares the answer with fixtures/first-tally-stored-baseline.json, recorded on the code before
// the read moved from hand checks to Effect Schema. Every address, name and id here is made up.

import type { Json } from "../src/json";
import { ODD as ODD_TEXTS } from "./held-json-corpus";

export type FirstTallyStoredCase = { label: string; text: string };

type Field = Json | undefined | Fields | Field[];

type Fields = { [key: string]: Field };

const MAIL = {
	mail: { subject: "s", html: "<p>h</p>", text: "t" },
	at: "2026-09-24T10:00:00Z",
	tried: false,
} satisfies Fields;

export const GOOD = {
	strokes: {
		bank: "2026-09-22",
		pay: null,
		bills: "2026-09-23",
		budgets: "2026-09-24",
	},
	budgets: {
		"3": { kind: "suggested", cents: 50000 },
		"4": { kind: "another", cents: 12000 },
		"5": { kind: "skipped", cents: null },
	},
	pay: {
		ACME: {
			yes: { "11": { date: "2026-09-01", cents: 250000 } },
			no: { "12": { date: "2026-09-02", cents: 1000 } },
			at: 0,
		},
	},
	bills: { kept: 2, cents: 14200 },
	reAsk: { bank: "Wells Fargo" },
	waitsForRun: true,
	readyEmailedTo: ["a@example.com"],
	readyPushedTo: ["b@example.com"],
	readyPushedAt: { abc: "2026-09-24T10:00:00Z" },
	readyClaimedAt: { abc: "2026-09-24T10:00:00Z" },
	heldReadyEmail: { abc: MAIL },
	savings: 30000,
} satisfies Fields;

/** The odd values one key takes. `undefined` leaves the key out; the sentinels become numbers JSON.stringify cannot write. */
const ODD: [string, Field][] = [
	["missing", undefined],
	["null", null],
	["number", 5],
	["zero", 0],
	["negative", -1],
	["fraction", 1.5],
	["text", "x"],
	["empty text", ""],
	["true", true],
	["false", false],
	["empty array", []],
	["array of text", ["a", "b"]],
	["mixed array", ["a", 1, null, "b"]],
	["empty object", {}],
	["object of text", { a: "x" }],
	["object of number", { a: 1 }],
	["object of null", { a: null }],
	["infinity", "__INFINITY__"],
	["negative zero", "__NEGATIVE_ZERO__"],
	["huge integer", "__HUGE__"],
	["above 2^53", 9007199254740993],
];

const encode = (value: Fields) =>
	JSON.stringify(value)
		.replaceAll('"__INFINITY__"', "1e999")
		.replaceAll('"__NEGATIVE_ZERO__"', "-0")
		.replaceAll('"__HUGE__"', "1e300");

const withKey = (base: Fields, key: string, value: Field) => ({
	...base,
	[key]: value,
});

const TOP_KEYS = Object.keys(GOOD);

export const firstTallyCases = (): FirstTallyStoredCase[] => {
	const out: FirstTallyStoredCase[] = [
		{ label: "good", text: encode(GOOD) },
		{ label: "empty record", text: '{"strokes":{},"budgets":{}}' },
	];

	for (const [name, text] of ODD_TEXTS)
		out.push({ label: `text | ${name}`, text });

	const onKey = (label: string, build: (value: Field) => Fields) => {
		for (const [name, value] of ODD)
			out.push({ label: `${label} | ${name}`, text: encode(build(value)) });
	};

	for (const key of TOP_KEYS) onKey(key, (value) => withKey(GOOD, key, value));

	for (const stroke of ["bank", "pay", "bills", "budgets", "other"])
		onKey(`strokes.${stroke}`, (value) =>
			withKey(GOOD, "strokes", withKey(GOOD.strokes, stroke, value)),
		);

	for (const key of ["kind", "cents"]) {
		for (const base of ["3", "4", "5"])
			onKey(`budgets.${base}.${key}`, (value) =>
				withKey(GOOD, "budgets", {
					...GOOD.budgets,
					[base]: withKey(
						base === "3"
							? GOOD.budgets["3"]
							: base === "4"
								? GOOD.budgets["4"]
								: GOOD.budgets["5"],
						key,
						value,
					),
				}),
			);
	}

	for (const key of ["yes", "no", "at"])
		onKey(`pay.ACME.${key}`, (value) =>
			withKey(GOOD, "pay", { ACME: withKey(GOOD.pay.ACME, key, value) }),
		);

	for (const key of ["date", "cents"])
		onKey(`pay.ACME.yes.11.${key}`, (value) =>
			withKey(GOOD, "pay", {
				ACME: withKey(GOOD.pay.ACME, "yes", {
					"11": withKey(GOOD.pay.ACME.yes["11"], key, value),
				}),
			}),
		);

	for (const key of ["kept", "cents"])
		onKey(`bills.${key}`, (value) =>
			withKey(GOOD, "bills", withKey(GOOD.bills, key, value)),
		);

	onKey("reAsk.bank", (value) => withKey(GOOD, "reAsk", { bank: value }));

	for (const key of ["mail", "at", "tried"])
		onKey(`heldReadyEmail.abc.${key}`, (value) =>
			withKey(GOOD, "heldReadyEmail", { abc: withKey(MAIL, key, value) }),
		);

	for (const key of ["readyEmailedTo", "readyPushedTo"])
		onKey(`${key} holds`, (value) =>
			withKey(GOOD, key, ["a@example.com", value, "c@example.com"]),
		);

	for (const key of [
		"readyPushedAt",
		"readyClaimedAt",
		"budgets",
		"pay",
		"heldReadyEmail",
	])
		onKey(`${key} entry`, (value) =>
			withKey(GOOD, key, { first: value, abc: GOOD.readyPushedAt.abc }),
		);

	out.push(
		{ label: "extra key", text: encode({ ...GOOD, extra: { a: [1] } }) },
		{
			label: "__proto__ key at the top",
			text: `{"__proto__":{"savings":1},${encode(GOOD).slice(1)}`,
		},
		{
			label: "budgets keyed __proto__",
			text: encode(GOOD).replace(
				'"budgets":{',
				'"budgets":{"__proto__":{"kind":"another","cents":7},',
			),
		},
		{
			label: "pay keyed __proto__",
			text: encode(GOOD).replace(
				'"pay":{"ACME"',
				'"pay":{"__proto__":{"at":1},"ACME"',
			),
		},
		{
			label: "readyPushedAt keyed __proto__",
			text: encode(GOOD).replace(
				'"readyPushedAt":{',
				'"readyPushedAt":{"__proto__":"2026-09-24T10:00:00Z",',
			),
		},
		{
			label: "heldReadyEmail keyed __proto__",
			text: encode(GOOD).replace(
				'"heldReadyEmail":{',
				'"heldReadyEmail":{"__proto__":{"a":1},',
			),
		},
		{
			label: "duplicate savings, the bad one last",
			text: encode(GOOD).replace(
				'"savings":30000',
				'"savings":30000,"savings":"x"',
			),
		},
		{
			label: "duplicate savings, the bad one first",
			text: encode(GOOD).replace(
				'"savings":30000',
				'"savings":"x","savings":30000',
			),
		},
		{
			label: "key order of budgets",
			text: encode(
				withKey(GOOD, "budgets", {
					"9": { kind: "another", cents: 1 },
					"2": { kind: "suggested", cents: 2 },
					a: { kind: "skipped", cents: null },
				}),
			),
		},
		{
			label: "a legacy held email with only its read line",
			text: encode(
				withKey(GOOD, "heldReadyEmail", {
					abc: { line: "Hi", at: "2026-09-24" },
				}),
			),
		},
		{
			label: "many budgets",
			text: encode(
				withKey(
					GOOD,
					"budgets",
					Object.fromEntries(
						Array.from({ length: 2000 }, (_, i) => [
							String(i),
							{ kind: "another", cents: i },
						]),
					),
				),
			),
		},
		{
			label: "depth 5000 in an extra key",
			text: encode(GOOD).replace(
				/}$/,
				`,"x":${"[".repeat(5000)}${"]".repeat(5000)}}`,
			),
		},
		{
			label: "depth 5000 in a held email",
			text: encode(GOOD).replace(
				'"heldReadyEmail":{',
				`"heldReadyEmail":{"deep":{"x":${"[".repeat(5000)}${"]".repeat(5000)}},`,
			),
		},
	);

	return out;
};

// Inputs for the stored JSON reads (#1120): each site that reads JSON the app stored, with the edge values of its
// shape. Pure data: the characterise test runs each case through the site's exported reader and compares the answer
// with fixtures/stored-json-baseline.json, recorded on the code before any site moved to Effect Schema. Every name,
// merchant and address here is made up for the Rivera family.

import type { Json } from "../src/json";

export const GUARDS = ["number", "strings", "pair", "flags"] as const;

export type GuardName = (typeof GUARDS)[number];

/** The address hash a kept try is stored under in these cases; the answer is read for this hash only. */
export const KEPT_HASH = "a".repeat(64);

/** A hash no case stores under. */
export const OTHER_HASH = "b".repeat(64);

export type StoredCase =
	| {
			label: string;
			site: "unpaid" | "names";
			stored: string | null | undefined;
	  }
	| { label: string; site: "kept"; held: string | null }
	| {
			label: string;
			site: "diagnostics";
			clientContext: string | null;
			page: string;
	  }
	| { label: string; site: "context"; clientContext: string | null }
	| { label: string; site: "budgets"; values: string[] }
	| { label: string; site: "stored"; guard: GuardName; text: string };

const LINE = "2026-11-14T10:00:00.000Z";

/** A held map with one entry under the kept hash. */
const heldWith = (entry: Json) => JSON.stringify({ [KEPT_HASH]: entry });

const UNPAID = [
	{ label: "unpaid | no value", stored: null },
	{ label: "unpaid | undefined", stored: undefined },
	{ label: "unpaid | empty text", stored: "" },
	{ label: "unpaid | empty array", stored: "[]" },
	{ label: "unpaid | empty object", stored: "{}" },
	{ label: "unpaid | null JSON", stored: "null" },
	{ label: "unpaid | string JSON", stored: '"text"' },
	{ label: "unpaid | number JSON", stored: "123" },
	{ label: "unpaid | not JSON", stored: "not json" },
	{
		label: "unpaid | truncated array",
		stored: '[{"name":"Gas","period":"2026"}',
	},
	{
		label: "unpaid | whitespace around",
		stored: '  [ {"name":"Gas","period":"2026"} ]  ',
	},
	{
		label: "unpaid | one good bill with billId",
		stored: '[{"billId":3,"name":"Rivera Water","period":"2026-09"}]',
	},
	{
		label: "unpaid | good bills in two periods",
		stored:
			'[{"name":"Gas","period":"2026-Q3"},{"name":"Phone","period":"2026-09-14"},{"name":"Trash","period":"2026"}]',
	},
	{ label: "unpaid | missing name", stored: '[{"period":"2026"}]' },
	{ label: "unpaid | missing period", stored: '[{"name":"Gas"}]' },
	{
		label: "unpaid | name is a number",
		stored: '[{"name":5,"period":"2026"}]',
	},
	{
		label: "unpaid | period is a number",
		stored: '[{"name":"A","period":2026}]',
	},
	{ label: "unpaid | null entry", stored: "[null]" },
	{ label: "unpaid | string entry", stored: '["Gas"]' },
	{ label: "unpaid | array entry", stored: '[["Gas","2026"]]' },
	{ label: "unpaid | number entry", stored: "[5]" },
	{
		label: "unpaid | good, bad and good",
		stored:
			'[{"name":"A","period":"2026"},{"name":1,"period":"x"},{"name":"B","period":"2027"}]',
	},
	{
		label: "unpaid | empty name and period kept",
		stored: '[{"name":"","period":""}]',
	},
	{
		label: "unpaid | nested extra keys",
		stored: '[{"name":"A","period":"2026","extra":{"deep":[1,2,{"x":null}]}}]',
	},
	{
		label: "unpaid | duplicate name key",
		stored: '[{"name":"A","name":"B","period":"2026"}]',
	},
	{
		label: "unpaid | big number extra",
		stored: '[{"name":"A","period":"2026","n":1e999}]',
	},
	{
		label: "unpaid | object instead of array",
		stored: '{"name":"A","period":"2026"}',
	},
	{
		label: "unpaid | deep nesting",
		stored: `${"[".repeat(200)}${"]".repeat(200)}`,
	},
	{
		label: "unpaid | __proto__ key",
		stored: '[{"__proto__":{"name":"x"},"name":"A","period":"P"}]',
	},
];

const NAMES = [
	{ label: "names | no value", stored: null },
	{ label: "names | undefined", stored: undefined },
	{ label: "names | empty text", stored: "" },
	{ label: "names | empty array", stored: "[]" },
	{ label: "names | empty object", stored: "{}" },
	{ label: "names | null JSON", stored: "null" },
	{ label: "names | string JSON", stored: '"text"' },
	{ label: "names | number JSON", stored: "123" },
	{ label: "names | not JSON", stored: "not json" },
	{ label: "names | truncated", stored: '[[1,"a"]' },
	{
		label: "names | sorted and capped",
		stored: '[[2,"Beta"],[1,"  Alpha  "],[3,"Gamma"],[4,"Delta"]]',
	},
	{
		label: "names | blank names dropped",
		stored: '[[1,"   "],[2,""],[3,"Kept"]]',
	},
	{ label: "names | position is a string", stored: '[["1","a"]]' },
	{ label: "names | position is null", stored: '[[null,"a"]]' },
	{ label: "names | name is null", stored: "[[1,null]]" },
	{ label: "names | no name", stored: "[[1]]" },
	{ label: "names | extra element kept", stored: '[[1,"a","x"]]' },
	{ label: "names | extra element of array kept", stored: '[[1,"a",[1]]]' },
	{ label: "names | object row dropped", stored: '[{"0":1,"1":"a"}]' },
	{
		label: "names | bad rows interleaved",
		stored: '[1,[1,"a"],"x",null,[2,"b"],[3]]',
	},
	{ label: "names | tab and newline trimmed", stored: '[[1," \\n Tab\\t "]]' },
	{
		label: "names | non-breaking space trimmed",
		stored: '[[1,"\\u00a0Nbsp\\u00a0"]]',
	},
	{ label: "names | empty row", stored: "[[]]" },
	{ label: "names | one element row", stored: '[["a"]]' },
	{ label: "names | deep row", stored: "[[[[1]]]]" },
	{ label: "names | NaN text", stored: '[[NaN,"a"]]' },
	{
		label: "names | Infinity by 1e999 sorts last",
		stored: '[[1e999,"Inf"],[0,"Zero"]]',
	},
	{
		label: "names | negative zero ties keep order",
		stored: '[[-0,"NegZero"],[0,"Zero"]]',
	},
	{
		label: "names | equal positions keep order",
		stored: '[[1,"x"],[1,"y"],[1,"z"],[1,"w"]]',
	},
	{
		label: "names | big positions",
		stored: '[[5,"five"],[1e20,"big"],[-1e20,"neg"]]',
	},
	{ label: "names | object not array", stored: '{"0":[1,"a"]}' },
	{
		label: "names | deep nesting",
		stored: `${"[".repeat(200)}${"]".repeat(200)}`,
	},
];

const KEPT_MAIL = {
	subject: "Ready to go",
	html: "<p>Ready</p>",
	text: "Ready",
};

const KEPT = [
	{ label: "kept | no held value", held: null },
	{ label: "kept | empty held", held: "" },
	{ label: "kept | held is null JSON", held: "null" },
	{ label: "kept | held is an empty object", held: "{}" },
	{ label: "kept | held is an array", held: "[1]" },
	{ label: "kept | held is a string", held: '"text"' },
	{ label: "kept | held is a number", held: "123" },
	{ label: "kept | held is not JSON", held: "not json" },
	{ label: "kept | held is truncated", held: `{"${KEPT_HASH}":` },
	{
		label: "kept | held under another hash",
		held: JSON.stringify({ [OTHER_HASH]: { mail: KEPT_MAIL, at: LINE } }),
	},
	{
		label: "kept | stored email, not fresh",
		held: heldWith({ mail: KEPT_MAIL, at: LINE }),
	},
	{
		label: "kept | stored email, fresh",
		held: heldWith({ mail: KEPT_MAIL, at: LINE, tried: false }),
	},
	{
		label: "kept | stored email, tried true",
		held: heldWith({ mail: KEPT_MAIL, at: LINE, tried: true }),
	},
	{
		label: "kept | stored email, tried is a string",
		held: heldWith({ mail: KEPT_MAIL, at: LINE, tried: "false" }),
	},
	{
		label: "kept | stored email with extra keys",
		held: heldWith({
			mail: { ...KEPT_MAIL, extra: 1 },
			at: LINE,
			tried: false,
		}),
	},
	{
		label: "kept | mail missing subject",
		held: heldWith({ mail: { html: "h", text: "t" }, at: LINE }),
	},
	{
		label: "kept | mail subject is a number",
		held: heldWith({ mail: { subject: 1, html: "h", text: "t" }, at: LINE }),
	},
	{ label: "kept | mail is null", held: heldWith({ mail: null, at: LINE }) },
	{
		label: "kept | mail is an array",
		held: heldWith({ mail: [1, 2], at: LINE }),
	},
	{
		label: "kept | mail is a string",
		held: heldWith({ mail: "words", at: LINE }),
	},
	{ label: "kept | no time", held: heldWith({ mail: KEPT_MAIL }) },
	{
		label: "kept | time is a number",
		held: heldWith({ mail: KEPT_MAIL, at: 5 }),
	},
	{
		label: "kept | time is null",
		held: heldWith({ mail: KEPT_MAIL, at: null }),
	},
	{
		label: "kept | time is an empty string",
		held: heldWith({ mail: KEPT_MAIL, at: "" }),
	},
	{
		label: "kept | time is not a date",
		held: heldWith({ mail: KEPT_MAIL, at: "not a date" }),
	},
	{
		label: "kept | line only",
		held: heldWith({ line: "Maya and Ren", at: LINE }),
	},
	{
		label: "kept | line only, fresh",
		held: heldWith({ line: "Maya and Ren", at: LINE, tried: false }),
	},
	{
		label: "kept | line with empty words",
		held: heldWith({ line: "", at: LINE }),
	},
	{
		label: "kept | line is a number and no mail",
		held: heldWith({ line: 5, at: LINE }),
	},
	{
		label: "kept | line is a number and a mail",
		held: heldWith({ line: 5, mail: KEPT_MAIL, at: LINE }),
	},
	{
		label: "kept | line and a valid mail, mail wins",
		held: heldWith({ line: "Maya", mail: KEPT_MAIL, at: LINE }),
	},
	{
		label: "kept | line and a null mail",
		held: heldWith({ line: "Maya", mail: null, at: LINE }),
	},
	{ label: "kept | entry is an array", held: heldWith([LINE]) },
	{ label: "kept | entry is null", held: heldWith(null) },
	{ label: "kept | entry is a string", held: heldWith("Maya") },
	{
		label: "kept | big tried number",
		held: `{"${KEPT_HASH}":{"mail":${JSON.stringify(KEPT_MAIL)},"at":"${LINE}","tried":1e999}}`,
	},
	{
		label: "kept | deep mail",
		held: heldWith({
			mail: { subject: "s", html: "h", text: "t", deep: [[[[1]]]] },
			at: LINE,
		}),
	},
];

const DIAGNOSTICS_PAGE = "/first-tally";

const DIAGNOSTICS: Array<[string, string | null]> = [
	["no context", null],
	["empty context", ""],
	["null JSON", "null"],
	["empty object", "{}"],
	["empty array", "[]"],
	["string JSON", '"text"'],
	["number JSON", "123"],
	["Infinity JSON", "1e999"],
	["not JSON", "not json"],
	["truncated object", '{"deviceCategory":"Mobile browser"'],
	[
		"good context",
		'{"deviceCategory":"Mobile browser","errorName":"TypeError"}',
	],
	["unknown device", '{"deviceCategory":"Watch","errorName":"Nope"}'],
	["device only", '{"deviceCategory":"Desktop browser"}'],
	["error name only", '{"errorName":"AbortError"}'],
	["empty error name", '{"errorName":""}'],
	["array with a device", '[{"deviceCategory":"Mobile browser"}]'],
	["device is a number", '{"deviceCategory":5,"errorName":null}'],
	[
		"raw agent and dimensions ignored",
		'{"userAgent":"Mozilla/5.0","width":390,"deviceCategory":"Tablet browser"}',
	],
	[
		"route inside context ignored",
		'{"route":"/evil","deviceCategory":"Unknown"}',
	],
	[
		"duplicate device key",
		'{"deviceCategory":"Mobile browser","deviceCategory":"Unknown"}',
	],
	["deep nesting", `${"[".repeat(200)}${"]".repeat(200)}`],
];

const CONTEXTS: Array<[string, string | null]> = [
	["no field", null],
	["empty field", ""],
	["null JSON", "null"],
	["empty object", "{}"],
	["empty array", "[]"],
	["string JSON", '"text"'],
	["Infinity JSON", "1e999"],
	["not JSON", "not json"],
	[
		"good context",
		'{"deviceCategory":"Mobile browser","errorName":"TypeError","userAgent":"x"}',
	],
	["array context", '[{"deviceCategory":"Mobile browser"}]'],
	["unknown error name", '{"errorName":"Teapot"}'],
	["truncated", '{"deviceCategory":'],
];

const BUDGETS: Array<[string, string[]]> = [
	["no values", []],
	["empty value", [""]],
	["null JSON", ["null"]],
	["empty array", ["[]"]],
	["empty object", ["{}"]],
	["id 1", ['{"id":1}']],
	["id as text", ['{"id":"1"}']],
	["id 1.5", ['{"id":1.5}']],
	["id negative zero", ['{"id":-0}']],
	["id 1e20 is an integer", ['{"id":1e20}']],
	["id 1e999", ['{"id":1e999}']],
	["id past safe integers", ['{"id":9007199254740993}']],
	["id null", ['{"id":null}']],
	["id true", ['{"id":true}']],
	["id array", ['{"id":[1]}']],
	["id object", ['{"id":{}}']],
	["array value", ["[1]"]],
	["string value", ['"x"']],
	["number value", ["1"]],
	["not JSON", ["not json"]],
	["truncated", ['{"id":3']],
	["two objects in one value", ['{"id":1},{"id":2}']],
	["same id twice", ['{"id":1}', '{"id":1}']],
	["order kept", ['{"id":2}', '{"id":1}', "bad"]],
	["extra keys", ['{"id":1,"name":"x"}']],
	["zero", ['{"id":0}']],
	["negative", ['{"id":-5}']],
	["duplicate id key", ['{"id":1,"id":2}']],
	["tiny fraction", ['{"id":1e-7}']],
	["negative big", ['{"id":-1e20}']],
];

const STORED: Array<[string, string]> = [
	["empty text", ""],
	["null", "null"],
	["zero", "0"],
	["negative zero", "-0"],
	["1e999", "1e999"],
	["-1e999", "-1e999"],
	["1e-400", "1e-400"],
	["NaN text", "NaN"],
	["Infinity text", "Infinity"],
	["quoted number", '"1"'],
	["empty array", "[]"],
	["empty object", "{}"],
	["array of one number", "[1]"],
	["mixed array", '["a",1]'],
	["strings", '["a","b"]'],
	["pair", '{"a":1,"b":"x"}'],
	["pair with extra key", '{"a":1,"b":"x","c":[1]}'],
	["pair with negative zero", '{"a":-0,"b":""}'],
	["pair with 1e999", '{"a":1e999,"b":"x"}'],
	["pair missing b", '{"a":1}'],
	["pair missing a", '{"b":"x"}'],
	["pair with null a", '{"a":null,"b":"x"}'],
	["pair in an array", '[{"a":1,"b":"x"}]'],
	["flags", '{"x":true,"y":false}'],
	["flags with a number", '{"x":true,"y":1}'],
	["flags empty object", "{}"],
	["flags with an array", '{"x":[true]}'],
	["array of flags", "[true]"],
	["truncated", "tru"],
	["pair with a duplicate key", '{"a":1,"b":"x","a":2}'],
	["spaces around", ' ["a"] '],
	["proto key", '{"__proto__":true}'],
	["deep nesting", `${"[".repeat(100)}${"]".repeat(100)}`],
];

/** Every case in the corpus, in a fixed order. Labels are unique across the file. */
export function cases(): StoredCase[] {
	return [
		...UNPAID.map((c) => ({ ...c, site: "unpaid" as const })),
		...NAMES.map((c) => ({ ...c, site: "names" as const })),
		...KEPT.map((c) => ({ ...c, site: "kept" as const })),
		...DIAGNOSTICS.map(([name, clientContext]) => ({
			label: `diagnostics | ${name}`,
			site: "diagnostics" as const,
			clientContext,
			page: DIAGNOSTICS_PAGE,
		})),
		...CONTEXTS.map(([name, clientContext]) => ({
			label: `context | ${name}`,
			site: "context" as const,
			clientContext,
		})),
		...BUDGETS.map(([name, values]) => ({
			label: `budgets | ${name}`,
			site: "budgets" as const,
			values,
		})),
		...GUARDS.flatMap((guard) =>
			STORED.map(([name, text]) => ({
				label: `stored | ${guard} | ${name}`,
				site: "stored" as const,
				guard,
				text,
			})),
		),
	];
}

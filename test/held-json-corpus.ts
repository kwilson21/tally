// Inputs for the three held stored-JSON reads (#1120): the lookup texts' two lists (src/lookup/texts.ts), a bank's stored
// accounts (src/reconnect/reminders.ts) and a cash delete hold's five stored columns (src/transactions/cash-undo.ts). Each
// case gives one read the odd text a stored value can take, in one column at a time. Pure data: the characterise test runs
// each case through the reader it names and compares the answer with fixtures/held-json-baseline.json, recorded on the code
// before any of the three moved to Effect Schema. Every name and merchant here is made up.

export type CashTexts = {
	transaction_row: string;
	split_rows: string;
	payment_rows: string;
	refund_rows: string;
	plan_rows: string;
};

export type HeldCase =
	| { label: string; site: "texts"; rawTexts: string; categories: string }
	| { label: string; site: "reminders"; accounts: string | null }
	| { label: string; site: "cash"; texts: CashTexts };

const nest = (depth: number, open: string, close: string) =>
	open.repeat(depth) + close.repeat(depth);

/** Odd texts a stored list or object can take: JSON that parses, JSON of the wrong shape, and text that is not JSON. */
export const ODD: [string, string][] = [
	["empty text", ""],
	["not JSON", "not json"],
	["truncated", '["a"'],
	["BOM before JSON", '﻿["a"]'],
	["JSON string", '"text"'],
	["JSON number", "123"],
	["JSON true", "true"],
	["JSON null", "null"],
	["empty array", "[]"],
	["empty object", "{}"],
	["array of number", "[1]"],
	["array of null", "[null]"],
	["nested array", '[["a"]]'],
	["array of object", '[{"a":1}]'],
	["string and null", '["a",null]'],
	["Infinity element", "[1e999]"],
	["minus Infinity element", "[-1e999]"],
	["duplicate keys", '{"a":1,"a":2}'],
	["__proto__ key", '{"__proto__":{"x":1}}'],
	["lone surrogate", '["\\ud800"]'],
	["depth 200 array", nest(200, "[", "]")],
	["depth 1000 array", nest(1000, "[", "]")],
	["depth 2000 array", nest(2000, "[", "]")],
	["depth 5000 array", nest(5000, "[", "]")],
	["depth 2000 object", `${'{"a":'.repeat(2000)}null${"}".repeat(2000)}`],
	["10k element array", `[${Array(10000).fill("0").join(",")}]`],
	["2MB string", JSON.stringify("a".repeat(2_000_000))],
];

const TEXTS_GOOD = {
	rawTexts: '["LA COOP ARLINGTON"]',
	categories: '["FOOD_AND_DRINK"]',
};

const TRANSACTION_GOOD =
	'{"id":7,"account_id":2,"amount_cents":-1250,"raw_name":"MARKET","merchant_name":null,"refund_of_id":null,"parent_id":null,"is_split":0,"kind":null,"flag_income":0,"excluded":0}';

const CASH_GOOD: CashTexts = {
	transaction_row: TRANSACTION_GOOD,
	split_rows: "[]",
	payment_rows:
		'[{"id":3,"bill_id":1,"transaction_id":7,"status":"linked","amount_cents":1250,"bill_name":"Rent"}]',
	refund_rows: "[]",
	plan_rows: '[{"id":9,"transaction_id":7}]',
};

const CASH_COLUMNS = [
	"transaction_row",
	"split_rows",
	"payment_rows",
	"refund_rows",
	"plan_rows",
] as const;

/** Extra accounts texts beyond ODD: the bank rows the SQL builds, and the shapes around them. */
const ACCOUNTS_EXTRA: [string, string | null][] = [
	["SQL null", null],
	["good account", '[{"name":"Checking","mask":"4521"}]'],
	[
		"two good accounts",
		'[{"name":"Checking","mask":"4521"},{"name":"Savings","mask":null}]',
	],
	["good, null mask", '[{"name":"Checking","mask":null}]'],
	["missing mask key", '[{"name":"Checking"}]'],
	["numeric mask", '[{"name":"Checking","mask":4521}]'],
	["numeric name", '[{"name":1,"mask":null}]'],
	["name missing", '[{"mask":"4521"}]'],
	["extra key", '[{"name":"Checking","mask":"4521","id":3}]'],
	["good then number", '[{"name":"Checking","mask":"4521"},5]'],
	["duplicate name key", '[{"name":"A","name":"B","mask":null}]'],
	["lone surrogate name", '[{"name":"\\ud800","mask":null}]'],
	["object not array", '{"name":"Checking","mask":null}'],
	["empty name", '[{"name":"","mask":null}]'],
	["2MB name", `[{"name":"${"a".repeat(2_000_000)}","mask":null}]`],
];

export function cases(): HeldCase[] {
	const list: HeldCase[] = [
		{ label: "texts | good", site: "texts", ...TEXTS_GOOD },
		{
			label: "texts | categories with a null",
			site: "texts",
			rawTexts: '["LA COOP","MARKET"]',
			categories: '[null,"FOOD_AND_DRINK"]',
		},
		{
			label: "texts | rawTexts with a lone surrogate",
			site: "texts",
			rawTexts: '["\\ud800"]',
			categories: "[null]",
		},
		{
			label: "texts | both lists empty",
			site: "texts",
			rawTexts: "[]",
			categories: "[]",
		},
		{
			label: "texts | rawTexts good, categories not JSON",
			site: "texts",
			rawTexts: '["LA COOP"]',
			categories: "not json",
		},
		{ label: "cash | good", site: "cash", texts: CASH_GOOD },
	];

	for (const [name, text] of ODD) {
		list.push({
			label: `texts | rawTexts | ${name}`,
			site: "texts",
			rawTexts: text,
			categories: TEXTS_GOOD.categories,
		});
		list.push({
			label: `texts | categories | ${name}`,
			site: "texts",
			rawTexts: TEXTS_GOOD.rawTexts,
			categories: text,
		});
		list.push({
			label: `reminders | ${name}`,
			site: "reminders",
			accounts: text,
		});

		for (const column of CASH_COLUMNS)
			list.push({
				label: `cash | ${column} | ${name}`,
				site: "cash",
				texts: { ...CASH_GOOD, [column]: text },
			});
	}

	for (const [name, accounts] of ACCOUNTS_EXTRA)
		list.push({ label: `reminders | ${name}`, site: "reminders", accounts });

	// The cash row's entries the SQL writes: payments and plans with the fields the restore reads, and an entry each side.
	const extra: [string, Partial<CashTexts>][] = [
		["payments empty", { payment_rows: "[]" }],
		[
			"payments with two entries",
			{
				payment_rows:
					'[{"id":3,"transaction_id":7,"status":"linked","bill_name":"Rent"},{"id":4,"transaction_id":7,"status":"planned","bill_name":"Gas"}]',
			},
		],
		[
			"payments with an unlinked entry",
			{
				payment_rows:
					'[{"id":3,"transaction_id":7,"status":"unlinked","bill_name":"Rent"}]',
			},
		],
		[
			"payment row with id and bill_name only",
			{ payment_rows: '[{"id":3,"bill_name":"Rent"}]' },
		],
		[
			"split row and refund row",
			{
				split_rows: '[{"id":8,"parent_id":7,"amount_cents":-500}]',
				refund_rows: '[{"id":9,"refund_of_id":7,"amount_cents":500}]',
			},
		],
		["plans empty", { plan_rows: "[]" }],
		[
			"plan with extra key",
			{ plan_rows: '[{"id":9,"transaction_id":7,"month":"2026-11"}]' },
		],
		["plan missing transaction_id", { plan_rows: '[{"id":9}]' }],
		[
			"transaction with Infinity amount",
			{
				transaction_row: TRANSACTION_GOOD.replace(
					'"amount_cents":-1250',
					'"category_confidence":1e999',
				),
			},
		],
		[
			"transaction with -Infinity",
			{
				transaction_row: TRANSACTION_GOOD.replace(
					'"amount_cents":-1250',
					'"category_confidence":-1e999',
				),
			},
		],
		[
			"transaction with __proto__ key",
			{
				transaction_row: TRANSACTION_GOOD.replace("{", '{"__proto__":{"x":1},'),
			},
		],
		[
			"transaction with a 2000-deep value",
			{
				transaction_row: TRANSACTION_GOOD.replace(
					'"kind":null',
					`"kind":${nest(2000, "[", "]")}`,
				),
			},
		],
		[
			"transaction with a 5000-deep value",
			{
				transaction_row: TRANSACTION_GOOD.replace(
					'"kind":null',
					`"kind":${nest(5000, "[", "]")}`,
				),
			},
		],
		["transaction with BOM", { transaction_row: `﻿${TRANSACTION_GOOD}` }],
	];

	for (const [name, change] of extra)
		list.push({
			label: `cash | ${name}`,
			site: "cash",
			texts: { ...CASH_GOOD, ...change },
		});

	return list;
}

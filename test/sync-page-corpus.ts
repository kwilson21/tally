// Inputs for the two Plaid answers the sync reads (#1152): a bank's accounts (`/accounts/get`) and one page of its changes
// (`/transactions/sync`). Each case gives one field one odd value on top of a good answer. Pure data: the characterise test
// runs each case through the real syncItem and compares the outcome with fixtures/sync-page-baseline.json, recorded on the
// code before the page and the accounts were read with Effect Schema. An `undefined` field is left out of the JSON, as
// Plaid leaves a field out. Every id and name here is made up.

export type SyncCase = {
	label: string;
	/** The accounts answer's JSON text, or absent for one good account. */
	accounts?: string;
	/** The page's JSON text, or absent for the good page with `transaction` as its one added charge. */
	page?: string;
	/** The one added charge; absent is a good one. */
	transaction?: Record<string, unknown>;
	/** The charge goes in `modified` (after an earlier sync stored it) instead of `added`. */
	modified?: boolean;
};

const nest = (depth: number, open: string, close: string) =>
	open.repeat(depth) + close.repeat(depth);

export const GOOD_ACCOUNT = {
	account_id: "account-1",
	name: "Everyday",
	mask: "1234",
	type: "depository",
	subtype: "checking",
	balances: { current: 12.34 },
};

export const GOOD_TRANSACTION = {
	transaction_id: "transaction-1",
	account_id: "account-1",
	date: "2026-09-27",
	amount: 12.34,
	name: "RAW SHOP",
	merchant_name: "Shop",
	pending: false,
	pending_transaction_id: null,
	personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "X" },
};

export const GOOD_PAGE = {
	added: [GOOD_TRANSACTION],
	modified: [],
	removed: [],
	next_cursor: "cursor-1",
	has_more: false,
	transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
};

/** The odd values one field takes. `undefined` leaves the field out. */
const ODD: [string, unknown][] = [
	["missing", undefined],
	["null", null],
	["number", 5],
	["zero", 0],
	["text", "x"],
	["empty text", ""],
	["true", true],
	["false", false],
	["empty array", []],
	["empty object", {}],
	["deep array", "DEEP"],
];

const oddValue = (value: unknown) =>
	value === "DEEP" ? JSON.parse(nest(150, "[", "]")) : value;

const withField = (
	base: Record<string, unknown>,
	field: string,
	value: unknown,
) => ({ ...base, [field]: oddValue(value) });

const TRANSACTION_FIELDS = [
	"transaction_id",
	"account_id",
	"date",
	"amount",
	"name",
	"merchant_name",
	"pending",
	"pending_transaction_id",
	"personal_finance_category",
];

const ACCOUNT_FIELDS = [
	"account_id",
	"name",
	"mask",
	"type",
	"subtype",
	"balances",
];

// has_more true would ask for another page, and a text such as "false" is true, so the page's has_more is left at false
// or taken out; its other fields take every odd value.
const PAGE_FIELDS = [
	"added",
	"modified",
	"removed",
	"next_cursor",
	"has_more",
	"transactions_update_status",
];

const pageWith = (field: string, value: unknown) =>
	JSON.stringify(withField(GOOD_PAGE, field, value));

const accountsWith = (account: unknown) =>
	JSON.stringify({ accounts: [account] });

export const syncCases = (): SyncCase[] => {
	const out: SyncCase[] = [{ label: "good" }];

	for (const field of PAGE_FIELDS)
		for (const [name, value] of ODD) {
			if (field === "has_more" && (value === true || value === "x")) continue;

			if (field === "has_more" && (name === "number" || name === "deep array"))
				continue;

			if (
				field === "has_more" &&
				(name === "empty array" || name === "empty object")
			)
				continue;

			out.push({
				label: `page | ${field} | ${name}`,
				page: pageWith(field, value),
			});
		}

	for (const field of TRANSACTION_FIELDS)
		for (const [name, value] of ODD) {
			out.push({
				label: `added | ${field} | ${name}`,
				transaction: withField(GOOD_TRANSACTION, field, value),
			});
			out.push({
				label: `modified | ${field} | ${name}`,
				transaction: withField(GOOD_TRANSACTION, field, value),
				modified: true,
			});
		}

	for (const field of ACCOUNT_FIELDS)
		for (const [name, value] of ODD)
			out.push({
				label: `account | ${field} | ${name}`,
				accounts: accountsWith(withField(GOOD_ACCOUNT, field, value)),
			});

	const extra: SyncCase[] = [
		{
			label: "charge | amount | text number",
			transaction: { ...GOOD_TRANSACTION, amount: "12.34" },
		},
		{
			label: "charge | amount | 1e999",
			page: '{"added":[{"transaction_id":"transaction-1","account_id":"account-1","date":"2026-09-27","amount":1e999,"name":"X","pending":false}],"modified":[],"removed":[],"next_cursor":"c","has_more":false}',
		},
		{
			label: "charge | amount | 1e13",
			transaction: { ...GOOD_TRANSACTION, amount: 1e13 },
		},
		{
			label: "charge | amount | three decimals",
			transaction: { ...GOOD_TRANSACTION, amount: 1.005 },
		},
		{
			label: "charge | amount | negative",
			transaction: { ...GOOD_TRANSACTION, amount: -3.5 },
		},
		{
			label: "charge | date | not a date",
			transaction: { ...GOOD_TRANSACTION, date: "not a date" },
		},
		{
			label: "charge | account | unknown",
			transaction: { ...GOOD_TRANSACTION, account_id: "account-9" },
		},
		{
			label: "charge | category | primary a number",
			transaction: {
				...GOOD_TRANSACTION,
				personal_finance_category: { primary: 5 },
			},
		},
		{
			label: "charge | category | detailed null",
			transaction: {
				...GOOD_TRANSACTION,
				personal_finance_category: { primary: "FOOD", detailed: null },
			},
		},
		{
			label: "charge | category | empty object",
			transaction: { ...GOOD_TRANSACTION, personal_finance_category: {} },
		},
		{
			label: "charge | extra fields",
			transaction: { ...GOOD_TRANSACTION, extra: { a: [1, { b: null }] } },
		},
		{
			label: "charge | name | 2MB",
			transaction: { ...GOOD_TRANSACTION, name: "a".repeat(2_000_000) },
		},
		{
			label: "charge | name | lone surrogate",
			transaction: { ...GOOD_TRANSACTION, name: "\ud800" },
		},
		{
			label: "page | extra fields",
			page: JSON.stringify({ ...GOOD_PAGE, extra: { a: [1, 2] } }),
		},
		{
			label: "page | __proto__ key",
			page: `{"__proto__":{"added":null},"added":[],"modified":[],"removed":[],"next_cursor":"c","has_more":false}`,
		},
		{
			label: "page | duplicate added, the bad one last",
			page: `{"added":[],"added":null,"modified":[],"removed":[],"next_cursor":"c","has_more":false}`,
		},
		{
			label: "page | depth 5000 in an extra field",
			page: `{"added":[],"modified":[],"removed":[],"next_cursor":"c","has_more":false,"x":${nest(5000, "[", "]")}}`,
		},
		{ label: "page | JSON null", page: "null" },
		{ label: "page | JSON array", page: "[]" },
		{ label: "page | JSON number", page: "5" },
		{ label: "page | JSON text", page: '"page"' },
		{ label: "page | JSON true", page: "true" },
		{ label: "page | empty object", page: "{}" },
		{
			label: "page | all lists empty",
			page: JSON.stringify({ ...GOOD_PAGE, added: [] }),
		},
		{
			label: "page | added holds null",
			page: JSON.stringify({ ...GOOD_PAGE, added: [null] }),
		},
		{
			label: "page | added holds text",
			page: JSON.stringify({ ...GOOD_PAGE, added: ["x"] }),
		},
		{
			label: "page | added holds an array",
			page: JSON.stringify({ ...GOOD_PAGE, added: [[]] }),
		},
		{
			label: "page | added holds a charge twice",
			page: JSON.stringify({
				...GOOD_PAGE,
				added: [GOOD_TRANSACTION, GOOD_TRANSACTION],
			}),
		},
		{
			label: "page | removed holds null",
			page: JSON.stringify({ ...GOOD_PAGE, added: [], removed: [null] }),
		},
		{
			label: "page | removed holds text",
			page: JSON.stringify({
				...GOOD_PAGE,
				added: [],
				removed: ["transaction-1"],
			}),
		},
		{
			label: "page | removed holds an empty object",
			page: JSON.stringify({ ...GOOD_PAGE, added: [], removed: [{}] }),
		},
		{
			label: "page | removed holds an id of a number",
			page: JSON.stringify({
				...GOOD_PAGE,
				added: [],
				removed: [{ transaction_id: 5 }],
			}),
		},
		{
			label: "page | removed holds an id of null",
			page: JSON.stringify({
				...GOOD_PAGE,
				added: [],
				removed: [{ transaction_id: null }],
			}),
		},
		{
			label: "page | removed holds a charge",
			page: JSON.stringify({
				...GOOD_PAGE,
				added: [],
				removed: [{ transaction_id: "transaction-1" }],
			}),
		},
		{
			label: "page | modified holds null",
			page: JSON.stringify({ ...GOOD_PAGE, added: [], modified: [null] }),
		},
		{
			label: "page | has_more 0",
			page: JSON.stringify({ ...GOOD_PAGE, has_more: 0 }),
		},
		{
			label: "page | has_more empty text",
			page: JSON.stringify({ ...GOOD_PAGE, has_more: "" }),
		},
		{ label: "accounts | JSON null", accounts: "null" },
		{ label: "accounts | JSON array", accounts: "[]" },
		{ label: "accounts | JSON text", accounts: '"accounts"' },
		{ label: "accounts | empty object", accounts: "{}" },
		{ label: "accounts | accounts null", accounts: '{"accounts":null}' },
		{ label: "accounts | accounts text", accounts: '{"accounts":"x"}' },
		{ label: "accounts | accounts an object", accounts: '{"accounts":{}}' },
		{ label: "accounts | accounts empty", accounts: '{"accounts":[]}' },
		{ label: "accounts | holds null", accounts: '{"accounts":[null]}' },
		{ label: "accounts | holds text", accounts: '{"accounts":["x"]}' },
		{
			label: "accounts | holds the account twice",
			accounts: JSON.stringify({ accounts: [GOOD_ACCOUNT, GOOD_ACCOUNT] }),
		},
		{
			label: "accounts | a credit card",
			accounts: accountsWith({ ...GOOD_ACCOUNT, type: "credit" }),
		},
		{
			label: "accounts | balance 1e999",
			accounts: `{"accounts":[{"account_id":"account-1","name":"E","type":"depository","balances":{"current":1e999}}]}`,
		},
		{
			label: "accounts | balance text number",
			accounts: accountsWith({ ...GOOD_ACCOUNT, balances: { current: "1" } }),
		},
		{
			label: "accounts | balance null",
			accounts: accountsWith({ ...GOOD_ACCOUNT, balances: { current: null } }),
		},
		{
			label: "accounts | balances empty",
			accounts: accountsWith({ ...GOOD_ACCOUNT, balances: {} }),
		},
		{
			label: "accounts | extra fields",
			accounts: accountsWith({ ...GOOD_ACCOUNT, extra: { a: [1] } }),
		},
		{
			label: "accounts | depth 5000 in an extra field",
			accounts: `{"accounts":[{"account_id":"account-1","name":"E","type":"depository","balances":{},"x":${nest(5000, "[", "]")}}]}`,
		},
	];

	return [...out, ...extra];
};

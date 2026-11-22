// Inputs for the two records the re-sort keeps as stored JSON (#1150): the run (`resort_run`) and a run's moved record
// (`resort_moved_<id>`), read by readRun and readMoved in src/db/resort-run.ts. Each case gives one read an odd text, or one
// key or nested key an odd value on top of a good record. Pure data: the characterise test stores each text and reads it
// back, and compares the answer with fixtures/resort-stored-baseline.json, recorded on the code before the two reads moved
// from the hand guards to Effect Schema. Every id and name here is made up.

import type { Json } from "../src/json";
import { ODD as ODD_TEXTS } from "./held-json-corpus";

export type ResortStoredCase = {
	label: string;
	site: "run" | "moved";
	/** The stored text. */
	text: string;
};

type Field = Json | undefined | Fields | Field[];

type Fields = { [key: string]: Field };

const SNAPSHOT = {
	id: 7,
	category_id: 3,
	category_source: "jev",
	category_confidence: 0.4,
	jev_category_id: 3,
	jev_none_fit: 0,
	jev_mixed: null,
	jev_also_category_id: null,
	jev_failed_at: null,
	jev_attempts: 1,
	plaid_transaction_id: "plaid-7",
	amount_cents: 1250,
} satisfies Fields;

const CATEGORY = { id: 3, name: "Groceries" } satisfies Fields;

const BY_CATEGORY = { id: 3, name: "Groceries", count: 2 } satisfies Fields;

const MOVED_ROW = {
	id: 7,
	categoryId: 3,
	plaid_transaction_id: "plaid-7",
	amount_cents: 1250,
	snapshot: SNAPSHOT,
} satisfies Fields;

export const GOOD_RUN = {
	id: "run-1",
	total: 2,
	done: 1,
	status: "running",
	instances: 2,
	ids: [7, 8],
	snapshots: [SNAPSHOT],
	categoryId: 3,
	categoryName: "Groceries",
	categories: [CATEGORY],
	categoryByRow: { "7": 3, "8": 3 },
	finishedKeys: ["a"],
	keptCleared: [8],
	startedAt: 1_700_000_000_000,
	toasted: false,
	finishToken: "token-1",
} satisfies Fields;

export const GOOD_MOVED = {
	runId: "run-1",
	categoryId: 3,
	categoryName: "Groceries",
	categories: ["Groceries"],
	byCategory: [BY_CATEGORY],
	claimedAt: null,
	until: null,
	finalizedAt: 1_700_000_100_000,
	rows: [MOVED_ROW],
	needAnswer: 0,
} satisfies Fields;

/** The odd values one key takes. `undefined` leaves the key out; the two sentinels become numbers JSON.stringify cannot write. */
const ODD: [string, Field][] = [
	["missing", undefined],
	["null", null],
	["number", 5],
	["zero", 0],
	["negative", -1],
	["text", "x"],
	["empty text", ""],
	["true", true],
	["false", false],
	["empty array", []],
	["array of number", [1]],
	["array of text", ["a"]],
	["empty object", {}],
	["object of number", { a: 1 }],
	["object of text", { a: "x" }],
	["infinity", "__INFINITY__"],
	["negative zero", "__NEGATIVE_ZERO__"],
	["fraction", 1.5],
	["above 2^53", 9007199254740993],
];

const encode = (value: Fields) =>
	JSON.stringify(value)
		.replaceAll('"__INFINITY__"', "1e999")
		.replaceAll('"__NEGATIVE_ZERO__"', "-0");

const withKey = (base: Fields, key: string, value: Field) => ({
	...base,
	[key]: value,
});

const RUN_KEYS = Object.keys(GOOD_RUN);

const MOVED_KEYS = Object.keys(GOOD_MOVED);

const SNAPSHOT_KEYS = Object.keys(SNAPSHOT);

export const resortStoredCases = (): ResortStoredCase[] => {
	const out: ResortStoredCase[] = [
		{ label: "run | good", site: "run", text: encode(GOOD_RUN) },
		{ label: "moved | good", site: "moved", text: encode(GOOD_MOVED) },
	];

	for (const [name, text] of ODD_TEXTS) {
		out.push({ label: `run | text | ${name}`, site: "run", text });
		out.push({ label: `moved | text | ${name}`, site: "moved", text });
	}

	const onKey = (
		site: "run" | "moved",
		label: string,
		build: (value: Field) => Fields,
	) => {
		for (const [name, value] of ODD)
			out.push({
				label: `${site} | ${label} | ${name}`,
				site,
				text: encode(build(value)),
			});
	};

	for (const key of RUN_KEYS)
		onKey("run", key, (value) => withKey(GOOD_RUN, key, value));

	for (const key of MOVED_KEYS)
		onKey("moved", key, (value) => withKey(GOOD_MOVED, key, value));

	for (const key of SNAPSHOT_KEYS) {
		onKey("run", `snapshots[0].${key}`, (value) =>
			withKey(GOOD_RUN, "snapshots", [withKey(SNAPSHOT, key, value)]),
		);
		onKey("moved", `rows[0].snapshot.${key}`, (value) =>
			withKey(GOOD_MOVED, "rows", [
				{ ...MOVED_ROW, snapshot: withKey(SNAPSHOT, key, value) },
			]),
		);
	}

	for (const key of ["id", "name"])
		onKey("run", `categories[0].${key}`, (value) =>
			withKey(GOOD_RUN, "categories", [withKey(CATEGORY, key, value)]),
		);

	for (const key of ["id", "name", "count"])
		onKey("moved", `byCategory[0].${key}`, (value) =>
			withKey(GOOD_MOVED, "byCategory", [withKey(BY_CATEGORY, key, value)]),
		);

	for (const key of [
		"id",
		"categoryId",
		"plaid_transaction_id",
		"amount_cents",
		"snapshot",
	])
		onKey("moved", `rows[0].${key}`, (value) =>
			withKey(GOOD_MOVED, "rows", [withKey(MOVED_ROW, key, value)]),
		);

	// Items of the lists that are the wrong type, and lists of more than one item.
	for (const [name, value] of ODD) {
		out.push({
			label: `run | ids holds | ${name}`,
			site: "run",
			text: encode(withKey(GOOD_RUN, "ids", [7, value])),
		});
		out.push({
			label: `run | finishedKeys holds | ${name}`,
			site: "run",
			text: encode(withKey(GOOD_RUN, "finishedKeys", ["a", value])),
		});
		out.push({
			label: `run | snapshots holds | ${name}`,
			site: "run",
			text: encode(withKey(GOOD_RUN, "snapshots", [SNAPSHOT, value])),
		});
		out.push({
			label: `run | categories holds | ${name}`,
			site: "run",
			text: encode(
				withKey(GOOD_RUN, "categories", [{ id: 3, name: "G" }, value]),
			),
		});
		out.push({
			label: `run | categoryByRow value | ${name}`,
			site: "run",
			text: encode(withKey(GOOD_RUN, "categoryByRow", { "7": 3, "8": value })),
		});
		out.push({
			label: `moved | rows holds | ${name}`,
			site: "moved",
			text: encode(withKey(GOOD_MOVED, "rows", [MOVED_ROW, value])),
		});
		out.push({
			label: `moved | categories holds | ${name}`,
			site: "moved",
			text: encode(withKey(GOOD_MOVED, "categories", ["G", value])),
		});
	}

	out.push(
		{
			label: "run | extra key",
			site: "run",
			text: encode({ ...GOOD_RUN, extra: { a: [1] } }),
		},
		{
			label: "moved | extra key",
			site: "moved",
			text: encode({ ...GOOD_MOVED, extra: { a: [1] } }),
		},
		{
			label: "run | __proto__ key",
			site: "run",
			text: `{"__proto__":{"id":1},${encode(GOOD_RUN).slice(1)}`,
		},
		{
			label: "moved | __proto__ key",
			site: "moved",
			text: `{"__proto__":{"runId":1},${encode(GOOD_MOVED).slice(1)}`,
		},
		{
			label: "run | categoryByRow has a __proto__ entry",
			site: "run",
			text: encode(GOOD_RUN).replace(
				'"categoryByRow":{',
				'"categoryByRow":{"__proto__":4,',
			),
		},
		{
			label: "run | categoryByRow has a __proto__ entry of text",
			site: "run",
			text: encode(GOOD_RUN).replace(
				'"categoryByRow":{',
				'"categoryByRow":{"__proto__":"x",',
			),
		},
		{
			label: "run | duplicate id, the bad one last",
			site: "run",
			text: encode(GOOD_RUN).replace('"id":"run-1"', '"id":"run-1","id":5'),
		},
		{
			label: "run | duplicate id, the bad one first",
			site: "run",
			text: encode(GOOD_RUN).replace('"id":"run-1"', '"id":5,"id":"run-1"'),
		},
		{
			label: "run | status done",
			site: "run",
			text: encode(withKey(GOOD_RUN, "status", "done")),
		},
		{
			label: "run | status in capitals",
			site: "run",
			text: encode(withKey(GOOD_RUN, "status", "DONE")),
		},
		{
			label: "run | no optional keys",
			site: "run",
			text: encode(
				withKey(
					withKey(
						withKey(GOOD_RUN, "keptCleared", undefined),
						"finishToken",
						undefined,
					),
					"snapshots",
					[withKey(SNAPSHOT, "jev_attempts", undefined)],
				),
			),
		},
		{
			label: "moved | claimed",
			site: "moved",
			text: encode(withKey(withKey(GOOD_MOVED, "claimedAt", 5), "until", 15)),
		},
		{
			label: "run | 10k ids",
			site: "run",
			text: encode(
				withKey(
					GOOD_RUN,
					"ids",
					Array.from({ length: 10_000 }, (_, i) => i),
				),
			),
		},
		{
			label: "run | depth 5000 in an extra key",
			site: "run",
			text: encode(GOOD_RUN).replace(
				/}$/,
				`,"x":${"[".repeat(5000)}${"]".repeat(5000)}}`,
			),
		},
	);

	return out;
};

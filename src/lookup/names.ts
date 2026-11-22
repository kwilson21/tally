// The names' side of the store's line (spec §7, "Where the line goes" and "The wait"; decisions 216 and 225): which asked
// stores a name waits for, which bank texts may be asked with a line, the read made just before each call, and the save
// guard for an answer asked with one. Plain TypeScript with SQL fragments, as line.ts is; the lookup itself is run.ts.

import { type AiSwitches, STILL_ON_SQL } from "../db/ai-switches";
import { SWITCHES_ON } from "../db/store-lookups";
import { qualifies } from "./claims";
import { readEligibility } from "./eligibility";
import { lookupAsks } from "./gate";
import { type LineGuard, lineStandsSql } from "./line";
import { lookupTextOf } from "./lookup-text";

type GateEnv = { DEMO?: string; TAVILY_API_KEY?: string };

/**
 * The lookup texts whose names wait (spec §7, "The wait"): pending, and the run would still search them (qualifies), so a
 * rule, a private row or a switch never holds a name back. No statement when the gate is closed.
 */
export async function waitingLookupTexts(
	env: GateEnv,
	db: D1Database,
	switches: AiSwitches,
): Promise<string[]> {
	if (!lookupAsks(env, switches)) return [];

	// stays raw: the pending rows are read once, and no cap applies (decision 209)
	const { results } = await db
		.prepare(
			"SELECT lookup_text AS text FROM merchant_lookups WHERE status = 'pending'",
		)
		.all<{ text: string }>();

	if (results.length === 0) return [];

	const texts = results.map((row) => row.text);
	const verdicts = await readEligibility(db, { lookupTexts: texts });

	return texts.filter((text) => qualifies(env, switches, verdicts.get(text)));
}

/**
 * The bank texts among `rawNames` whose store has a line that stands, with that store's lookup text. A map row whose text
 * is not the key's own lookup text (lookupTextOf) is left out. No statement when the gate is closed or there are no names.
 */
export async function linedNames(
	env: GateEnv,
	db: D1Database,
	switches: AiSwitches,
	rawNames: string[],
): Promise<Map<string, string>> {
	if (rawNames.length === 0 || !lookupAsks(env, switches)) return new Map();

	// stays raw: a set of at most one run's names, read once (decision 209)
	const { results } = await db
		.prepare(
			`SELECT k.merchant_key AS rawName, k.lookup_text AS text FROM merchant_lookup_texts k
			 WHERE k.merchant_key IN (SELECT value FROM json_each(?)) AND ${lineStandsSql("k.lookup_text")}`,
		)
		.bind(JSON.stringify(rawNames))
		.all<{ rawName: string; text: string }>();

	return new Map(
		results
			.filter((row) => lookupTextOf(row.rawName) === row.text)
			.map((row) => [row.rawName, row.text]),
	);
}

/**
 * The line of a lookup text as it stands at this call: the line, or null when it no longer stands (spec §7:248). The
 * spec asks for this read immediately before each name call, not once for the run, which is why the caller reads it
 * inside its loop despite decision 209.
 */
export async function readLineForName(
	db: D1Database,
	text: string,
): Promise<string | null> {
	// stays raw: a single row read per call, by the lookup text (decision 179)
	const row = await db
		.prepare(
			`SELECT ml.line AS line FROM merchant_lookups ml WHERE ml.lookup_text = ?
			 AND ${lineStandsSql("ml.lookup_text")} AND ${STILL_ON_SQL}`,
		)
		.bind(text, SWITCHES_ON)
		.first<{ line: string | null }>();

	return row?.line ?? null;
}

/**
 * The save guard for a batch of name answers: an answer asked with a line (its `lineText`, the lookup text it was asked
 * with) lands only while that line still stands and the switches are on. An answer asked without one is unguarded.
 */
export function nameLineGuard(): LineGuard {
	const text = "json_extract(a.value, '$.lineText')";

	// stays raw: a fragment inlined into the names' save statements (decision 179)
	return {
		sql: `(${text} IS NULL OR (${lineStandsSql(text)} AND ${STILL_ON_SQL}))`,
		binds: [SWITCHES_ON],
	};
}

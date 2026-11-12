import { describe, expect, it } from "vitest";
import {
	type UndoFacts,
	type UndoMovedRow,
	undoResort,
} from "../src/rules/sorting";
import { answerOf, refuse, write } from "./helpers/rule-answers";

// The sorting area's rule as stories (decisions 187, 206, 209): each row is what was asked, what was stored, and what
// the rule answers. The time is an input (decision 195); nothing here touches a clock or a database.

const NOW = 1_800_000_000_000;
const GROCERIES = 1;
const EATING_OUT = 2;

/** A row a run moved into Groceries, with the snapshot Undo puts back. */
const moved = (id: number): UndoMovedRow => ({
	id,
	categoryId: GROCERIES,
	plaidId: `plaid-${id}`,
	amountCents: 1000 + id,
	snapshot: {
		id,
		category_id: null,
		category_source: null,
		category_confidence: 0.3,
		jev_category_id: null,
		jev_none_fit: 0,
		jev_mixed: null,
		jev_also_category_id: null,
		jev_failed_at: null,
		jev_attempts: 0,
		plaid_transaction_id: `plaid-${id}`,
		amount_cents: 1000 + id,
	},
});

/** The same row as the transactions table holds it now, still as the run left it unless something is changed. */
const stillThere = (
	id: number,
	changed: Partial<UndoFacts["now"][number]> = {},
) => ({
	id,
	categoryId: GROCERIES,
	source: "jev",
	plaidId: `plaid-${id}`,
	amountCents: 1000 + id,
	...changed,
});

const facts = (over: Partial<UndoFacts> = {}): UndoFacts => ({
	record: { until: NOW + 5000, rows: [moved(7), moved(8)] },
	now: [stillThere(7), stillThere(8)],
	version: "v1",
	...over,
});

const ask = (stored: UndoFacts) =>
	answerOf(undoResort.decide({ runId: "run-1", now: NOW }, stored));

const putsBack = (ids: number[], changedSince: number) =>
	write({
		runId: "run-1",
		now: NOW,
		restore: ids.map((id) => moved(id).snapshot),
		changedSince,
		expectedVersion: "v1",
	});

const TOO_LATE = refuse("UndoExpired", "Too late to undo that.");

describe("Undo a re-check", () => {
	it.each([
		["puts every moved row back", facts(), putsBack([7, 8], 0)],
		[
			"puts back on the last moment the Undo is open",
			facts({ record: { until: NOW, rows: [moved(7)] }, now: [stillThere(7)] }),
			putsBack([7], 0),
		],
		[
			"leaves a row a person has since filed somewhere else",
			facts({
				now: [stillThere(7), stillThere(8, { categoryId: EATING_OUT })],
			}),
			putsBack([7], 1),
		],
		[
			"leaves a row a person has since confirmed in the same category",
			facts({ now: [stillThere(7, { source: "manual" }), stillThere(8)] }),
			putsBack([8], 1),
		],
		[
			"leaves a row that was deleted",
			facts({ now: [stillThere(8)] }),
			putsBack([8], 1),
		],
		[
			"leaves a row whose id another purchase now has (a different bank id)",
			facts({ now: [stillThere(7, { plaidId: "another" }), stillThere(8)] }),
			putsBack([8], 1),
		],
		[
			"leaves a row whose id another purchase now has (a different amount)",
			facts({ now: [stillThere(7, { amountCents: 5 }), stillThere(8)] }),
			putsBack([8], 1),
		],
		[
			"puts nothing back when every row changed, and still closes the Undo",
			facts({ now: [] }),
			putsBack([], 2),
		],
		["refuses when the run has no record", facts({ record: null }), TOO_LATE],
		[
			"refuses when the closing toast was never claimed",
			facts({ record: { until: null, rows: [moved(7)] } }),
			TOO_LATE,
		],
		[
			"refuses once the ten seconds have passed",
			facts({ record: { until: NOW - 1, rows: [moved(7)] } }),
			TOO_LATE,
		],
	])("%s", (_story, stored, answer) => {
		expect(ask(stored)).toEqual(answer);
	});
});

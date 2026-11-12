// The sorting area's rule (decisions 187, 206 and 209): undo a re-check. It takes the run's id and the time, the rows
// the run moved and those rows as they stand now, and decides for each row whether it goes back. The time is an input
// (decision 195), and nothing here parses, reads a clock or touches the database. The save's guard is in
// src/db/resort-run.ts (decision 190).
import * as Data from "effect/Data";
import type { RunSnapshot } from "../db/resort-run";
import { TOO_LATE_TO_UNDO } from "../resort-toast";
import { rule, term, unless } from "./terms";

/** A row a run moved: the category it went to, the purchase it is (its bank id and amount), and what it was before. */
export type UndoMovedRow = {
	id: number;
	categoryId: number;
	plaidId: string | null;
	amountCents: number;
	snapshot: RunSnapshot;
};

export type UndoFacts = {
	/** The run's record of what it moved, or null when there is none. `until` is null until the closing toast is claimed. */
	record: { until: number | null; rows: UndoMovedRow[] } | null;
	/** The moved rows as the transactions table holds them now. A deleted row is not here. */
	now: {
		id: number;
		categoryId: number | null;
		source: string | null;
		plaidId: string | null;
		amountCents: number;
	}[];
	/** Stands for the record and those rows as they were read. A save lands only while they still have this version. */
	version: string;
};

/** What the rule saves: each row's earlier state to put back, and the count of rows left where they are. */
export type UndoWrite = {
	runId: string;
	/** The time of the Undo (ms), written as each restored row's updated_at. */
	now: number;
	restore: RunSnapshot[];
	changedSince: number;
	expectedVersion: string;
};

export class UndoExpired extends Data.TaggedError("UndoExpired") {
	readonly say = TOO_LATE_TO_UNDO;
}

/**
 * Whether a moved row still reads as the run left it: it is the same purchase (a deleted row's id that another purchase
 * reused is not), it is still in the category the run moved it to, and Jev is still the source, so no person has
 * answered it since.
 */
const asTheRunLeftIt = (row: UndoMovedRow, now: UndoFacts["now"]) =>
	now.some(
		(t) =>
			t.id === row.id &&
			t.plaidId === row.plaidId &&
			t.amountCents === row.amountCents &&
			t.categoryId === row.categoryId &&
			t.source === "jev",
	);

// Every Undo closes the run's record, so the rule names no nothing-to-do term: a second press finds no record.
export const undoResort = rule({
	name: "Undo a re-check",
	given: (request: { runId: string; now: number }, facts: UndoFacts) => {
		const rows = facts.record?.rows ?? [];
		const restore = rows.filter((row) => asTheRunLeftIt(row, facts.now));

		return {
			...request,
			open:
				facts.record !== null &&
				facts.record.until !== null &&
				facts.record.until >= request.now,
			restore: restore.map((row) => row.snapshot),
			changedSince: rows.length - restore.length,
			version: facts.version,
		};
	},
	refusals: [
		unless(
			term<{ open: boolean }>(
				"the run's Undo is still open: its closing toast was claimed and its ten seconds have not passed",
				(g) => g.open,
			),
			() => new UndoExpired(),
		),
	],
	writes: (g): UndoWrite => ({
		runId: g.runId,
		now: g.now,
		restore: g.restore,
		changedSince: g.changedSince,
		expectedVersion: g.version,
	}),
	writesText:
		"Puts back each moved row that still reads as the run left it, leaves the rest, and closes the run's Undo.",
});

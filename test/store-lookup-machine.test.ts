import { describe, expect, it } from "vitest";
import { transition } from "xstate";
import { next } from "../src/machines/next";
import {
	STORE_LOOKUP_ROWS,
	STORE_LOOKUP_STATUS_VALUES,
	storeLookupMachine,
	storeLookupState,
} from "../src/machines/store-lookup";

// The store lookup's state machine (style 1, XState alone). Every move is listed here; every other state and event
// pair is refused. A claimed row whose lease is over or whose run lets go keeps its attempts: only a failed search counts.

const STATES = Object.keys(storeLookupMachine.config.states ?? {});

const EVENTS = [
	"PRIVATE",
	"CLAIM",
	"SAVE_FOUND",
	"SAVE_NOTHING",
	"SEARCH_FAILED",
	"LEASE_EXPIRED",
	"LET_GO",
	"DONT_USE",
];

// Every move the machine allows, as [from, event, to]. The attempts count is given where it matters.
const MOVES: [string, string, string][] = [
	["none", "PRIVATE", "skipped"],
	["none", "CLAIM", "claimed"],
	["claimed", "SAVE_FOUND", "found"],
	["claimed", "SAVE_NOTHING", "nothing_found"],
	["claimed", "SEARCH_FAILED", "to_retry"],
	["claimed", "LEASE_EXPIRED", "to_retry"],
	["claimed", "LET_GO", "to_retry"],
	["to_retry", "CLAIM", "claimed"],
	["to_retry", "PRIVATE", "skipped"],
	["found", "DONT_USE", "skipped"],
	["found", "PRIVATE", "skipped"],
];

const attemptsAt = (attempts: number) => ({ attempts });

/**
 * One move, read back through the machine's own transition: the state it lands in, and the attempts the context holds
 * after it. Unlike next(), this sees the context a transition assigns, so a change to attempts fails a test.
 */
function move(state: string, attempts: number, event: string) {
	const current = storeLookupMachine.resolveState({
		value: state,
		context: { attempts },
	});

	const [after] = transition(storeLookupMachine, current, { type: event });

	return { state: String(after.value), attempts: after.context.attempts };
}

describe("store lookup machine: the listed moves", () => {
	for (const [from, event, to] of MOVES) {
		it(`${from} --${event}--> ${to}`, () => {
			expect(next(storeLookupMachine, from, event, attemptsAt(0))).toBe(to);
		});
	}
});

describe("store lookup machine: every other pair is refused", () => {
	const listed = new Set(MOVES.map(([from, event]) => `${from}|${event}`));

	it("refuses each state and event the machine does not list", () => {
		const allowed: string[] = [];

		for (const state of STATES) {
			for (const event of EVENTS) {
				// Claimed and to_retry rows with attempts 0 cover the search-failed cases below.
				const result = next(storeLookupMachine, state, event, attemptsAt(0));

				if (result !== null) allowed.push(`${state}|${event}`);
			}
		}

		const unexpected = allowed.filter((pair) => !listed.has(pair));
		const missing = [...listed].filter((pair) => !allowed.includes(pair));

		expect(unexpected).toEqual([]);
		expect(missing).toEqual([]);
	});

	it("nothing leaves nothing_found, gave_up or skipped", () => {
		for (const state of ["nothing_found", "gave_up", "skipped"]) {
			for (const event of EVENTS) {
				expect(
					next(storeLookupMachine, state, event, attemptsAt(0)),
				).toBeNull();
			}
		}
	});
});

describe("store lookup machine: failed searches and attempts", () => {
	it("a first and second failure in a row go to to_retry, one more attempt each", () => {
		expect(
			next(storeLookupMachine, "claimed", "SEARCH_FAILED", attemptsAt(0)),
		).toBe("to_retry");
		expect(
			next(storeLookupMachine, "claimed", "SEARCH_FAILED", attemptsAt(1)),
		).toBe("to_retry");
	});

	it("the third failure in a row gives up", () => {
		expect(
			next(storeLookupMachine, "claimed", "SEARCH_FAILED", attemptsAt(2)),
		).toBe("gave_up");
	});

	it("three SEARCH_FAILED moves in a row end in gave_up", () => {
		let state = "claimed";
		let attempts = 0;

		for (let i = 0; i < 3; i++) {
			const after = next(
				storeLookupMachine,
				state,
				"SEARCH_FAILED",
				attemptsAt(attempts),
			);

			expect(after).not.toBeNull();
			state = after ?? state;
			attempts += 1;

			if (state === "to_retry") {
				// A retry is a new claim before the next failure.
				expect(
					next(storeLookupMachine, state, "CLAIM", attemptsAt(attempts)),
				).toBe("claimed");
				state = "claimed";
			}
		}

		expect(state).toBe("gave_up");
	});

	it("each failed search adds one to attempts, and the third gives up", () => {
		expect(move("claimed", 0, "SEARCH_FAILED")).toEqual({
			state: "to_retry",
			attempts: 1,
		});
		expect(move("claimed", 1, "SEARCH_FAILED")).toEqual({
			state: "to_retry",
			attempts: 2,
		});
		expect(move("claimed", 2, "SEARCH_FAILED")).toEqual({
			state: "gave_up",
			attempts: 3,
		});
	});

	it("LET_GO keeps attempts unchanged", () => {
		expect(move("claimed", 2, "LET_GO")).toEqual({
			state: "to_retry",
			attempts: 2,
		});
	});

	it("LEASE_EXPIRED keeps attempts unchanged", () => {
		expect(move("claimed", 1, "LEASE_EXPIRED")).toEqual({
			state: "to_retry",
			attempts: 1,
		});
	});

	it("a walk of claim, fail, claim, let go, claim, fail, claim, fail ends in gave_up with the right counts", () => {
		const steps = [
			["CLAIM", "claimed", 0],
			["SEARCH_FAILED", "to_retry", 1],
			["CLAIM", "claimed", 1],
			["LET_GO", "to_retry", 1],
			["CLAIM", "claimed", 1],
			["SEARCH_FAILED", "to_retry", 2],
			["CLAIM", "claimed", 2],
			["SEARCH_FAILED", "gave_up", 3],
		] as const;

		let at = { state: "none", attempts: 0 };

		for (const [event, state, attempts] of steps) {
			at = move(at.state, at.attempts, event);
			expect(at).toEqual({ state, attempts });
		}
	});
});

describe("store lookup machine: rows", () => {
	it("a found lookup that turns private is skipped", () => {
		expect(next(storeLookupMachine, "found", "PRIVATE", attemptsAt(0))).toBe(
			"skipped",
		);
	});

	it("every state has a row shape, and the statuses are the schema's", () => {
		expect(
			new Set(Object.values(STORE_LOOKUP_ROWS).map((r) => r.status)),
		).toEqual(new Set([...STORE_LOOKUP_STATUS_VALUES, null]));
	});

	it("a pending row is claimed while its lease runs, and to_retry after it", () => {
		const now = new Date("2026-11-13T10:10:00.000Z");

		expect(
			storeLookupState(
				{
					status: "pending",
					claimedBy: "run-a",
					claimedAt: "2026-11-13T10:05:00.000Z",
				},
				now,
			),
		).toBe("claimed");

		// 15-minute lease: started at 09:50, lease over at 10:05.
		expect(
			storeLookupState(
				{
					status: "pending",
					claimedBy: "run-a",
					claimedAt: "2026-11-13T09:50:00.000Z",
				},
				now,
			),
		).toBe("to_retry");
	});

	it("a pending row with no claim is to_retry", () => {
		const now = new Date("2026-11-13T10:10:00.000Z");

		expect(
			storeLookupState(
				{ status: "pending", claimedBy: null, claimedAt: null },
				now,
			),
		).toBe("to_retry");
	});

	it("reads each stored status back to its state, and no row to none", () => {
		const now = new Date("2026-11-13T10:10:00.000Z");

		expect(storeLookupState(null, now)).toBe("none");
		expect(
			storeLookupState(
				{ status: "found", claimedBy: null, claimedAt: null },
				now,
			),
		).toBe("found");
		expect(
			storeLookupState(
				{ status: "nothing_found", claimedBy: null, claimedAt: null },
				now,
			),
		).toBe("nothing_found");
		expect(
			storeLookupState(
				{ status: "skipped", claimedBy: null, claimedAt: null },
				now,
			),
		).toBe("skipped");
		expect(
			storeLookupState(
				{ status: "gave_up", claimedBy: null, claimedAt: null },
				now,
			),
		).toBe("gave_up");
	});
});

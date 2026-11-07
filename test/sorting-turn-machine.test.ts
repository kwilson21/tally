import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	parseSortingTurn,
	readSortingTurn,
	releaseSortingTurn,
	SORTING_TURN_MS,
	type SortingTurn,
	sortingTurnState,
	takeSortingTurn,
	takeSortingTurnStatement,
	turnHeldSql,
} from "../src/db/sorting-turn";
import { machineGraph } from "../src/machines/graph";
import { next } from "../src/machines/next";
import {
	SORTING_TURN_LABELS,
	sortingTurnMachine,
} from "../src/machines/sorting-turn";

// The sorting turn's rule is written once, in sortingTurnMachine. These tests keep the single statements in
// src/db/sorting-turn.ts in step with it: every state of the turn met with every event. "take" is another group's
// ask, so its rows are held by OTHER; "retake", "release" and "holds" are the holder's, so theirs are held by ME.

const db = env.DB;
const ME = "A";
const OTHER = "B";
const RESERVED = "sorting_turn_test_reservation";

type State = keyof typeof sortingTurnMachine.states;
const STATES = Object.keys(sortingTurnMachine.states) as State[];
const EVENTS = ["TAKE", "RETAKE", "RELEASE", "HOLDS", "EXPIRE"] as const;

/** The row a state is stored as when `holder` has it, at time `now`. Free is no row. */
function rowFor(
	state: State,
	holder: string,
	now = Date.now(),
): SortingTurn | null {
	if (state === "free") return null;
	return {
		id: holder,
		until: state === "held" ? now + SORTING_TURN_MS : now - 1000,
	};
}

async function seed(turn: SortingTurn | null) {
	await db
		.prepare("DELETE FROM household_settings WHERE key = 'sorting_turn'")
		.run();
	if (turn)
		await db
			.prepare(
				"INSERT INTO household_settings (key, value) VALUES ('sorting_turn', ?)",
			)
			.bind(JSON.stringify(turn.until === null ? { id: turn.id } : turn))
			.run();
}
const stateNow = async () =>
	sortingTurnState(await readSortingTurn(db), Date.now());

beforeEach(async () => {
	await db
		.prepare("DELETE FROM household_settings WHERE key IN ('sorting_turn', ?)")
		.bind(RESERVED)
		.run();
});

describe("the sorting turn machine", () => {
	it("walks every state against every event", () => {
		const grid: Record<State, Record<(typeof EVENTS)[number], State | null>> = {
			free: {
				TAKE: "held",
				RETAKE: "held",
				RELEASE: null,
				HOLDS: null,
				EXPIRE: null,
			},
			held: {
				TAKE: null,
				RETAKE: "held",
				RELEASE: "free",
				HOLDS: "held",
				EXPIRE: "expired",
			},
			expired: {
				TAKE: "held",
				RETAKE: "held",
				RELEASE: "free",
				HOLDS: "expired",
				EXPIRE: null,
			},
		};
		expect(Object.keys(grid).sort()).toEqual([...STATES].sort());
		for (const state of STATES)
			for (const event of EVENTS)
				expect(
					next(sortingTurnMachine, state, event),
					`${state} ${event}`,
				).toBe(grid[state]?.[event] ?? null);
		expect(machineGraph(sortingTurnMachine).edges).toHaveLength(10);
	});

	it("has a short word for every state", () => {
		expect(Object.keys(SORTING_TURN_LABELS).sort()).toEqual([...STATES].sort());
	});
});

describe("the sorting turn statements follow the machine", () => {
	it("each stored row reads back as its state, and a turn with no until has run out", async () => {
		for (const state of STATES) {
			await seed(rowFor(state, OTHER));
			expect(await stateNow(), state).toBe(state);
		}
		expect(sortingTurnState({ id: OTHER, until: null }, Date.now())).toBe(
			"expired",
		);
	});

	it("take, by a group that is not the holder, moves a row exactly where the machine says", async () => {
		for (const state of STATES) {
			await seed(rowFor(state, OTHER));
			const took = await takeSortingTurn(db, ME);
			const target = next(sortingTurnMachine, state, "TAKE");
			expect(took, `${state}: take answered`).toBe(target !== null);
			expect(await stateNow(), `${state} after TAKE`).toBe(target ?? state);
			expect((await readSortingTurn(db))?.id, `${state}: holder`).toBe(
				target ? ME : OTHER,
			);
		}
		await seed({ id: OTHER, until: null });
		expect(await takeSortingTurn(db, ME)).toBe(true);
	});

	it("retake, by the holder, moves a row exactly where the machine says, with a fresh until", async () => {
		for (const state of STATES) {
			await seed(rowFor(state, ME));
			const before = Date.now();
			await takeSortingTurn(db, ME);
			expect(await stateNow(), `${state} after RETAKE`).toBe(
				next(sortingTurnMachine, state, "RETAKE") ?? state,
			);
			expect(
				(await readSortingTurn(db))?.until,
				`${state}: until`,
			).toBeGreaterThanOrEqual(before + SORTING_TURN_MS);
		}
	});

	it("release, by the holder, moves a row exactly where the machine says", async () => {
		for (const state of STATES) {
			await seed(rowFor(state, ME));
			await releaseSortingTurn(db, ME);
			expect(await stateNow(), `${state} after RELEASE`).toBe(
				next(sortingTurnMachine, state, "RELEASE") ?? state,
			);
		}
	});

	it("release never gives back another group's turn", async () => {
		for (const state of STATES) {
			const row = rowFor(state, OTHER);
			await seed(row);
			await releaseSortingTurn(db, ME);
			expect(await readSortingTurn(db), state).toEqual(row);
		}
	});

	it("a save's guard passes exactly where the machine says holds, and changes nothing", async () => {
		for (const state of STATES) {
			const row = rowFor(state, ME);
			await seed(row);
			const checked = await db
				.prepare(`SELECT ${turnHeldSql()} AS held`)
				.bind(ME)
				.first<{ held: number }>();
			const target = next(sortingTurnMachine, state, "HOLDS");
			expect(checked?.held === 1, `${state}: guard`).toBe(target !== null);
			expect(await stateNow(), `${state} after HOLDS`).toBe(target ?? state);
			expect(await readSortingTurn(db)).toEqual(row);
		}
	});

	it("a save's guard fails for another group's turn, live or run out", async () => {
		for (const state of ["held", "expired"] as const) {
			await seed(rowFor(state, OTHER));
			const checked = await db
				.prepare(`SELECT ${turnHeldSql()} AS held`)
				.bind(ME)
				.first<{ held: number }>();
			expect(checked?.held, state).toBe(0);
		}
	});

	it("a save's take follows take and retake where the reservation record exists, and takes nothing where it does not", async () => {
		for (const withRecord of [true, false]) {
			for (const [event, holder] of [
				["TAKE", OTHER],
				["RETAKE", ME],
			] as const) {
				for (const state of STATES) {
					const before = rowFor(state, holder);
					await seed(before);
					await db
						.prepare("DELETE FROM household_settings WHERE key = ?")
						.bind(RESERVED)
						.run();
					if (withRecord)
						await db
							.prepare(
								"INSERT INTO household_settings (key, value) VALUES (?, '{}')",
							)
							.bind(RESERVED)
							.run();
					const started = Date.now();
					await takeSortingTurnStatement(db, ME, RESERVED).run();
					const after = await readSortingTurn(db);
					const allowed =
						withRecord && next(sortingTurnMachine, state, event) !== null;
					if (allowed) {
						// Taken: the turn is ours, with a fresh full turn, whoever had it before.
						expect(after?.id, `${state}, ${event}: holder`).toBe(ME);
						expect(
							after?.until,
							`${state}, ${event}: until`,
						).toBeGreaterThanOrEqual(started + SORTING_TURN_MS);
					} else {
						// Refused, or no reservation record: the whole row is exactly as it was.
						expect(
							after,
							`${state}, ${event}, record ${withRecord}: row`,
						).toEqual(before);
					}
					expect(
						await stateNow(),
						`${state}, ${event}, record ${withRecord}`,
					).toBe(
						withRecord
							? (next(sortingTurnMachine, state, event) ?? state)
							: state,
					);
				}
			}
		}
	});

	it("a held turn runs out when its until passes, which is the machine's expire", () => {
		const until = 1_000_000;
		expect(sortingTurnState({ id: OTHER, until }, until - 1)).toBe("held");
		expect(sortingTurnState({ id: OTHER, until }, until + 1)).toBe("expired");
		expect(next(sortingTurnMachine, "held", "EXPIRE")).toBe("expired");
	});
});

describe("a damaged row is a free turn to the statements, as it is to the parser", () => {
	const DAMAGED = [
		"",
		"nope",
		"null",
		"[]",
		'{"until":5}',
		'{"id":3}',
		'{"id":"B","until":"soon"}',
		'{"id":"B","until":true}',
	];

	async function seedRaw(value: string) {
		await db
			.prepare("DELETE FROM household_settings WHERE key = 'sorting_turn'")
			.run();
		await db
			.prepare(
				"INSERT INTO household_settings (key, value) VALUES ('sorting_turn', ?)",
			)
			.bind(value)
			.run();
	}
	const rawNow = async () =>
		(
			await db
				.prepare(
					"SELECT value FROM household_settings WHERE key = 'sorting_turn'",
				)
				.first<{ value: string }>()
		)?.value;

	it("the parser reads each as no turn", () => {
		for (const bad of DAMAGED) expect(parseSortingTurn(bad), bad).toBeNull();
	});

	it("take succeeds where the machine says take from free does, and the row becomes ours", async () => {
		for (const bad of DAMAGED) {
			await seedRaw(bad);
			expect(await takeSortingTurn(db, ME), bad).toBe(
				next(sortingTurnMachine, "free", "TAKE") !== null,
			);
			expect((await readSortingTurn(db))?.id, bad).toBe(ME);
		}
	});

	it("a save's take, with its reservation record, takes it as well", async () => {
		await db
			.prepare(
				"INSERT OR REPLACE INTO household_settings (key, value) VALUES (?, '{}')",
			)
			.bind(RESERVED)
			.run();
		for (const bad of DAMAGED) {
			await seedRaw(bad);
			await takeSortingTurnStatement(db, ME, RESERVED).run();
			expect((await readSortingTurn(db))?.id, bad).toBe(ME);
		}
	});

	it("release and a save's guard find nothing of ours in it, as from free, and leave the row alone", async () => {
		for (const bad of DAMAGED) {
			await seedRaw(bad);
			await releaseSortingTurn(db, ME);
			expect(await rawNow(), `${bad}: release`).toBe(bad);
			const checked = await db
				.prepare(`SELECT ${turnHeldSql()} AS held`)
				.bind(ME)
				.first<{ held: number }>();
			expect(checked?.held, `${bad}: guard`).toBe(0);
			expect(next(sortingTurnMachine, "free", "RELEASE")).toBeNull();
			expect(next(sortingTurnMachine, "free", "HOLDS")).toBeNull();
		}
	});

	it("a good turn held by another group with a number until is still not taken", async () => {
		await seed({ id: OTHER, until: Date.now() + SORTING_TURN_MS });
		expect(await takeSortingTurn(db, ME)).toBe(false);
	});
});

describe("parseSortingTurn", () => {
	it("reads a good row, with or without an until", () => {
		expect(parseSortingTurn('{"id":"a","until":5}')).toEqual({
			id: "a",
			until: 5,
		});
		expect(parseSortingTurn('{"id":"a"}')).toEqual({ id: "a", until: null });
	});

	it("reads a damaged row as no turn", () => {
		for (const bad of [
			"",
			"nope",
			"null",
			"[]",
			'{"until":5}',
			'{"id":3}',
			'{"id":"a","until":"soon"}',
		])
			expect(parseSortingTurn(bad), bad).toBeNull();
	});
});

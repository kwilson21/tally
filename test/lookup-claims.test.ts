import { describe, expect, it } from "vitest";
import type { StoredLookup } from "../src/db/store-lookups";
import {
	claimPick,
	LOOKUP_FAILURES_IN_A_ROW,
	qualifies,
	runStops,
	type SearchOutcome,
	saveMove,
} from "../src/lookup/claims";
import type { Eligibility } from "../src/lookup/eligibility";
import { lookupAsks } from "../src/lookup/gate";
import { LOOKUP_LEASE_MS } from "../src/machines/store-lookup";

// The store lookup's pure decisions (spec §7, "Store lookup"): which store a run claims, whether a search still
// qualifies at its save, what a save writes, and when a run stops. Nothing here touches the database or the network.

const NOW = new Date("2026-11-15T12:00:00.000Z");
const LIVE = new Date(NOW.getTime() - 60_000).toISOString();
const LAPSED = new Date(NOW.getTime() - LOOKUP_LEASE_MS - 60_000).toISOString();
const ME = "run-me";
const TEXT = "store";

type Verdict = "private" | "not_yet" | "may_search" | "none";

const VERDICTS: Verdict[] = ["private", "not_yet", "may_search", "none"];

const verdictOf = (verdict: Verdict): Eligibility | undefined => {
	switch (verdict) {
		case "private":
			return { kind: "private" };
		case "not_yet":
			return { kind: "not_yet", why: "rows", owed: [] };
		case "may_search":
			return { kind: "may_search" };
		case "none":
			return undefined;
	}
};

const stored = (
	fields: Partial<StoredLookup> & Pick<StoredLookup, "status">,
): StoredLookup => ({
	lookupText: TEXT,
	claimedBy: null,
	claimedAt: null,
	attempts: 0,
	...fields,
});

/** What claimPick does for each stored state and verdict: the brief's table. */
type Expect = "skip" | "mine" | "pick" | "none";

const NONE_ALL = {
	private: "none",
	not_yet: "none",
	may_search: "none",
	none: "none",
} satisfies Record<Verdict, Expect>;

/** The eight stored states of a store, each with its row and what claimPick does for each verdict. */
const STATE_CASES = [
	{
		state: "none",
		row: null,
		expect: {
			private: "skip",
			not_yet: "none",
			may_search: "pick",
			none: "none",
		},
	},
	{
		state: "claimed by this token",
		row: stored({ status: "pending", claimedBy: ME, claimedAt: LIVE }),
		expect: {
			private: "mine",
			not_yet: "mine",
			may_search: "mine",
			none: "mine",
		},
	},
	{
		state: "claimed by another, lease live",
		row: stored({ status: "pending", claimedBy: "other-run", claimedAt: LIVE }),
		expect: NONE_ALL,
	},
	{
		state: "to_retry",
		row: stored({ status: "pending", attempts: 1 }),
		expect: {
			private: "skip",
			not_yet: "none",
			may_search: "pick",
			none: "none",
		},
	},
	{
		state: "found",
		row: stored({ status: "found" }),
		expect: {
			private: "skip",
			not_yet: "none",
			may_search: "none",
			none: "none",
		},
	},
	{
		state: "nothing_found",
		row: stored({ status: "nothing_found" }),
		expect: NONE_ALL,
	},
	{ state: "skipped", row: stored({ status: "skipped" }), expect: NONE_ALL },
	{
		state: "gave_up",
		row: stored({ status: "gave_up", attempts: 3 }),
		expect: NONE_ALL,
	},
] satisfies {
	state: string;
	row: StoredLookup | null;
	expect: Record<Verdict, Expect>;
}[];

/** claimPick over one text with one row of transactions, in one stored state and one verdict. */
function pickCell(row: StoredLookup | null, verdict: Verdict) {
	const lookups = new Map<string, StoredLookup>();

	if (row !== null) lookups.set(TEXT, row);

	const decided = new Map<string, Eligibility>();
	const eligibility = verdictOf(verdict);

	if (eligibility !== undefined) decided.set(TEXT, eligibility);

	return claimPick({
		rows: [{ id: 1, lookupText: TEXT }],
		decided,
		lookups,
		token: ME,
		now: NOW,
	});
}

describe("claimPick's table, in full", () => {
	for (const { state, row, expect: table } of STATE_CASES) {
		for (const verdict of VERDICTS) {
			it(`${state} x ${verdict}`, () => {
				const attempts = row?.attempts ?? 0;
				const expected = table[verdict];
				const picked = pickCell(row, verdict);

				if (expected === "skip") {
					expect(picked).toEqual({ skip: [TEXT], pick: null });
				} else if (expected === "pick") {
					expect(picked).toEqual({
						skip: [],
						pick: { text: TEXT, attempts, mine: false },
					});
				} else if (expected === "mine") {
					expect(picked).toEqual({
						skip: [],
						pick: { text: TEXT, attempts, mine: true },
					});
				} else {
					expect(picked).toEqual({ skip: [], pick: null });
				}
			});
		}
	}

	it("another token's claim whose lease is over is a to_retry", () => {
		const lapsed = stored({
			status: "pending",
			claimedBy: "other-run",
			claimedAt: LAPSED,
			attempts: 1,
		});

		expect(pickCell(lapsed, "may_search")).toEqual({
			skip: [],
			pick: { text: TEXT, attempts: 1, mine: false },
		});
		expect(pickCell(lapsed, "private").skip).toEqual([TEXT]);
	});
});

describe("claimPick's order", () => {
	const decided = (...texts: [string, Verdict][]) =>
		new Map<string, Eligibility>(
			texts.flatMap(([text, verdict]): [string, Eligibility][] => {
				const eligibility = verdictOf(verdict);

				return eligibility === undefined ? [] : [[text, eligibility]];
			}),
		);

	it("picks the text of the smallest transaction id, whatever order the rows come in", () => {
		const picked = claimPick({
			rows: [
				{ id: 30, lookupText: "thirty" },
				{ id: 10, lookupText: "ten" },
				{ id: 20, lookupText: "twenty" },
			],
			decided: decided(
				["thirty", "may_search"],
				["ten", "may_search"],
				["twenty", "may_search"],
			),
			lookups: new Map(),
			token: ME,
			now: NOW,
		});

		expect(picked.pick).toEqual({ text: "ten", attempts: 0, mine: false });
	});

	it("uses the smallest id among a text's own rows", () => {
		const picked = claimPick({
			rows: [
				{ id: 40, lookupText: "many" },
				{ id: 7, lookupText: "many" },
				{ id: 10, lookupText: "other" },
			],
			decided: decided(["many", "may_search"], ["other", "may_search"]),
			lookups: new Map(),
			token: ME,
			now: NOW,
		});

		expect(picked.pick?.text).toBe("many");
	});

	it("a claim of this token beats an older candidate", () => {
		const picked = claimPick({
			rows: [
				{ id: 5, lookupText: "older" },
				{ id: 9, lookupText: "mine" },
			],
			decided: decided(["older", "may_search"], ["mine", "may_search"]),
			lookups: new Map([
				[
					"mine",
					stored({
						lookupText: "mine",
						status: "pending",
						claimedBy: ME,
						claimedAt: LIVE,
					}),
				],
			]),
			token: ME,
			now: NOW,
		});

		expect(picked.pick).toEqual({ text: "mine", attempts: 0, mine: true });
	});

	it("a text with no rows is never picked", () => {
		const picked = claimPick({
			rows: [],
			decided: new Map(),
			lookups: new Map([
				[
					"ghost",
					stored({ lookupText: "ghost", status: "pending", attempts: 1 }),
				],
			]),
			token: ME,
			now: NOW,
		});

		expect(picked).toEqual({ skip: [], pick: null });
	});
});

// The gate's env: open only in production (DEMO is "false") with a Tavily key; the demo is closed by its cap.
const ENVS = {
	open: { DEMO: "false", TAVILY_API_KEY: "tvly-test-key" },
	closed: { DEMO: "true", TAVILY_API_KEY: "tvly-test-key" },
};

const SWITCH_SETS = [false, true].flatMap((lookupStores) =>
	[false, true].flatMap((categories) =>
		[false, true].map((income) => ({ lookupStores, categories, income })),
	),
);

describe("qualifies's table", () => {
	for (const [envName, env] of Object.entries(ENVS)) {
		for (const switches of SWITCH_SETS) {
			for (const verdict of VERDICTS) {
				const allOn =
					switches.lookupStores && switches.categories && switches.income;

				const expected =
					envName === "open" && allOn && verdict === "may_search";

				it(`${envName} env, ${JSON.stringify(switches)}, ${verdict}: ${expected}`, () => {
					expect(qualifies(env, switches, verdictOf(verdict))).toBe(expected);
					expect(lookupAsks(env, switches)).toBe(envName === "open" && allOn);
				});
			}
		}
	}
});

const FAILURES = [
	"rate_limited",
	"refused",
	"unreachable",
	"unreadable",
	"line",
] as const;

const OUTCOMES: SearchOutcome[] = [
	{ kind: "found", line: "Coffee shop in Arlington, VA." },
	{ kind: "nothing_found" },
	...FAILURES.map((failure) => ({ kind: "failed" as const, failure })),
	{ kind: "check-refused" },
	{ kind: "claim-lost" },
	{ kind: "date-changed" },
	{ kind: "lost" },
];

describe("saveMove's table", () => {
	for (const outcome of OUTCOMES) {
		for (const qualifiesNow of [true, false]) {
			for (const attempts of [0, 1, 2]) {
				const label =
					outcome.kind === "failed"
						? `failed (${outcome.failure})`
						: outcome.kind;

				it(`${label}, qualifies ${qualifiesNow}, attempts ${attempts}`, () => {
					const move = saveMove(outcome, qualifiesNow, attempts);

					if (outcome.kind === "found") {
						expect(move).toEqual(
							qualifiesNow
								? { kind: "result", status: "found", line: outcome.line }
								: null,
						);
					} else if (outcome.kind === "nothing_found") {
						expect(move).toEqual(
							qualifiesNow
								? { kind: "result", status: "nothing_found", line: null }
								: null,
						);
					} else if (outcome.kind === "failed") {
						// A failure is counted whatever the switches say; the third in a row gives up.
						expect(move).toEqual({
							kind: "failure",
							status:
								attempts + 1 < LOOKUP_FAILURES_IN_A_ROW ? "pending" : "gave_up",
							attemptsBefore: attempts,
						});
					} else {
						expect(move).toBeNull();
					}
				});
			}
		}
	}
});

describe("runStops's table", () => {
	const failed = (failure: (typeof FAILURES)[number]): SearchOutcome => ({
		kind: "failed",
		failure,
	});

	const checkRefused: SearchOutcome = { kind: "check-refused" };

	const found: SearchOutcome = {
		kind: "found",
		line: "Bakery in Arlington, VA.",
	};

	const nothing: SearchOutcome = { kind: "nothing_found" };
	const unreachable = failed("unreachable");

	const cases: [string, SearchOutcome[], boolean][] = [
		["[failed x3] stops", [unreachable, unreachable, unreachable], true],
		[
			"[failed, check-refused, failed, failed] stops",
			[unreachable, checkRefused, unreachable, unreachable],
			true,
		],
		[
			"[failed, failed, found, failed, failed] goes on",
			[unreachable, unreachable, found, unreachable, unreachable],
			false,
		],
		["[failed rate_limited] stops", [failed("rate_limited")], true],
		[
			"[failed refused x3] stops (a bad key)",
			[failed("refused"), failed("refused"), failed("refused")],
			true,
		],
		["[lost] stops", [{ kind: "lost" }], true],
		["[date-changed] stops", [{ kind: "date-changed" }], true],
		["[claim-lost] stops", [{ kind: "claim-lost" }], true],
		[
			"[check-refused x5] goes on",
			[checkRefused, checkRefused, checkRefused, checkRefused, checkRefused],
			false,
		],
		[
			"[nothing_found, failed, failed] goes on",
			[nothing, unreachable, unreachable],
			false,
		],
	];

	it.each(cases)("%s", (_name, outcomes, stops) => {
		expect(runStops(outcomes)).toBe(stops);
	});
});

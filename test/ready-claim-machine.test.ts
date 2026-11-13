import { describe, expect, it } from "vitest";
import { next } from "../src/machines/next";
import {
	READY_LEASE_MINUTES,
	type ReadyEntry,
	type ReadyState,
	readyClaimMachine,
	readyStateOf,
} from "../src/machines/ready-claim";

// The ready email's claim for one address (issue #863, second half): four states, derived from the stored record. The
// tests walk the machine's own moves, then readyStateOf on both sides of the lease. The SQL writers are tested in
// test/ready-email.test.ts, where the same record is read back after each one.

const EVENTS = ["CLAIM", "DELIVERED", "HELD", "FAILED", "RECOVER", "DROP_OLD"];

const STATES = ["waiting", "sending", "in_doubt", "reached"] as const;

/** Every move the machine makes, as [from, event, to]. Any other state and event pair is refused. */
const MOVES = [
	["waiting", "CLAIM", "sending"],
	["sending", "DELIVERED", "reached"],
	["sending", "HELD", "waiting"],
	["sending", "FAILED", "waiting"],
	["sending", "DROP_OLD", "reached"],
	["in_doubt", "RECOVER", "sending"],
	["in_doubt", "DROP_OLD", "reached"],
] as const;

describe("the ready claim machine", () => {
	it("starts waiting", () => {
		expect(readyClaimMachine.config.initial).toBe("waiting");
	});

	it.each(STATES)("%s takes exactly the events its moves list", (state) => {
		for (const event of EVENTS) {
			const move = MOVES.find(([from, on]) => from === state && on === event);

			expect(next(readyClaimMachine, state, event)).toBe(move?.[2] ?? null);
		}
	});

	it("CLAIM takes a waiting address to sending, and a sending or reached one refuses it", () => {
		expect(next(readyClaimMachine, "waiting", "CLAIM")).toBe("sending");
		expect(next(readyClaimMachine, "sending", "CLAIM")).toBeNull();
		expect(next(readyClaimMachine, "in_doubt", "CLAIM")).toBeNull();
		expect(next(readyClaimMachine, "reached", "CLAIM")).toBeNull();
	});

	it("DELIVERED ends a sending address as reached, for good", () => {
		expect(next(readyClaimMachine, "sending", "DELIVERED")).toBe("reached");

		for (const event of EVENTS) {
			expect(next(readyClaimMachine, "reached", event)).toBeNull();
		}
	});

	it("HELD and FAILED give a sending address back to waiting (a held try keeps its email, a failure keeps nothing)", () => {
		expect(next(readyClaimMachine, "sending", "HELD")).toBe("waiting");
		expect(next(readyClaimMachine, "sending", "FAILED")).toBe("waiting");
	});

	it("RECOVER takes an in-doubt address to sending, and nothing else but DROP_OLD leaves in-doubt", () => {
		expect(next(readyClaimMachine, "in_doubt", "RECOVER")).toBe("sending");
		expect(next(readyClaimMachine, "in_doubt", "DELIVERED")).toBeNull();
		expect(next(readyClaimMachine, "in_doubt", "HELD")).toBeNull();
		expect(next(readyClaimMachine, "in_doubt", "FAILED")).toBeNull();
	});

	it("DROP_OLD ends a kept try that is too old as reached, from sending (after a claim) and from in-doubt (after a cut-off)", () => {
		expect(next(readyClaimMachine, "sending", "DROP_OLD")).toBe("reached");
		expect(next(readyClaimMachine, "in_doubt", "DROP_OLD")).toBe("reached");
	});

	it("a waiting address refuses every event but CLAIM", () => {
		for (const event of EVENTS.filter((e) => e !== "CLAIM")) {
			expect(next(readyClaimMachine, "waiting", event)).toBeNull();
		}
	});

	it("throws for a state the machine does not have, rather than answering not allowed", () => {
		expect(() => next(readyClaimMachine, "emailed", "CLAIM")).toThrow(
			/Unknown state/,
		);
	});
});

describe("readyStateOf", () => {
	const NOW = Date.parse("2026-11-13T12:00:00Z");

	/** The stamp `minutes` before NOW, as the SQL writes it: UTC to the second, `YYYY-MM-DDTHH:MM:SSZ`. */
	const stampBefore = (seconds: number) =>
		`${new Date(NOW - seconds * 1000).toISOString().slice(0, 19)}Z`;

	const LEASE_SECONDS = READY_LEASE_MINUTES * 60;

	const entry = (over: Partial<ReadyEntry> = {}): ReadyEntry => ({
		emailed: true,
		claimedAt: stampBefore(0),
		kept: true,
		...over,
	});

	it("is waiting for an address not in the list, whatever else is stored", () => {
		expect(
			readyStateOf(
				entry({ emailed: false, claimedAt: null, kept: false }),
				NOW,
			),
		).toBe("waiting");
		expect(
			readyStateOf(entry({ emailed: false, claimedAt: null, kept: true }), NOW),
		).toBe("waiting");
	});

	it("is reached for a listed address with no stamp, kept or not (finished, or claimed before this change)", () => {
		expect(readyStateOf(entry({ claimedAt: null, kept: false }), NOW)).toBe(
			"reached",
		);
		expect(readyStateOf(entry({ claimedAt: null, kept: true }), NOW)).toBe(
			"reached",
		);
	});

	it("is sending while the stamp is under 10 minutes old, the kept try or not", () => {
		expect(
			readyStateOf(entry({ claimedAt: stampBefore(0), kept: true }), NOW),
		).toBe("sending");
		expect(
			readyStateOf(
				entry({ claimedAt: stampBefore(LEASE_SECONDS - 1), kept: true }),
				NOW,
			),
		).toBe("sending");
		expect(
			readyStateOf(
				entry({ claimedAt: stampBefore(LEASE_SECONDS - 1), kept: false }),
				NOW,
			),
		).toBe("sending");
	});

	it("is in doubt at exactly 10 minutes and after, with a kept try stored", () => {
		expect(
			readyStateOf(
				entry({ claimedAt: stampBefore(LEASE_SECONDS), kept: true }),
				NOW,
			),
		).toBe("in_doubt");
		expect(
			readyStateOf(entry({ claimedAt: stampBefore(11 * 60), kept: true }), NOW),
		).toBe("in_doubt");
	});

	it("is reached after 10 minutes with no kept try: there is nothing to send again", () => {
		expect(
			readyStateOf(
				entry({ claimedAt: stampBefore(11 * 60), kept: false }),
				NOW,
			),
		).toBe("reached");
	});

	it("reads an unreadable stamp as sending, so nothing is sent on a stamp it cannot read", () => {
		expect(
			readyStateOf(entry({ claimedAt: "last Tuesday", kept: true }), NOW),
		).toBe("sending");
	});

	it("reads a stamp ending in Z as UTC, without adding a second Z", () => {
		// Ten minutes exactly in UTC: a reading that added an offset would move this across the boundary.
		const state: ReadyState = readyStateOf(
			entry({ claimedAt: "2026-11-13T11:50:00Z", kept: true }),
			NOW,
		);

		expect(state).toBe("in_doubt");
	});
});

import { describe, expect, it } from "vitest";
import { setup } from "xstate";
import { next } from "../src/machines/next";

// A small machine with one state that handles only some events, one final state,
// and a self-loop. Its only job is to exercise the helper's rules.
const doorMachine = setup({}).createMachine({
	id: "door",
	initial: "closed",
	states: {
		closed: {
			on: {
				OPEN: { target: "open" },
				PING: { target: "closed" },
			},
		},
		open: {
			on: {
				CLOSE: { target: "closed" },
				PING: { target: "open" },
			},
		},
		locked: {
			type: "final",
		},
	},
});

describe("next (machine helper)", () => {
	it("moves to the target state on a legal event", () => {
		expect(next(doorMachine, "closed", "OPEN")).toBe("open");
	});

	it("stays in the same state on a self-loop", () => {
		expect(next(doorMachine, "open", "PING")).toBe("open");
	});

	it("returns null for an event the machine does not know", () => {
		expect(next(doorMachine, "closed", "EXPLODE")).toBeNull();
	});

	it("returns null for an event that another state handles but this one does not", () => {
		// CLOSE is handled in "open", not in "closed".
		expect(next(doorMachine, "closed", "CLOSE")).toBeNull();
	});

	it("returns null for every event from a terminal (final) state", () => {
		for (const event of ["OPEN", "CLOSE", "PING"]) {
			expect(next(doorMachine, "locked", event)).toBeNull();
		}
	});

	it("throws a clear error for a state string the machine does not have", () => {
		expect(() => next(doorMachine, "ajar", "OPEN")).toThrow(
			'Unknown state "ajar" for machine "door"',
		);
	});
});

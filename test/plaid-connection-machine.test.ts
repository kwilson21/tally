import { describe, expect, it } from "vitest";
import { next } from "../src/machines/next";
import { plaidConnectionMachine } from "../src/machines/plaid-connection";

// Every state x event pair, walked against the machine. A legal pair names where it goes; every other pair is refused.
const STATES = [
	"ok",
	"login_broken",
	"needs_relink",
	"login_broken_and_needs_relink",
	"disconnected",
] as const;

const EVENTS = [
	"LOGIN_BROKEN",
	"RELINK_NEEDED",
	"SYNC_SUCCEEDED",
	"RELINKED",
	"DISCONNECT",
] as const;

const LEGAL: Partial<Record<string, Partial<Record<string, string>>>> = {
	ok: {
		LOGIN_BROKEN: "login_broken",
		RELINK_NEEDED: "needs_relink",
		SYNC_SUCCEEDED: "ok",
		RELINKED: "ok",
		DISCONNECT: "disconnected",
	},
	login_broken: {
		LOGIN_BROKEN: "login_broken",
		RELINK_NEEDED: "login_broken_and_needs_relink",
		// A good sync clears a login problem, and nothing else.
		SYNC_SUCCEEDED: "ok",
		RELINKED: "ok",
		DISCONNECT: "disconnected",
	},
	needs_relink: {
		LOGIN_BROKEN: "login_broken_and_needs_relink",
		RELINK_NEEDED: "needs_relink",
		// A good sync does not clear a relink-needed flag: only a relink does.
		SYNC_SUCCEEDED: "needs_relink",
		RELINKED: "ok",
		DISCONNECT: "disconnected",
	},
	login_broken_and_needs_relink: {
		LOGIN_BROKEN: "login_broken_and_needs_relink",
		RELINK_NEEDED: "login_broken_and_needs_relink",
		SYNC_SUCCEEDED: "needs_relink",
		RELINKED: "ok",
		DISCONNECT: "disconnected",
	},
	// Final: nothing moves a disconnected bank.
	disconnected: {},
};

describe("plaid connection machine", () => {
	for (const state of STATES) {
		for (const event of EVENTS) {
			const expected = LEGAL[state]?.[event] ?? null;
			it(`${state} + ${event} -> ${expected ?? "refused"}`, () => {
				expect(next(plaidConnectionMachine, state, event)).toBe(expected);
			});
		}
	}

	it("has exactly the five states, with disconnected final", () => {
		const states = plaidConnectionMachine.config.states ?? {};
		expect(Object.keys(states).sort()).toEqual([...STATES].sort());
		expect(states.disconnected).toMatchObject({ type: "final" });
	});
});
